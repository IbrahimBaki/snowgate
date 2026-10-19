import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { discover } from '../src/discover.js';
import { loadPack } from '../src/pack.js';
import { buildMap, collectArtifacts, duplicateSetNames, parseUpdateName } from '../src/project-map.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, ME, PASSWORD, USER, makeProject, startMockServiceNow } from './helpers.js';

// PF-0011: the project map from update-set contents, in every scope.
const WORK = 'PF-0001';
const pack = loadPack();
const id = (c) => c.repeat(32);
const SET_LANDING = id('1'), SET_DEFAULT = id('2'), SET_DUP = id('3'), REMOTE = id('4');
const PAGE = id('a'), WIDGET = id('b'), ACL = id('c'), BR = id('d'), GONE = id('e');

const updates = [
  { sys_id: id('5'), type: 'Page', name: `sp_page_${PAGE}`, target_name: 'edupulse_landing', action: 'INSERT_OR_UPDATE', update_set: SET_LANDING, remote_update_set: '', application: 'global', sys_updated_on: '' },
  { sys_id: id('6'), type: 'Widget', name: `sp_widget_${WIDGET}`, target_name: 'Hero', action: 'INSERT_OR_UPDATE', update_set: SET_LANDING, remote_update_set: '', application: 'global', sys_updated_on: '' },
  { sys_id: id('7'), type: 'Page', name: `sp_page_${PAGE}`, target_name: 'edupulse_landing', action: 'INSERT_OR_UPDATE', update_set: SET_DUP, remote_update_set: '', application: 'global', sys_updated_on: '' },
  { sys_id: id('8'), type: 'Access Control', name: `sys_security_acl_${ACL}`, target_name: 'incident.read', action: 'INSERT_OR_UPDATE', update_set: SET_DEFAULT, remote_update_set: '', application: 'global', sys_updated_on: '' },
  { sys_id: id('9'), type: 'Business Rule', name: `sys_script_${BR}`, target_name: 'x', action: 'INSERT_OR_UPDATE', update_set: '', remote_update_set: REMOTE, application: 'global', sys_updated_on: '' },
  { sys_id: id('0'), type: 'Widget', name: `sp_widget_${GONE}`, target_name: 'Old', action: 'DELETE', update_set: SET_DEFAULT, remote_update_set: '', application: 'global', sys_updated_on: '' },
  { sys_id: id('f'), type: 'Dictionary', name: 'sys_dictionary_u_course_u_title', target_name: 'u_course.u_title', action: 'INSERT_OR_UPDATE', update_set: SET_LANDING, remote_update_set: '', application: 'global', sys_updated_on: '' },
];
const localSets = [
  { sys_id: SET_LANDING, name: 'EDUPULSE-002 - Landing Page', state: 'complete', application: 'global', sys_created_by: 'admin', sys_created_on: '', sys_updated_on: '2026-10-01 00:00:00' },
  { sys_id: SET_DUP, name: 'EDUPULSE-002 - Landing Page', state: 'complete', application: 'global', sys_created_by: 'admin', sys_created_on: '', sys_updated_on: '2026-10-01 00:00:00' },
  { sys_id: SET_DEFAULT, name: 'Default', state: 'in progress', application: 'global', sys_created_by: 'system', sys_created_on: '', sys_updated_on: '2026-10-18 00:00:00' },
];

test('update names identify the exact record; other updates keep their target name', () => {
  assert.deepEqual(parseUpdateName(`sp_page_${PAGE}`), { table: 'sp_page', sys_id: PAGE });
  assert.deepEqual(parseUpdateName(`sys_security_acl_${ACL}`), { table: 'sys_security_acl', sys_id: ACL });
  assert.equal(parseUpdateName('sys_dictionary_u_course_u_title'), null);
  const artifacts = collectArtifacts(updates);
  const page = artifacts.find((a) => a.sys_id === PAGE);
  assert.equal(page.updates, 2);
  assert.equal(page.update_sets.length, 2);
  assert.equal(artifacts.find((a) => a.sys_id === GONE).deleted, true);
  assert.equal(artifacts.find((a) => a.type === 'Dictionary').name, 'u_course.u_title');
});

test('the map groups artifacts by local and retrieved update set and flags duplicate names', () => {
  const map = buildMap(collectArtifacts(updates), localSets, [{ sys_id: REMOTE, name: 'Imported fixes', state: 'committed' }]);
  const names = map.map((s) => s.name);
  assert.equal(names.at(-1), 'Default');
  const retrieved = map.find((s) => s.kind === 'retrieved');
  assert.equal(retrieved.name, 'Imported fixes');
  assert.equal(retrieved.artifacts[0].type, 'Business Rule');
  assert.deepEqual(duplicateSetNames(localSets), [{ name: 'EDUPULSE-002 - Landing Page', count: 2 }]);
});

test('discover reports global-scope project work by update set, with origin and deletions', async () => {
  const root = makeProject(WORK);
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
  const byIds = (rows) => (params) => {
    const ids = /sys_idIN([0-9a-f,]+)/.exec(params.get('sysparm_query') ?? '')?.[1]?.split(',') ?? null;
    return ids ? rows.filter((r) => ids.includes(r.sys_id)) : [];
  };
  const mock = await startMockServiceNow({
    tables: {
      sys_user: [{ sys_id: ME, user_name: USER }],
      sys_user_has_role: [{ 'role.name': 'admin' }, { 'role.name': 'itil' }],
      sys_properties: [],
      sys_scope: [],
      sys_update_set: localSets,
      sys_user_preference: [],
      sys_update_xml: updates,
      sys_remote_update_set: [{ sys_id: REMOTE, name: 'Imported fixes', state: 'committed', sys_created_on: '' }],
      sp_page: byIds([{ sys_id: PAGE, id: 'edupulse_landing', title: 'EduPulse', sys_scope: 'global', sys_created_by: 'admin', sys_created_on: '2026-09-01 00:00:00' }]),
      sp_widget: byIds([{ sys_id: WIDGET, name: 'EduPulse Hero', id: 'ep-hero', sys_scope: 'global', sys_created_by: 'admin', sys_created_on: '' }]),
      sys_security_acl: byIds([{ sys_id: ACL, name: 'incident', operation: 'read', type: 'record', active: 'true', sys_scope: 'global', sys_created_by: 'system', sys_created_on: '' }]),
      sys_script: byIds([{ sys_id: BR, name: 'Set course code', collection: 'u_course', when: 'before', active: 'false', sys_scope: 'global', sys_updated_on: '', sys_created_by: 'dev.one', sys_created_on: '' }]),
    },
  });
  const client = new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl, pattern: pack.instancePattern });
  try {
    const summary = await discover({ root, workId: WORK, client, pattern: pack.instancePattern });
    assert.equal(summary.artifacts, 6);
    const map = JSON.parse(readFileSync(path.join(summary.dir, 'project-map.json'), 'utf8'));
    const all = map.update_sets.flatMap((s) => s.artifacts);
    const page = all.find((a) => a.sys_id === PAGE);
    assert.equal(page.name, 'edupulse_landing');
    assert.equal(page.origin, 'new');
    assert.equal(all.find((a) => a.sys_id === ACL).origin, 'baseline-modified');
    assert.equal(all.find((a) => a.sys_id === GONE).origin, 'deleted');
    const report = readFileSync(path.join(summary.dir, 'report.md'), 'utf8');
    assert.match(report, /### EDUPULSE-002 - Landing Page — complete/);
    assert.match(report, /\*\*Page\*\* \(1\): `edupulse_landing` \(new, sp_page\)/);
    assert.match(report, /### Imported fixes — committed, retrieved/);
    assert.match(report, /`Set course code` \(new, inactive, sys_script\)/);
    assert.match(report, /2 local update sets are named "EDUPULSE-002 - Landing Page"/);
    assert.match(report, /2 role\(s\); notable: admin/);
    assert.match(report, /\(3 local, 1 retrieved\)/);
    assert.equal(summary.update_sets_local, 3);
    assert.equal(summary.update_sets_retrieved, 1);
    // The map carries metadata only; code is read per record.
    const widgetReads = mock.requests.filter((r) => r.path.endsWith('/sp_widget'));
    assert.ok(widgetReads.length && widgetReads.every((r) => !r.params.sysparm_fields.split(',').some((f) => ['script', 'client_script', 'template', 'css'].includes(f))));
    assert.ok(!report.includes('itil, '), 'the full role list stays out of the report');
    // Records were read by sys_id with GET only.
    assert.ok(mock.requests.every((r) => r.method === 'GET'));
    assert.ok(mock.requests.some((r) => r.path.endsWith('/sp_page') && /sys_idIN/.test(r.params.sysparm_query)));
  } finally {
    await mock.close();
  }
});
