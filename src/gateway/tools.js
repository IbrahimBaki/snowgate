import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { requireApproval } from '../approvals.js';
import { SnowgateError } from '../errors.js';
import { commitUpdateSet, findRemoteUpdateSet, previewProblems, previewUpdateSet, updateSetName, uploadUpdateSet } from '../playwright/update-sets.js';
import { recordGap } from '../feedback.js';
import { portalPage } from '../portal-page.js';
import { readPackage, stateAtLeast, validatePackages } from '../validate/packages.js';
import { snowgateDir } from '../workspace.js';
import { resolveTargetUrl } from './guards.js';

// The gateway's tool surface (PLAN §7.2). This list IS the allowlist: nothing
// else is exposed — no tabs, history, key presses, evaluate/run_code, generic
// file upload, REST writes, delete, back out, or current-update-set switching.

const SYS_ID = { type: 'string', pattern: '^[0-9a-f]{32}$' };
const FIELDS = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Explicit column list (mandatory; allow-listed per table).' };
const PACKAGE = { type: 'string', description: 'change_id of a package under changes/.' };
const TARGET = {
  frame: { type: 'integer', minimum: 0, description: 'Frame index from ui_snapshot (0 = main page).' },
  role: { type: 'string', description: 'ARIA role, e.g. button, link, textbox.' },
  name: { type: 'string', description: 'Accessible name used with role.' },
  label: { type: 'string', description: 'Form label text.' },
  text: { type: 'string', description: 'Visible text.' },
  exact: { type: 'boolean' },
};
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS = [
  { name: 'sn_instance_info', kind: 'rest', description: 'Version, the authenticated user and their roles (warns on admin).', inputSchema: obj({}) },
  { name: 'sn_query', kind: 'rest', description: 'Read-only Table API query on an allow-listed configuration table.', inputSchema: obj({ table: { type: 'string' }, fields: FIELDS, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10000 } }, ['table', 'fields']) },
  { name: 'sn_get_record', kind: 'rest', description: 'One configuration record with its record link as evidence. Code fields are readable, e.g. sp_widget template/css/client_script/script, sys_script script/condition, sys_ui_page html/client_script; a refused field lists the allowed ones.', inputSchema: obj({ table: { type: 'string' }, sys_id: SYS_ID, fields: FIELDS }, ['table', 'sys_id', 'fields']) },
  { name: 'sn_update_sets', kind: 'rest', description: 'Local update sets (sys_update_set) by state, plus the current update set per user. Retrieved/imported sets are in sys_remote_update_set (sn_query).', inputSchema: obj({ state: { type: 'string', description: 'e.g. in progress, complete, ignore.' } }) },
  { name: 'sn_update_set_contents', kind: 'rest', description: 'The customer updates (sys_update_xml) of one update set.', inputSchema: obj({ update_set: SYS_ID }, ['update_set']) },
  { name: 'sn_customizations', kind: 'rest', description: 'Customer updates grouped by type, optionally for one scope.', inputSchema: obj({ scope: { type: 'string' } }) },
  { name: 'sn_portal_page', kind: 'rest', description: 'A whole Service Portal page in one call: containers → rows → columns → widget instances (nested rows included), each with its widget, options (widget_parameters, e.g. HTML content) and css.', inputSchema: obj({ page: { type: 'string', description: 'sp_page id (e.g. edupulse_landing) or sys_id.' } }, ['page']) },
  { name: 'sn_report_gap', kind: 'local', description: 'Report something snowgate does not let you see or do that you need (a field, table, tool or behaviour). It is kept without instance data and sent to the snowgate developers only when the user runs snowgate feedback send.', inputSchema: obj({ summary: { type: 'string', description: 'What is missing, in one sentence.' }, need: { type: 'string', description: 'Why you needed it for the task.' }, suggestion: { type: 'string', description: 'Optional: what would solve it.' }, area: { type: 'string', description: 'Optional: table, field or tool concerned.' } }, ['summary', 'need']) },
  { name: 'ui_navigate', kind: 'ui', description: 'Open a path or URL on the confirmed target instance.', inputSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'ui_snapshot', kind: 'ui', description: 'Accessibility snapshot of every frame, with frame indexes and URLs.', inputSchema: obj({}) },
  { name: 'ui_click', kind: 'ui', description: 'Click the single element matching role+name, label, or text.', inputSchema: obj(TARGET) },
  { name: 'ui_type', kind: 'ui', description: 'Fill the single matching input with text (never a password field).', inputSchema: obj({ ...TARGET, value: { type: 'string' }, submit: { type: 'boolean' } }, ['value']) },
  { name: 'ui_screenshot', kind: 'ui', description: 'Full-page screenshot saved as evidence (under the package when given).', inputSchema: obj({ label: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,60}$' }, package: PACKAGE }, ['label']) },
  { name: 'ui_upload_update_set', kind: 'gate', description: 'Upload changes/<ID>/update-set.xml: package >= peer-reviewed, validator clean, current upload approval for this exact file.', inputSchema: obj({ package: PACKAGE }, ['package']) },
  { name: 'ui_preview_update_set', kind: 'gate', description: 'Preview the retrieved update set of an uploaded package and return its problems.', inputSchema: obj({ package: PACKAGE }, ['package']) },
  { name: 'ui_commit_update_set', kind: 'gate', description: 'Commit the retrieved update set: requires a current human commit approval for this exact package and file.', inputSchema: obj({ package: PACKAGE }, ['package']) },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

// Readable by fixed-shape queries only (sn_update_sets), never through the
// free-form tools: preferences belong to users (PLAN §4, configuration only).
const FIXED_SHAPE_ONLY = new Set(['sys_user_preference']);

function freeFormTable(table) {
  if (FIXED_SHAPE_ONLY.has(table)) {
    throw new SnowgateError(`${table} is readable only through its dedicated tool, not free-form queries.`, 'TABLE_NOT_ALLOWED');
  }
  return table;
}

function packageErrors(root, pkg) {
  return validatePackages(root).errors.filter((e) => e.startsWith(`${pkg.name}:`));
}

function requirePackageForTarget(pkg, ctx) {
  const instance = pkg.manifest?.target?.instance;
  if (instance && instance !== ctx.instance) {
    throw new SnowgateError(`${pkg.manifest.change_id} targets ${instance}, but ${ctx.workId}'s confirmed target is ${ctx.instance}.`, 'PACKAGE_TARGET_MISMATCH');
  }
  if (String(pkg.manifest?.task_id ?? '') !== ctx.workId) {
    throw new SnowgateError(`${pkg.manifest.change_id} belongs to ${pkg.manifest?.task_id ?? 'no work item'}, not the gateway's work item ${ctx.workId}.`, 'PACKAGE_WORK_MISMATCH');
  }
}

async function remoteFor(ctx, pkg) {
  const name = updateSetName(pkg.xmlPath);
  const { record, evidence } = await findRemoteUpdateSet(ctx.client(), name);
  if (!record) throw new SnowgateError(`No retrieved update set named "${name}" on ${ctx.instance}; upload it first.`, 'REMOTE_UPDATE_SET_MISSING');
  return { remote: record, evidence };
}

export const HANDLERS = {
  async sn_instance_info(ctx) {
    const client = ctx.client();
    const me = await client.whoami();
    const { roles, evidence: rolesEvidence } = await client.roles(me.sys_id);
    const version = await client.version();
    const warnings = roles.includes('admin')
      ? ['The user has the admin role. Prefer a dedicated read-only integration user; snc_read_only is a candidate but must be verified on this instance.']
      : [];
    return { instance: ctx.instance, user: me.user_name, roles, version: version.properties, warnings, evidence: [me.evidence, rolesEvidence, version.evidence] };
  },

  async sn_query(ctx, { table, fields, query, limit }) {
    return ctx.client().query(freeFormTable(table), { fields, query, limit });
  },

  async sn_get_record(ctx, { table, sys_id: sysId, fields }) {
    return ctx.client().getRecord(freeFormTable(table), sysId, fields);
  },

  async sn_update_sets(ctx, { state } = {}) {
    const client = ctx.client();
    const sets = await client.query('sys_update_set', {
      fields: ['sys_id', 'name', 'state', 'application', 'sys_created_by', 'sys_created_on', 'sys_updated_on'],
      query: state ? `state=${state.replace(/\^/g, '')}` : '',
    });
    const current = await client.query('sys_user_preference', { fields: ['user', 'value'], query: 'name=sys_update_set' });
    return { update_sets: sets.records, current_per_user: current.records, evidence: [sets.evidence, current.evidence] };
  },

  async sn_update_set_contents(ctx, { update_set: updateSet }) {
    return ctx.client().query('sys_update_xml', {
      fields: ['sys_id', 'type', 'name', 'target_name', 'update_set', 'application', 'sys_updated_on'],
      query: `update_set=${updateSet}`,
    });
  },

  async sn_customizations(ctx, { scope } = {}) {
    if (scope && !/^[A-Za-z0-9_]+$/.test(scope)) throw new SnowgateError(`"${scope}" is not a scope name.`, 'SCOPE_INVALID');
    const result = await ctx.client().query('sys_update_xml', {
      fields: ['sys_id', 'type', 'name', 'target_name', 'update_set', 'application', 'sys_updated_on'],
      query: scope ? `application.scope=${scope}` : '',
    });
    const by_type = {};
    for (const r of result.records) (by_type[r.type || '(none)'] ??= []).push(r);
    return { by_type, count: result.records.length, evidence: result.evidence };
  },

  async sn_portal_page(ctx, { page }) {
    return portalPage(ctx.client(), page);
  },

  async sn_report_gap(ctx, { summary, need, suggestion, area }) {
    const gap = recordGap(ctx.root, { kind: 'agent-report', code: 'AGENT_REPORT', subject: area || summary, detail: `${summary} — needed for: ${need}`, suggestion }, ctx.now());
    return { recorded: gap.fingerprint, seen: gap.count, note: 'Kept locally without instance data; the user sends it with snowgate feedback send.' };
  },

  async ui_navigate(ctx, { url }) {
    const session = ctx.session();
    const resolved = resolveTargetUrl(url, session.origin);
    if (!resolved || new URL(resolved).origin !== session.origin) {
      throw new SnowgateError(`Refused: ${url} is not on the confirmed target ${ctx.instance}.`, 'HOST_LOCKED');
    }
    await session.navigate(resolved);
    const blocked = await session.postCheck();
    return { url: session.pageUrl(), frames: session.frames(), blocked };
  },

  async ui_snapshot(ctx) {
    const session = ctx.session();
    const frames = await session.snapshot();
    await session.postCheck();
    return { url: session.pageUrl(), frames };
  },

  async ui_click(ctx, target) {
    const session = ctx.session();
    await session.click(target);
    const blocked = await session.postCheck();
    return { url: session.pageUrl(), frames: session.frames(), blocked };
  },

  async ui_type(ctx, { value, submit, ...target }) {
    const session = ctx.session();
    await session.type(target, value, { submit });
    const blocked = await session.postCheck();
    return { url: session.pageUrl(), frames: session.frames(), blocked };
  },

  async ui_screenshot(ctx, { label, package: change }) {
    const session = ctx.session();
    let dir = snowgateDir(ctx.root, 'evidence', ctx.workId);
    if (change) {
      const pkg = readPackage(ctx.root, change);
      requirePackageForTarget(pkg, ctx);
      dir = path.join(pkg.dir, 'evidence');
    }
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ctx.now().toISOString().replace(/[:.]/g, '-')}-${label}.png`);
    await session.screenshot(file);
    await session.postCheck();
    return { file: path.relative(ctx.root, file), url: session.pageUrl() };
  },

  async ui_upload_update_set(ctx, { package: change }) {
    const pkg = readPackage(ctx.root, change);
    requirePackageForTarget(pkg, ctx);
    if (!stateAtLeast(pkg.manifest.lifecycle_state, 'peer-reviewed')) {
      throw new SnowgateError(`${change} is '${pkg.manifest.lifecycle_state}'; upload needs 'peer-reviewed' or later.`, 'PACKAGE_STATE');
    }
    const errors = packageErrors(ctx.root, pkg);
    if (errors.length) throw new SnowgateError(`${change} fails validation:\n  - ${errors.join('\n  - ')}`, 'PACKAGE_INVALID');
    const approval = requireApproval(ctx.root, ctx.workId, change, 'upload', pkg.xmlPath);
    const session = ctx.session();
    await session.withUnlocked((page) => uploadUpdateSet(page, session.origin, pkg.xmlPath));
    const { remote, evidence } = await remoteFor(ctx, pkg);
    return { uploaded: change, approval: { sha256: approval.sha256, approved_by: approval.approved_by }, remote_update_set: remote, evidence };
  },

  async ui_preview_update_set(ctx, { package: change }) {
    const pkg = readPackage(ctx.root, change);
    requirePackageForTarget(pkg, ctx);
    requireApproval(ctx.root, ctx.workId, change, 'upload', pkg.xmlPath);
    const { remote } = await remoteFor(ctx, pkg);
    const session = ctx.session();
    const previewed = await session.withUnlocked((page) => previewUpdateSet(page, session.origin, ctx.client(), remote));
    const { problems, evidence } = await previewProblems(ctx.client(), remote.sys_id);
    return { remote_update_set: previewed, problems, evidence };
  },

  async ui_commit_update_set(ctx, { package: change }) {
    const pkg = readPackage(ctx.root, change);
    requirePackageForTarget(pkg, ctx);
    if (pkg.manifest.lifecycle_state !== 'awaiting-human-approval') {
      throw new SnowgateError(`${change} is '${pkg.manifest.lifecycle_state}'; commit needs 'awaiting-human-approval'.`, 'PACKAGE_STATE');
    }
    const errors = packageErrors(ctx.root, pkg);
    if (errors.length) throw new SnowgateError(`${change} fails validation:\n  - ${errors.join('\n  - ')}`, 'PACKAGE_INVALID');
    const approval = requireApproval(ctx.root, ctx.workId, change, 'commit', pkg.xmlPath);
    const { remote } = await remoteFor(ctx, pkg);
    if (remote.state !== 'previewed') throw new SnowgateError(`The retrieved update set is '${remote.state}'; it must be previewed first.`, 'NOT_PREVIEWED');
    const { problems } = await previewProblems(ctx.client(), remote.sys_id);
    const open = problems.filter((p) => !p.status);
    if (open.length) throw new SnowgateError(`${open.length} preview problem(s) are unresolved; resolve them before commit.`, 'PREVIEW_PROBLEMS');
    const session = ctx.session();
    const committed = await session.withUnlocked((page) => commitUpdateSet(page, session.origin, ctx.client(), remote), {
      onDialog: (d) => d.accept(),
    });
    return { committed: change, approval: { sha256: approval.sha256, approved_by: approval.approved_by, approved_at: approval.approved_at }, remote_update_set: committed };
  },
};
