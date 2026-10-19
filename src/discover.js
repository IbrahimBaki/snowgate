import { mkdirSync, writeFileSync } from 'node:fs';
import { appendAudit } from './audit.js';
import { SnowgateError, TableAccessError } from './errors.js';
import { normalizeInstance } from './instance.js';
import { buildMap, collectArtifacts, duplicateSetNames, enrichArtifacts, summarizeByType } from './project-map.js';
import { INVENTORY, TABLES, inventoryQuery, metaFields } from './rest/tables.js';
import { requireConfirmedTarget } from './work.js';
import { snowgateDir } from './workspace.js';

const ABANDONED_DAYS = 30;
const SCOPE_PATTERN = /^[a-z0-9_]+$/;

// Read-only discovery of an existing ServiceNow instance (PLAN §8). Requires a
// confirmed target for the work item (PLAN §15 A3); never writes to the
// instance; anything it cannot read becomes a limitation, never a guess.
export async function discover({ root, workId, instance: requested, scope, client, pattern, now = new Date() }) {
  const target = requireConfirmedTarget(root, workId);
  if (requested && normalizeInstance(requested, pattern) !== target) {
    throw new SnowgateError(`${requested} is not the confirmed target for ${workId} (${target}).`, 'TARGET_MISMATCH');
  }
  if (client.instance !== target) {
    throw new SnowgateError(`REST client is bound to ${client.instance}, not the confirmed target ${target}.`, 'TARGET_MISMATCH');
  }
  if (scope && !SCOPE_PATTERN.test(scope)) {
    throw new SnowgateError(`"${scope}" is not a valid application scope name.`, 'SCOPE_INVALID');
  }

  appendAudit(root, workId, { tool: 'discover', phase: 'start', target, scope: scope ?? null }, now);

  const evidence = [];
  const limitations = [];
  const cite = (fact, ev) => {
    const id = `E-${String(evidence.length + 1).padStart(3, '0')}`;
    evidence.push({ id, fact, ...ev });
    return id;
  };

  // 1. Preflight — auth errors abort here.
  const me = await client.whoami();
  const meRef = cite('Authenticated user record', me.evidence);
  const preflight = { user: me.user_name, user_evidence: meRef, roles: [], version: {}, warnings: [] };

  try {
    const r = await client.roles(me.sys_id);
    preflight.roles = r.roles;
    preflight.roles_evidence = cite('Active roles of the authenticated user', r.evidence);
    if (r.roles.includes('admin')) {
      preflight.warnings.push(
        'The discovery user has the admin role. Prefer a dedicated read-only integration user; the snc_read_only role is a candidate but must be verified on this instance.',
      );
    }
  } catch (err) {
    limitTable(limitations, err, 'sys_user_has_role', 'Roles of the discovery user could not be read.');
  }

  try {
    const v = await client.version();
    preflight.version = v.properties;
    preflight.version_evidence = cite('Build/version properties', v.evidence);
    if (!Object.keys(v.properties).length) limitations.push({ area: 'preflight', table: 'sys_properties', reason: 'No build/version properties were readable.' });
  } catch (err) {
    limitTable(limitations, err, 'sys_properties', 'Instance version could not be read.');
  }

  // 2. Inventory.
  const inventory = {};
  for (const entry of INVENTORY) {
    const query = inventoryQuery(entry, scope);
    try {
      const res = await client.query(entry.table, { fields: metaFields(entry.table), query });
      inventory[entry.key] = { label: entry.label, table: entry.table, records: res.records, evidence: cite(entry.label, res.evidence) };
      if (res.evidence.truncated) {
        limitations.push({ area: entry.key, table: entry.table, reason: `Result hit the ${res.records.length}-record safety cap and may be incomplete.` });
      }
    } catch (err) {
      limitTable(limitations, err, entry.table, `${entry.label} could not be inventoried.`);
      inventory[entry.key] = { label: entry.label, table: entry.table, records: null, evidence: null };
    }
  }

  // 3. Project map: every customization, in any scope, from the update sets'
  // contents (PF-0011).
  let remoteSets = [];
  try {
    const res = await client.query('sys_remote_update_set', { fields: TABLES.sys_remote_update_set });
    remoteSets = res.records;
    cite('Retrieved update sets', res.evidence);
  } catch (err) {
    limitTable(limitations, err, 'sys_remote_update_set', 'Retrieved update sets could not be read; their updates appear without a set name.');
  }
  const updates = inventory.customer_updates?.records ?? [];
  const artifacts = await enrichArtifacts(client, collectArtifacts(updates), { cite, limitations });
  const projectMap = {
    update_sets: buildMap(artifacts, inventory.update_sets?.records ?? [], remoteSets),
    by_type: summarizeByType(artifacts),
    artifacts: artifacts.length,
  };

  // 4. Hazards.
  const hazards = findHazards(inventory, now);
  for (const d of duplicateSetNames(inventory.update_sets?.records ?? [])) {
    hazards.push({ kind: 'duplicate-update-set-name', update_set: d.name, count: d.count, evidence: [inventory.update_sets.evidence] });
  }

  // 5. Output.
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = snowgateDir(root, 'discovery', target, stamp);
  mkdirSync(dir, { recursive: true });
  const meta = { instance: target, work_id: workId, scope: scope ?? null, generated_at: now.toISOString(), read_only: true };
  writeJson(`${dir}/inventory.json`, { ...meta, preflight, inventory, hazards });
  writeJson(`${dir}/evidence.json`, { ...meta, evidence });
  writeJson(`${dir}/project-map.json`, { ...meta, ...projectMap });
  writeFileSync(`${dir}/report.md`, renderReport(meta, preflight, inventory, hazards, limitations, projectMap));
  writeFileSync(`${dir}/limitations.md`, renderLimitations(meta, limitations));

  const summary = {
    dir,
    tables_read: Object.values(inventory).filter((i) => i.records).length,
    tables_unreadable: Object.values(inventory).filter((i) => !i.records).length,
    hazards: hazards.length,
    artifacts: projectMap.artifacts,
    update_sets: projectMap.update_sets.length,
    update_sets_local: projectMap.update_sets.filter((s) => s.kind === 'local').length,
    update_sets_retrieved: projectMap.update_sets.filter((s) => s.kind === 'retrieved').length,
    limitations: limitations.length,
    warnings: preflight.warnings,
  };
  appendAudit(root, workId, { tool: 'discover', phase: 'end', target, result: { ...summary, dir: undefined } });
  return summary;
}

function limitTable(limitations, err, table, what) {
  if (!(err instanceof TableAccessError)) throw err;
  limitations.push({ area: table, table, status: err.status, reason: `${what} ${err.message}` });
}

export function findHazards(inventory, now) {
  const hazards = [];
  const sets = inventory.update_sets?.records ?? [];
  const prefs = inventory.current_update_set_prefs?.records ?? [];
  const updates = inventory.customer_updates?.records ?? [];
  const currentFor = new Map();
  for (const p of prefs) currentFor.set(p.value, (currentFor.get(p.value) ?? 0) + 1);

  for (const s of sets) {
    if (String(s.state).toLowerCase() !== 'in progress') continue;
    const updated = parseSnDate(s.sys_updated_on);
    const ageDays = updated ? Math.floor((now - updated) / 86_400_000) : null;
    const users = currentFor.get(s.sys_id) ?? 0;
    if ((ageDays !== null && ageDays >= ABANDONED_DAYS) || users > 0) {
      hazards.push({
        kind: ageDays !== null && ageDays >= ABANDONED_DAYS ? 'abandoned-in-progress-update-set' : 'in-progress-update-set-is-current',
        update_set: s.name,
        sys_id: s.sys_id,
        age_days: ageDays,
        current_for_users: users,
        evidence: [inventory.update_sets.evidence, inventory.current_update_set_prefs?.evidence].filter(Boolean),
      });
    }
  }

  const defaultIds = new Set(sets.filter((s) => s.name === 'Default').map((s) => s.sys_id));
  const inDefault = updates.filter((u) => defaultIds.has(u.update_set));
  if (inDefault.length) {
    hazards.push({ kind: 'changes-in-default-update-set', count: inDefault.length, evidence: [inventory.update_sets.evidence, inventory.customer_updates.evidence] });
  }

  const unscoped = updates.filter((u) => u.application === 'global');
  if (unscoped.length) {
    hazards.push({ kind: 'unscoped-global-customizations', count: unscoped.length, evidence: [inventory.customer_updates.evidence] });
  }
  return hazards;
}

function parseSnDate(value) {
  if (!value) return null;
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function groupCount(records, field) {
  const counts = {};
  for (const r of records) counts[r[field] || '(empty)'] = (counts[r[field] || '(empty)'] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// Roles that matter for what an agent may do; the rest are summarized.
const NOTABLE_ROLES = ['admin', 'security_admin', 'snc_read_only', 'web_service_admin', 'rest_api_explorer', 'snc_platform_rest_api_access', 'update_set_picker', 'sp_admin', 'catalog_admin', 'oauth_admin'];
const MAX_PER_TYPE = 15;
// Portal layout records carry no meaningful names; they are counted, not listed.
const LAYOUT_TYPES = new Set(['Row', 'Column', 'Container']);

function renderMap(projectMap) {
  const lines = ['## Project map (from update sets)', ''];
  const local = projectMap.update_sets.filter((s) => s.kind === 'local').length;
  const retrieved = projectMap.update_sets.filter((s) => s.kind === 'retrieved').length;
  lines.push(`${projectMap.artifacts} customized artifact(s) across ${projectMap.update_sets.length} update set(s) (${local} local, ${retrieved} retrieved), in every scope (global included). To read an artifact's code, use sn_get_record with its table and sys_id from \`project-map.json\`. "new" / "baseline-modified" is inferred from who created the record. Full detail: \`project-map.json\`.`, '');
  lines.push('### By type', '', '| Type | Total | New | Baseline modified | Deleted | Not read (listed by update name) |', '|---|---|---|---|---|---|');
  for (const r of projectMap.by_type) lines.push(`| ${r.type} | ${r.total} | ${r.new} | ${r['baseline-modified']} | ${r.deleted} | ${r.other} |`);
  lines.push('');
  for (const set of projectMap.update_sets) {
    const kind = set.kind === 'retrieved' ? ', retrieved' : '';
    lines.push(`### ${set.name}${set.state ? ` — ${set.state}` : ''}${kind} (${set.artifacts.length} artifact(s))`, '');
    if (!set.artifacts.length) {
      lines.push('No customer updates.', '');
      continue;
    }
    const byType = new Map();
    for (const a of set.artifacts) (byType.get(a.type) ?? byType.set(a.type, []).get(a.type)).push(a);
    const layout = [...byType].filter(([type]) => LAYOUT_TYPES.has(type));
    if (layout.length) lines.push(`- **Portal layout**: ${layout.map(([type, list]) => `${list.length} ${type.toLowerCase()}(s)`).join(', ')}`);
    for (const [type, list] of [...byType].filter(([t]) => !LAYOUT_TYPES.has(t)).sort((a, b) => b[1].length - a[1].length)) {
      const shown = list.slice(0, MAX_PER_TYPE).map((a) => {
        const flags = [a.origin !== 'unknown' ? a.origin : null, a.active === 'false' ? 'inactive' : null, a.table].filter(Boolean).join(', ');
        return `\`${a.name}\`${flags ? ` (${flags})` : ''}`;
      });
      const more = list.length > MAX_PER_TYPE ? ` … and ${list.length - MAX_PER_TYPE} more` : '';
      lines.push(`- **${type}** (${list.length}): ${shown.join(', ')}${more}`);
    }
    lines.push('');
  }
  return lines;
}

function renderReport(meta, preflight, inventory, hazards, limitations, projectMap) {
  const lines = [
    `# ServiceNow discovery — ${meta.instance}`,
    '',
    `- Work item: ${meta.work_id}`,
    `- Scope filter: ${meta.scope ?? '(none — the project map covers every scope; the per-table inventory lists scoped x_ apps)'}`,
    `- Generated: ${meta.generated_at}`,
    '- Mode: read-only (GET only, allow-listed configuration tables and fields)',
    '',
    'Every fact cites an evidence id from `evidence.json` (query + URL). Table names are confirmed only where they were read successfully; see `limitations.md` for what was not.',
    '',
    '## Preflight',
    '',
    `- User: ${preflight.user} [${preflight.user_evidence}]`,
    `- Roles: ${preflight.roles.length ? `${preflight.roles.length} role(s); notable: ${preflight.roles.filter((r) => NOTABLE_ROLES.includes(r)).join(', ') || 'none'} (full list in inventory.json)` : '(not read)'}${preflight.roles_evidence ? ` [${preflight.roles_evidence}]` : ''}`,
    `- Version properties: ${Object.keys(preflight.version).length ? Object.entries(preflight.version).map(([k, v]) => `${k}=${v}`).join('; ') : '(not read)'}${preflight.version_evidence ? ` [${preflight.version_evidence}]` : ''}`,
    ...preflight.warnings.map((w) => `- ⚠️ ${w}`),
    '',
    '## Hazards',
    '',
  ];
  if (!hazards.length) lines.push('None detected in the data that was readable.');
  for (const h of hazards) {
    const cite = ` [${h.evidence.join(', ')}]`;
    if (h.kind === 'changes-in-default-update-set') lines.push(`- **${h.count} customer update(s) captured in the Default update set.**${cite}`);
    else if (h.kind === 'unscoped-global-customizations') lines.push(`- **${h.count} customer update(s) in the global scope.**${cite}`);
    else if (h.kind === 'duplicate-update-set-name') lines.push(`- **${h.count} local update sets are named "${h.update_set}".** Check which one is the source before reusing or exporting it.${cite}`);
    else lines.push(`- **In Progress update set "${h.update_set}"** (${h.sys_id}): ${h.age_days ?? '?'} day(s) since last update; current for ${h.current_for_users} user(s). Do not add to, complete, or switch it without explicit user authorization.${cite}`);
  }
  if (projectMap) lines.push('', ...renderMap(projectMap));
  lines.push('', '## Scoped application inventory', '', 'Per-table counts for customer-scoped (x_) applications; global-scope work is in the project map above.', '', '| Area | Table | Records | Evidence |', '|---|---|---|---|');
  for (const item of Object.values(inventory)) {
    lines.push(`| ${item.label} | \`${item.table}\` | ${item.records ? item.records.length : 'not readable'} | ${item.evidence ?? '—'} |`);
  }
  const updates = inventory.customer_updates?.records;
  if (updates?.length) {
    lines.push('', '### Customer updates by type', '', '| Type | Count |', '|---|---|');
    for (const [type, n] of groupCount(updates, 'type')) lines.push(`| ${type} | ${n} |`);
  }
  const sets = inventory.update_sets?.records;
  if (sets?.length) {
    lines.push('', '### Update sets by state', '', '| State | Count |', '|---|---|');
    for (const [state, n] of groupCount(sets, 'state')) lines.push(`| ${state} | ${n} |`);
  }
  lines.push('', `## Limitations`, '', `${limitations.length} item(s) — see \`limitations.md\`.`, '');
  lines.push('## Next step', '', 'Findings are candidates, not project facts. Review them and record approved knowledge through YallaFlow (`yallaflow knowledge propose` / `baseline draft`).', '');
  return lines.join('\n');
}

function renderLimitations(meta, limitations) {
  const lines = [`# Discovery limitations — ${meta.instance}`, '', `Generated ${meta.generated_at}. Nothing listed here was guessed or inferred.`, ''];
  if (!limitations.length) lines.push('None recorded.');
  for (const l of limitations) lines.push(`- \`${l.table}\`${l.status ? ` (HTTP ${l.status})` : ''}: ${l.reason}`);
  lines.push(
    '',
    '## Standing limitations',
    '',
    '- The project map sees what update sets captured. Changes made without update-set tracking (for example data records, or records changed by scripts that skip tracking) are not visible there.',
    '- "new" / "baseline-modified" is inferred from the record creator (system accounts mean a platform record), not read from upgrade history.',
    '- Transactional data and PII tables are never read by design.',
    '',
  );
  return lines.join('\n');
}
