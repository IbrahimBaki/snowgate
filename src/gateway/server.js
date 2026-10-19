import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'yaml';
import { appendAudit } from '../audit.js';
import { profileDir } from '../browser-profile.js';
import { loadConfig } from '../config.js';
import { missingCredentialsHint, resolveCredentials } from '../credentials.js';
import { SnowgateError } from '../errors.js';
import { gapsFromError, recordGap } from '../feedback.js';
import { BrowserSession } from '../playwright/session.js';
import { ReadOnlyClient } from '../rest/client.js';
import { requireConfirmedTarget } from '../work.js';
import { requireWorkItem } from '../workspace.js';
import { HANDLERS, TOOLS } from './tools.js';

// snowgate mcp — the enforcement point for every agent (PLAN §7). Guards live
// here, not in agent hooks: work resolution, confirmed target, URL locks,
// approval gates, and the audit trail.

// D5: explicit --work / SNOWGATE_WORK, else YallaFlow's active work item.
export function resolveWorkId(root, explicit) {
  if (explicit) return explicit;
  for (const rel of ['.yallaflow/local/state/current.yaml', '.yallaflow/state/current.yaml']) {
    const file = path.join(root, rel);
    if (!existsSync(file)) continue;
    try {
      const active = parse(readFileSync(file, 'utf8'))?.activeWork;
      if (active) return String(active);
    } catch {
      // unreadable state: treat as no active work
    }
  }
  return null;
}

const SECRET_KEY = /pass|secret|token|cookie|authorization|credential/i;

// Credentials never reach the audit trail: secret-looking keys are dropped and
// known secret values are masked wherever they appear.
export function redact(value, secrets = []) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  const walk = (v) => {
    if (typeof v === 'string') return known.reduce((acc, s) => acc.split(s).join('<redacted>'), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '<redacted>' : walk(x)]));
    }
    return v;
  };
  return walk(value);
}

function checkArgs(tool, args) {
  const schema = tool.inputSchema;
  const problems = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  for (const key of schema.required ?? []) if (args[key] === undefined) problems.push(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) {
      problems.push(`${key} is not a parameter of ${tool.name}`);
      continue;
    }
    const type = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = prop.type === type || (prop.type === 'number' && type === 'integer');
    if (!ok) problems.push(`${key} must be ${prop.type}`);
    else if (prop.pattern && !new RegExp(prop.pattern).test(value)) problems.push(`${key} does not match ${prop.pattern}`);
    else if (prop.type === 'array' && (value.length < (prop.minItems ?? 0) || value.some((x) => typeof x !== prop.items.type))) problems.push(`${key} must be a non-empty list of ${prop.items.type}`);
    else if (prop.type === 'integer' && ((prop.minimum !== undefined && value < prop.minimum) || (prop.maximum !== undefined && value > prop.maximum))) problems.push(`${key} is out of range`);
  }
  return problems;
}

// Factories are injectable so tests can point the gateway at local fixtures;
// the CLI always uses the real https://<instance> origin.
export function createGateway({
  root,
  workId: explicitWork,
  pack,
  env = process.env,
  clientFactory = (opts) => new ReadOnlyClient(opts),
  sessionFactory = (opts) => new BrowserSession(opts),
  originFor = (instance) => `https://${instance}`,
  now = () => new Date(),
}) {
  // Known secret values to mask; credentials are added once resolved.
  const secrets = [];
  let client = null;
  let session = null;
  let boundInstance = null;
  let queue = Promise.resolve();

  async function bind(instance) {
    if (boundInstance === instance) return;
    await session?.close();
    client = null;
    session = null;
    boundInstance = instance;
  }

  async function call(name, args = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    const workId = resolveWorkId(root, explicitWork);
    const audit = (entry) => {
      try {
        appendAudit(root, workId && /^PF-/.test(workId) ? workId : '_gateway', { tool: name, args: redact(args, secrets), ...entry }, now());
      } catch {
        // auditing must never mask the tool result
      }
    };
    try {
      // Environment and project-store secrets are known before any target.
      const early = resolveCredentials(root, null, { pack, env });
      if (early.password && !secrets.includes(early.password)) secrets.push(early.password);
    } catch {
      // a broken store surfaces when a tool needs credentials
    }
    try {
      if (!tool) throw new SnowgateError(`Unknown tool ${name}.`, 'TOOL_UNKNOWN');
      const problems = checkArgs(tool, args);
      if (problems.length) throw new SnowgateError(`Invalid arguments for ${name}: ${problems.join('; ')}.`, 'ARGS_INVALID');
      // Reporting a gap touches no instance, so it needs no work item or target.
      if (tool.kind === 'local') {
        const result = await HANDLERS[name]({ root, now }, args);
        audit({ ok: true });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (!workId) {
        throw new SnowgateError('No work item: start snowgate mcp with --work <PF-id> (or SNOWGATE_WORK), or make one active in YallaFlow.', 'TARGET_UNCONFIRMED');
      }
      requireWorkItem(root, workId);
      const instance = requireConfirmedTarget(root, workId);
      await bind(instance);
      const credentials = () => {
        const c = resolveCredentials(root, instance, { pack, env });
        if (c.password && !secrets.includes(c.password)) secrets.push(c.password);
        return c;
      };
      // Learn the secret values before anything is audited, even for tools
      // that never use them, so an argument that contains one is masked.
      try {
        credentials();
      } catch {
        // an unreadable store surfaces when a tool actually needs credentials
      }
      const ctx = {
        root,
        workId,
        instance,
        now,
        client: () => {
          if (client) return client;
          const c = credentials();
          const mode = loadConfig(root).rest_auth;
          if (mode === 'basic' && (!c.user || !c.password)) throw new SnowgateError(missingCredentialsHint(root, instance, workId, pack), 'NO_CREDENTIALS');
          const cfg = loadConfig(root);
          return (client = clientFactory({
            instance,
            user: c.user,
            password: c.password,
            mode,
            readPolicy: { data: cfg.data, data_tables: cfg.data_tables },
            sessionFetch: (url, init) => ctx.session().restFetch(url, init),
            pattern: pack.instancePattern,
          }));
        },
        session: () => {
          if (session) return session;
          const auth = loadConfig(root).ui_auth;
          const c = auth === 'password' ? credentials() : {};
          return (session = sessionFactory({
            origin: originFor(instance),
            auth,
            profileDir: profileDir(instance, env),
            user: c.user,
            password: c.password,
            missingHint: missingCredentialsHint(root, instance, workId, pack),
          }));
        },
      };
      const result = await HANDLERS[name](ctx, args);
      audit({ target: instance, ok: true });
      return { content: [{ type: 'text', text: JSON.stringify(redact(result, secrets), null, 2) }] };
    } catch (e) {
      if (!(e instanceof SnowgateError)) {
        audit({ ok: false, code: 'INTERNAL', error: redact(e.message, secrets) });
        return { isError: true, content: [{ type: 'text', text: `snowgate: internal error: ${redact(e.message, secrets)}` }] };
      }
      audit({ ok: false, code: e.code, error: redact(e.message, secrets) });
      // Capability gaps (refused fields/tables, unreadable tables, unknown
      // tools) are kept, redacted, for `snowgate feedback send`.
      try {
        for (const gap of gapsFromError(e, { tool: name })) recordGap(root, gap, now());
      } catch {
        // feedback must never mask the tool result
      }
      return { isError: true, content: [{ type: 'text', text: `snowgate [${e.code}]: ${redact(e.message, secrets)}` }] };
    }
  }

  // Tool calls are serialised: the URL lock's unlocked window must never be
  // shared with a concurrent generic UI call.
  const serialised = (name, args) => {
    const run = queue.then(() => call(name, args));
    queue = run.catch(() => {});
    return run;
  };

  const server = new Server({ name: 'snowgate', version: pack.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => serialised(req.params.name, req.params.arguments ?? {}));

  return {
    server,
    call: serialised,
    close: async () => {
      await session?.close();
      await server.close();
    },
  };
}
