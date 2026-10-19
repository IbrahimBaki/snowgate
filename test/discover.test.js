import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { discover, findHazards } from '../src/discover.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, ME, PASSWORD, USER, basicAuth, makeProject, startMockServiceNow } from './helpers.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const OLD_SET = 'b'.repeat(32);
const DEFAULT_SET = 'c'.repeat(32);

const tables = {
  sys_user: [{ sys_id: ME, user_name: USER, email: 'should-never-be-requested@example.com' }],
  sys_user_has_role: [{ 'role.name': 'admin' }, { 'role.name': 'itil' }],
  sys_properties: [{ name: 'glide.buildtag', value: 'glide-test-build' }],
  sys_scope: [{ sys_id: 'd'.repeat(32), scope: 'x_acme_app', name: 'Acme App', version: '1.0.0', active: 'true' }],
  sys_update_set: [
    { sys_id: OLD_SET, name: 'Old work', state: 'in progress', sys_updated_on: '2026-08-01 10:00:00' },
    { sys_id: DEFAULT_SET, name: 'Default', state: 'in progress', sys_updated_on: '2026-10-19 09:00:00' },
  ],
  sys_user_preference: [{ user: ME, value: OLD_SET }],
  sys_update_xml: [
    { sys_id: '1'.repeat(32), type: 'Business Rule', name: 'sys_script_1', update_set: DEFAULT_SET, application: 'global' },
    { sys_id: '2'.repeat(32), type: 'Widget', name: 'sp_widget_1', update_set: OLD_SET, application: 'd'.repeat(32) },
  ],
  sys_db_object: [],
  sys_dictionary: [],
  sys_script: [],
  sys_script_include: [],
  sys_script_client: [],
  sys_ui_policy: [],
  sp_portal: [],
  sp_page: [],
  sp_widget: [],
  sc_cat_item: [],
  item_option_new: [],
  sys_hub_flow: [],
  sysauto_script: [],
  sys_rest_message: [],
};

let mock;
before(async () => {
  mock = await startMockServiceNow({ tables, forbidden: ['sys_security_acl'], expectedAuth: basicAuth() });
});
after(() => mock.close());

const client = () => new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl });

async function confirmedProject() {
  const root = makeProject();
  setCandidate(root, 'PF-0001', INSTANCE);
  await confirmTarget(root, 'PF-0001', { ask: async () => INSTANCE, who: 'Tester', now: NOW });
  return root;
}

test('refuses without a confirmed target and makes no request', async () => {
  const root = makeProject();
  setCandidate(root, 'PF-0001', INSTANCE);
  const before = mock.requests.length;
  await assert.rejects(discover({ root, workId: 'PF-0001', client: client(), now: NOW }), { code: 'TARGET_UNCONFIRMED' });
  assert.equal(mock.requests.length, before);
});

test('refuses an instance argument that differs from the confirmed target', async () => {
  const root = await confirmedProject();
  await assert.rejects(discover({ root, workId: 'PF-0001', instance: 'dev99999.service-now.com', client: client(), now: NOW }), { code: 'TARGET_MISMATCH' });
});

test('full read-only run writes report, evidence, inventory and limitations', async () => {
  const root = await confirmedProject();
  const start = mock.requests.length;
  const summary = await discover({ root, workId: 'PF-0001', client: client(), now: NOW });
  const reqs = mock.requests.slice(start);

  assert.ok(reqs.every((r) => r.method === 'GET'));
  // The preflight never asks for more than sys_id,user_name from sys_user.
  const userReq = reqs.find((r) => r.path.endsWith('/sys_user'));
  assert.equal(userReq.params.sysparm_fields, 'sys_id,user_name');

  for (const f of ['inventory.json', 'evidence.json', 'report.md', 'limitations.md']) assert.ok(existsSync(path.join(summary.dir, f)), f);
  const inventory = JSON.parse(readFileSync(path.join(summary.dir, 'inventory.json'), 'utf8'));
  assert.equal(inventory.read_only, true);
  assert.equal(inventory.preflight.version['glide.buildtag'], 'glide-test-build');
  assert.equal(inventory.inventory.acls.records, null);
  assert.ok(!JSON.stringify(inventory).includes('should-never-be-requested'));

  const limitations = readFileSync(path.join(summary.dir, 'limitations.md'), 'utf8');
  assert.match(limitations, /sys_security_acl.*HTTP 403/);

  const report = readFileSync(path.join(summary.dir, 'report.md'), 'utf8');
  assert.match(report, /Old work/);
  assert.match(report, /Default update set/);
  assert.equal(summary.warnings.length, 1, 'admin role warning');

  const evidence = JSON.parse(readFileSync(path.join(summary.dir, 'evidence.json'), 'utf8'));
  assert.ok(evidence.evidence.every((e) => e.url?.startsWith(`https://${INSTANCE}/`)));
  assert.ok(!JSON.stringify(evidence).includes(PASSWORD));

  const audit = readFileSync(path.join(root, '.snowgate', 'audit', 'PF-0001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.filter((a) => a.tool === 'discover').map((a) => a.phase), ['start', 'end']);
  assert.ok(!JSON.stringify(audit).includes(PASSWORD));
});

test('--scope narrows artifact queries to that scope', async () => {
  const root = await confirmedProject();
  const start = mock.requests.length;
  await discover({ root, workId: 'PF-0001', scope: 'x_acme_app', client: client(), now: NOW });
  const br = mock.requests.slice(start).find((r) => r.path.endsWith('/sys_script'));
  assert.equal(br.params.sysparm_query, 'sys_scope.scope=x_acme_app');
  await assert.rejects(discover({ root, workId: 'PF-0001', scope: 'x^ORactive=true', client: client(), now: NOW }), { code: 'SCOPE_INVALID' });
});

test('hazards: abandoned and current in-progress sets, Default captures, global updates', () => {
  const inventory = {
    update_sets: { records: tables.sys_update_set, evidence: 'E-1' },
    current_update_set_prefs: { records: tables.sys_user_preference, evidence: 'E-2' },
    customer_updates: { records: tables.sys_update_xml, evidence: 'E-3' },
  };
  const kinds = findHazards(inventory, NOW).map((h) => h.kind).sort();
  assert.deepEqual(kinds, ['abandoned-in-progress-update-set', 'changes-in-default-update-set', 'unscoped-global-customizations']);
});
