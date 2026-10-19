import { TableAccessError } from './errors.js';
import { ARTIFACT_TABLES, TABLES } from './rest/tables.js';

// The project map (PF-0011): what the project consists of, derived from the
// update sets' contents (sys_update_xml) in every scope, global included.
// A customer update's `name` is `<table>_<sys_id>` for record-level updates,
// which identifies the artifact exactly; other updates (dictionary, choices,
// form layouts...) are listed by their own type and target_name.
//
// "new" vs "baseline-modified" is INFERRED from who created the record: the
// platform's own records are created by system accounts. It is a lead for the
// agent, never a fact.
const RECORD_UPDATE = /^([a-z0-9_]+?)_([0-9a-f]{32})$/;
export const BASELINE_AUTHORS = new Set(['system', 'maint', 'glide.maint', 'fresh.install', 'guest', '']);
const BATCH = 100;

export function parseUpdateName(name) {
  const m = RECORD_UPDATE.exec(name ?? '');
  return m ? { table: m[1], sys_id: m[2] } : null;
}

// Groups updates into artifacts (one per table+sys_id, or per type+target for
// non-record updates) and remembers every update set each one appears in.
export function collectArtifacts(updates) {
  const artifacts = new Map();
  for (const u of updates) {
    const parsed = parseUpdateName(u.name);
    const key = parsed ? `${parsed.table}:${parsed.sys_id}` : `${u.type}:${u.target_name || u.name}`;
    let a = artifacts.get(key);
    if (!a) {
      a = {
        key,
        type: u.type || '(unknown)',
        name: u.target_name || u.name,
        table: parsed?.table ?? null,
        sys_id: parsed?.sys_id ?? null,
        deleted: false,
        origin: 'unknown',
        update_sets: [],
        updates: 0,
      };
      artifacts.set(key, a);
    }
    a.updates += 1;
    if (String(u.action).toUpperCase() === 'DELETE') a.deleted = true;
    const setRef = u.update_set ? { local: u.update_set } : u.remote_update_set ? { remote: u.remote_update_set } : null;
    if (setRef && !a.update_sets.some((s) => s.local === setRef.local && s.remote === setRef.remote)) a.update_sets.push(setRef);
  }
  return [...artifacts.values()];
}

// Reads known artifact records by sys_id to name them and infer their origin.
export async function enrichArtifacts(client, artifacts, { cite, limitations }) {
  const byTable = new Map();
  for (const a of artifacts) {
    if (a.table && ARTIFACT_TABLES[a.table]) (byTable.get(a.table) ?? byTable.set(a.table, []).get(a.table)).push(a);
  }
  for (const [table, list] of byTable) {
    const { label, nameField } = ARTIFACT_TABLES[table];
    const found = new Map();
    try {
      for (let i = 0; i < list.length; i += BATCH) {
        const ids = list.slice(i, i + BATCH).map((a) => a.sys_id);
        const res = await client.query(table, { fields: TABLES[table], query: `sys_idIN${ids.join(',')}` });
        const ev = cite(`${label} records named in customer updates`, res.evidence);
        for (const r of res.records) found.set(r.sys_id, { record: r, ev });
      }
    } catch (err) {
      if (!(err instanceof TableAccessError)) throw err;
      limitations.push({ area: 'project-map', table, status: err.status, reason: `${label} records could not be read; listed by their update names only. ${err.message}` });
      continue;
    }
    for (const a of list) {
      const hit = found.get(a.sys_id);
      a.label = label;
      if (!hit) {
        a.origin = a.deleted ? 'deleted' : 'not-found';
        continue;
      }
      const r = hit.record;
      a.name = [nameField].flat().map((f) => r[f]).find(Boolean) || a.name;
      a.scope = r.sys_scope || null;
      a.active = r.active ?? null;
      a.created_by = r.sys_created_by ?? null;
      a.created_on = r.sys_created_on ?? null;
      a.origin = BASELINE_AUTHORS.has(String(r.sys_created_by ?? '').toLowerCase()) ? 'baseline-modified' : 'new';
      a.evidence = hit.ev;
    }
  }
  return artifacts;
}

// Update sets (local and retrieved) with the artifacts each one touched.
export function buildMap(artifacts, localSets, remoteSets) {
  const sets = new Map();
  for (const s of localSets) sets.set(`local:${s.sys_id}`, { kind: 'local', sys_id: s.sys_id, name: s.name, state: s.state, artifacts: [] });
  for (const s of remoteSets) sets.set(`remote:${s.sys_id}`, { kind: 'retrieved', sys_id: s.sys_id, name: s.name, state: s.state, artifacts: [] });
  const outside = { kind: 'none', name: '(no update set readable)', state: null, artifacts: [] };
  for (const a of artifacts) {
    if (!a.update_sets.length) outside.artifacts.push(a);
    for (const ref of a.update_sets) {
      const set = sets.get(ref.local ? `local:${ref.local}` : `remote:${ref.remote}`);
      (set ?? outside).artifacts.push(a);
    }
  }
  const list = [...sets.values()].filter((s) => s.artifacts.length || s.kind === 'local');
  if (outside.artifacts.length) list.push(outside);
  // Named sets first (alphabetically), Default and the unassigned group last.
  const rank = (s) => (s.kind === 'none' ? 2 : s.name === 'Default' ? 1 : 0);
  list.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
  return list;
}

export function duplicateSetNames(localSets) {
  const counts = new Map();
  for (const s of localSets) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([name, n]) => ({ name, count: n }));
}

export function summarizeByType(artifacts) {
  const rows = new Map();
  for (const a of artifacts) {
    const r = rows.get(a.type) ?? { type: a.type, total: 0, new: 0, 'baseline-modified': 0, deleted: 0, other: 0 };
    r.total += 1;
    if (a.origin in r) r[a.origin] += 1;
    else r.other += 1;
    rows.set(a.type, r);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}
