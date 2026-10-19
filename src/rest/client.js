import { AuthError, SnowgateError, TableAccessError } from '../errors.js';
import { normalizeInstance } from '../instance.js';
import { TABLES } from './tables.js';

// Read-only ServiceNow Table API client. Every request goes through #get, which
// hard-codes the GET method; there is no generic request method and no write
// verb anywhere in this module (a test asserts this structurally).
//
// Authentication (PF-0010), `mode`:
//   basic   — Authorization: Basic with the configured credentials;
//   session — the gateway's signed-in browser session (cookies + the UI's
//             X-UserToken), via `sessionFetch`; no password is sent;
//   auto    — Basic first; on HTTP 401 switch to the session for good. Some
//             instances refuse Basic auth on REST even for a valid password.
export class ReadOnlyClient {
  #instance;
  #auth;
  #fetch;
  #sessionFetch;
  #mode;
  #pageSize;
  #maxRecords;

  constructor({ instance, user, password, fetchImpl = globalThis.fetch, sessionFetch = null, mode = 'basic', pageSize = 500, maxRecords = 10000, pattern }) {
    this.#instance = normalizeInstance(instance, pattern);
    if (!['basic', 'session', 'auto'].includes(mode)) throw new SnowgateError(`Unknown rest_auth "${mode}" (auto, basic or session).`, 'CONFIG_INVALID');
    const hasCredentials = Boolean(user && password);
    if (mode !== 'basic' && !sessionFetch) throw new SnowgateError(`rest_auth ${mode} needs a browser session.`, 'NO_SESSION');
    if (mode === 'basic' && !hasCredentials) {
      throw new SnowgateError('ServiceNow credentials are missing.', 'NO_CREDENTIALS');
    }
    if (user && /[\^=\s]/.test(user)) {
      throw new SnowgateError('SN_USER contains characters that cannot be used safely in an encoded query.', 'CREDENTIALS_INVALID');
    }
    this.#auth = hasCredentials ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : null;
    this.user = user ?? null;
    this.#fetch = fetchImpl;
    this.#sessionFetch = sessionFetch;
    // auto without credentials has nothing to try first.
    this.#mode = mode === 'auto' && !hasCredentials ? 'session' : mode;
    this.#pageSize = pageSize;
    this.#maxRecords = maxRecords;
  }

  // How the client is authenticating now: basic or session.
  get authMode() {
    return this.#mode === 'auto' ? 'basic' : this.#mode;
  }

  get instance() {
    return this.#instance;
  }

  recordUrl(table, sysId) {
    return `https://${this.#instance}/${table}.do?sys_id=${encodeURIComponent(sysId)}`;
  }

  // Allow-listed table, explicit allow-listed fields, encoded query.
  async query(table, { fields, query = '', limit } = {}) {
    const allowed = TABLES[table];
    if (!allowed) throw new SnowgateError(`Table "${table}" is not on the read-only configuration allowlist.`, 'TABLE_NOT_ALLOWED');
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new SnowgateError(`fields is mandatory for ${table}; snowgate never selects all columns.`, 'FIELDS_REQUIRED');
    }
    const denied = fields.filter((f) => !allowed.includes(f));
    if (denied.length) {
      throw new SnowgateError(`Field(s) ${denied.join(', ')} are not allowed on ${table}. Allowed: ${allowed.join(', ')}.`, 'FIELD_NOT_ALLOWED');
    }
    return this.#collect(table, fields, query, Math.min(limit ?? this.#maxRecords, this.#maxRecords));
  }

  async getRecord(table, sysId, fields) {
    if (!/^[0-9a-f]{32}$/.test(sysId ?? '')) throw new SnowgateError(`"${sysId}" is not a sys_id.`, 'SYS_ID_INVALID');
    const result = await this.query(table, { fields, query: `sys_id=${sysId}`, limit: 1 });
    return { record: result.records[0] ?? null, evidence: { ...result.evidence, record_url: this.recordUrl(table, sysId) } };
  }

  // Fixed-shape preflight reads. They touch sys_user / sys_user_has_role /
  // sys_properties, which are NOT on the general allowlist: only these exact
  // queries and columns are possible.
  // In session mode the signed-in user may be an SSO identity snowgate never
  // saw, so the record is found with the instance's own current-user ID.
  async whoami() {
    const query = this.authMode === 'session' || !this.user ? 'sys_id=javascript:gs.getUserID()' : `user_name=${this.user}`;
    const result = await this.#collect('sys_user', ['sys_id', 'user_name'], query, 1);
    const me = result.records[0];
    if (!me) throw new AuthError(`Authenticated, but no sys_user record is readable for "${this.user ?? 'the signed-in user'}".`);
    return { sys_id: me.sys_id, user_name: me.user_name, evidence: result.evidence };
  }

  async roles(userSysId) {
    if (!/^[0-9a-f]{32}$/.test(userSysId ?? '')) throw new SnowgateError(`"${userSysId}" is not a sys_id.`, 'SYS_ID_INVALID');
    const result = await this.#collect('sys_user_has_role', ['role.name'], `user=${userSysId}^state=active`, this.#maxRecords);
    const roles = [...new Set(result.records.map((r) => r['role.name']).filter(Boolean))].sort();
    return { roles, evidence: result.evidence };
  }

  async version() {
    const names = ['glide.buildtag', 'glide.buildname', 'glide.war'];
    const result = await this.#collect('sys_properties', ['name', 'value'], `nameIN${names.join(',')}`, names.length);
    const props = Object.fromEntries(result.records.map((r) => [r.name, r.value]));
    return { properties: props, evidence: result.evidence };
  }

  async #collect(table, fields, query, limit) {
    const records = [];
    let truncated = false;
    let evidenceUrl;
    for (let offset = 0; ; offset += this.#pageSize) {
      const url = new URL(`https://${this.#instance}/api/now/table/${encodeURIComponent(table)}`);
      url.searchParams.set('sysparm_fields', fields.join(','));
      if (query) url.searchParams.set('sysparm_query', query);
      url.searchParams.set('sysparm_exclude_reference_link', 'true');
      url.searchParams.set('sysparm_display_value', 'false');
      url.searchParams.set('sysparm_limit', String(Math.min(this.#pageSize, limit - records.length)));
      evidenceUrl ??= url.toString();
      url.searchParams.set('sysparm_offset', String(offset));

      const page = await this.#get(table, url);
      records.push(...page);
      if (records.length >= limit) {
        // Hitting the safety cap means the result may be incomplete.
        truncated = limit === this.#maxRecords;
        break;
      }
      if (page.length < this.#pageSize) break;
    }
    return {
      records,
      evidence: { table, query, fields, url: evidenceUrl, count: records.length, truncated, retrieved_at: new Date().toISOString() },
    };
  }

  #send(url) {
    if (this.#mode === 'session') return this.#sessionFetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    return this.#fetch(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: this.#auth } });
  }

  async #get(table, url) {
    let res;
    try {
      res = await this.#send(url);
      if (res.status === 401 && this.#mode === 'auto') {
        this.#mode = 'session';
        res = await this.#send(url);
      }
    } catch (err) {
      // Session problems (expired, missing) keep their own code.
      if (err instanceof SnowgateError) throw err;
      throw new SnowgateError(`Could not reach ${this.#instance}: ${err.message}`, 'NETWORK');
    }
    if (res.status === 401) throw new AuthError(`Authentication to ${this.#instance} failed (HTTP 401).`);
    if (!res.ok) {
      const reason = res.status === 403 ? 'access denied' : res.status === 404 || res.status === 400 ? 'table not found or not readable' : 'request failed';
      throw new TableAccessError(table, res.status, `${table}: ${reason} (HTTP ${res.status}).`);
    }
    const body = await res.json();
    if (!Array.isArray(body?.result)) throw new TableAccessError(table, res.status, `${table}: unexpected response shape.`);
    return body.result;
  }
}
