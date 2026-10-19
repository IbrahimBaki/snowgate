import { SnowgateError } from '../errors.js';

// Open read model (PF-0015). With `data: all` (default) any table and field on
// the confirmed target is readable, except sensitive data. The instance's own
// sys_db_object / sys_dictionary are the reference for what exists, how a
// table inherits, and each field's type — nothing is guessed.
//   data: all     — every table except sensitive tables/fields
//   data: listed  — configuration (sys_metadata descendants) + data_tables
//   data: none    — configuration only
export const SENSITIVE_TYPES = new Set(['password', 'password2']);
export const SENSITIVE_NAME = /(^|_)(pass|passwd|password|secret|token|credentials?|private_?key|api_?key|client_secret|session(_id)?)(_|$)/i;
const SENSITIVE_TABLE = /(^|_)(sessions?|tokens?|credentials?|secrets?|passwords?)(_|$)|^sys_attachment_doc$/i;
const TABLE_NAME = /^[a-z0-9_]{1,80}$/;
const MAX_CHAIN = 12;
const MAX_WALK = 4;

const fail = (message, code, details) => Object.assign(new SnowgateError(message, code), { details });

// Agent-supplied encoded queries: never server-side script, never a filter on
// a sensitive field (a filter can reveal a value one guess at a time).
export function checkQuery(query) {
  if (!query) return;
  if (/javascript\s*:/i.test(query)) throw fail('Encoded queries may not contain javascript: (server-side code).', 'QUERY_NOT_ALLOWED');
  // Field names are lowercase and operators uppercase (user_passwordSTARTSWITHa),
  // so lowercase runs are the names (and values, which may over-match).
  for (const word of query.match(/[a-z0-9_]+(?:\.[a-z0-9_]+)*/g) ?? []) {
    if (word.split('.').some((part) => SENSITIVE_NAME.test(part))) {
      throw fail(`The query filters on "${word}", which looks sensitive; snowgate does not filter on secrets.`, 'QUERY_SENSITIVE');
    }
  }
}

export class ReadPolicy {
  #raw;
  #mode;
  #dataTables;
  #chains = new Map();
  #fields = new Map();

  // raw(table, fields, query, limit) reads metadata without this policy.
  constructor({ data = 'all', data_tables: dataTables = [] } = {}, raw) {
    if (!['all', 'listed', 'none'].includes(data)) throw new SnowgateError(`Unknown data mode "${data}" (all, listed or none).`, 'CONFIG_INVALID');
    this.#mode = data;
    this.#dataTables = new Set(dataTables);
    this.#raw = raw;
  }

  get mode() {
    return this.#mode;
  }

  async #chain(table) {
    if (this.#chains.has(table)) return this.#chains.get(table);
    const chain = [];
    let current = table;
    while (current && chain.length < MAX_CHAIN) {
      const res = await this.#raw('sys_db_object', ['name', 'super_class.name'], `name=${current}`, 1);
      const row = res.records[0];
      if (!row) break;
      chain.push(row.name);
      current = row['super_class.name'];
    }
    this.#chains.set(table, chain);
    return chain;
  }

  // element -> { type, reference } for the table and everything it inherits.
  async #fieldsOf(table) {
    if (this.#fields.has(table)) return this.#fields.get(table);
    const chain = await this.#chain(table);
    const map = new Map();
    if (chain.length) {
      const res = await this.#raw('sys_dictionary', ['name', 'element', 'internal_type', 'reference'], `nameIN${chain.join(',')}^elementISNOTEMPTY`, 10000);
      // Nearer tables win over their ancestors.
      const rank = new Map(chain.map((t, i) => [t, i]));
      for (const r of res.records.sort((a, b) => rank.get(b.name) - rank.get(a.name))) {
        map.set(r.element, { type: r.internal_type, reference: r.reference || null });
      }
    }
    this.#fields.set(table, map);
    return map;
  }

  async #checkTable(table) {
    if (!TABLE_NAME.test(table ?? '')) throw fail(`"${table}" is not a table name.`, 'TABLE_INVALID', { table });
    if (SENSITIVE_TABLE.test(table)) throw fail(`${table} holds sessions, tokens, credentials or file contents; snowgate never reads it.`, 'TABLE_SENSITIVE', { table });
    const chain = await this.#chain(table);
    if (!chain.length) throw fail(`No table "${table}" on this instance.`, 'TABLE_UNKNOWN', { table });
    const configuration = chain.includes('sys_metadata');
    if (!configuration && this.#mode === 'none') {
      throw fail(`${table} holds data, and this project allows configuration tables only (data: none in .snowgate/config.yaml).`, 'DATA_NOT_ALLOWED', { table });
    }
    if (!configuration && this.#mode === 'listed' && !this.#dataTables.has(table)) {
      throw fail(`${table} holds data and is not in data_tables in .snowgate/config.yaml (data: listed).`, 'DATA_NOT_ALLOWED', { table });
    }
  }

  async check(table, fields, query) {
    await this.#checkTable(table);
    checkQuery(query);
    for (const field of fields) {
      const parts = field.split('.');
      if (parts.length > MAX_WALK) throw fail(`${field}: dot-walks are limited to ${MAX_WALK} levels.`, 'FIELD_INVALID', { table, fields: [field] });
      let current = table;
      for (const [i, part] of parts.entries()) {
        if (SENSITIVE_NAME.test(part)) throw fail(`${table}.${field} looks sensitive; snowgate never reads it.`, 'FIELD_SENSITIVE', { table, fields: [field] });
        const known = (await this.#fieldsOf(current)).get(part);
        if (!known && part !== 'sys_id') {
          throw fail(`${current} has no field "${part}". Look fields up with sn_query on sys_dictionary (name=${current}).`, 'FIELD_UNKNOWN', { table, fields: [field] });
        }
        if (known && SENSITIVE_TYPES.has(known.type)) throw fail(`${current}.${part} is a ${known.type} field; snowgate never reads it.`, 'FIELD_SENSITIVE', { table, fields: [field] });
        if (i < parts.length - 1) {
          if (!known?.reference || /^[0-9a-f]{32}$/.test(known.reference)) throw fail(`${current}.${part} is not a reference that can be dot-walked.`, 'FIELD_INVALID', { table, fields: [field] });
          current = known.reference;
          await this.#checkTable(current);
        }
      }
    }
  }
}
