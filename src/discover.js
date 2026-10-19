import { mkdirSync, writeFileSync } from 'node:fs';
import { appendAudit } from './audit.js';
import { SnowgateError, TableAccessError } from './errors.js';
import { normalizeInstance } from './instance.js';
import { INVENTORY, TABLES, inventoryQuery } from './rest/tables.js';
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
      const res = await client.query(entry.table, { fields: TABLES[entry.table], query });
      inventory[entry.key] = { label: entry.label, table: entry.table, records: res.records, evidence: cite(entry.label, res.evidence) };
      if (res.evidence.truncated) {
        limitations.push({ area: entry.key, table: entry.table, reason: `Result hit the ${res.records.length}-record safety cap and may be incomplete.` });
      }
    } catch (err) {
      limitTable(limitations, err, entry.table, `${entry.label} could not be inventoried.`);
      inventory[entry.key] = { label: entry.label, table: entry.table, records: null, evidence: null };
    }
  }

  // 3. Hazards.
  const hazards = findHazards(inventory, now);

  // 4. Output.
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = snowgateDir(root, 'discovery', target, stamp);
  mkdirSync(dir, { recursive: true });
  const meta = { instance: target, work_id: workId, scope: scope ?? null, generated_at: now.toISOString(), read_only: true };
  writeJson(`${dir}/inventory.json`, { ...meta, preflight, inventory, hazards });
  writeJson(`${dir}/evidence.json`, { ...meta, evidence });
  writeFileSync(`${dir}/report.md`, renderReport(meta, preflight, inventory, hazards, limitations));
  writeFileSync(`${dir}/limitations.md`, renderLimitations(meta, limitations));

  const summary = {
    dir,
    tables_read: Object.values(inventory).filter((i) => i.records).length,
    tables_unreadable: Object.values(inventory).filter((i) => !i.records).length,
    hazards: hazards.length,
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

function renderReport(meta, preflight, inventory, hazards, limitations) {
  const lines = [
    `# ServiceNow discovery — ${meta.instance}`,
    '',
    `- Work item: ${meta.work_id}`,
    `- Scope filter: ${meta.scope ?? '(none — customer-scoped x_ apps plus customer updates)'}`,
    `- Generated: ${meta.generated_at}`,
    '- Mode: read-only (GET only, allow-listed configuration tables and fields)',
    '',
    'Every fact cites an evidence id from `evidence.json` (query + URL). Table names are confirmed only where they were read successfully; see `limitations.md` for what was not.',
    '',
    '## Preflight',
    '',
    `- User: ${preflight.user} [${preflight.user_evidence}]`,
    `- Roles: ${preflight.roles.length ? preflight.roles.join(', ') : '(not read)'}${preflight.roles_evidence ? ` [${preflight.roles_evidence}]` : ''}`,
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
    else lines.push(`- **In Progress update set "${h.update_set}"** (${h.sys_id}): ${h.age_days ?? '?'} day(s) since last update; current for ${h.current_for_users} user(s). Do not add to, complete, or switch it without explicit user authorization.${cite}`);
  }
  lines.push('', '## Inventory', '', '| Area | Table | Records | Evidence |', '|---|---|---|---|');
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
    '- Global-scope customisations are inventoried through customer updates (`sys_update_xml`), not per artifact table; artifact tables list customer-scoped (`x_`) records only unless `--scope` is given.',
    '- Transactional data and PII tables are never read by design.',
    '',
  );
  return lines.join('\n');
}
