import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { recordApproval } from '../src/approvals.js';
import { createGateway, redact } from '../src/gateway/server.js';
import { TOOL_NAMES } from '../src/gateway/tools.js';
import { loadPack } from '../src/pack.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, ME, PASSWORD, USER, makeProject, startMockServiceNow } from './helpers.js';

const WORK = 'PF-0001';
const pack = loadPack();
const env = { SN_USER: USER, SN_PASSWORD: PASSWORD };

// Exactly PLAN §7.2, plus sn_portal_page (PF-0013, read-only) and
// sn_report_gap (PF-0014, local only) — nothing more.
const ALLOWLIST = [
  'sn_instance_info', 'sn_query', 'sn_get_record', 'sn_update_sets', 'sn_update_set_contents', 'sn_customizations', 'sn_portal_page', 'sn_report_gap',
  'ui_navigate', 'ui_snapshot', 'ui_click', 'ui_type', 'ui_screenshot',
  'ui_upload_update_set', 'ui_preview_update_set', 'ui_commit_update_set',
];

async function confirmed(root) {
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
}

function fakeSession() {
  const calls = [];
  return {
    calls,
    origin: `https://${INSTANCE}`,
    async withUnlocked(fn) {
      calls.push('withUnlocked');
      return fn({ fake: true });
    },
    async close() {},
  };
}

function gateway(root, mock, { session = fakeSession(), workId = WORK } = {}) {
  return createGateway({
    root,
    workId,
    pack,
    env,
    clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: mock.fetchImpl }),
    sessionFactory: () => session,
  });
}

const text = (r) => r.content[0].text;
const auditLines = (root) => readFileSync(path.join(root, '.snowgate', 'audit', `${WORK}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the MCP tool list equals the PLAN §7.2 allowlist plus sn_portal_page and sn_report_gap', async () => {
  const root = makeProject(WORK);
  const mock = await startMockServiceNow();
  const gw = gateway(root, mock);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gw.server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...ALLOWLIST].sort());
    assert.deepEqual([...TOOL_NAMES].sort(), [...ALLOWLIST].sort());
    for (const banned of ['browser_evaluate', 'browser_run_code', 'browser_tabs', 'browser_file_upload', 'browser_press_key']) {
      assert.ok(!TOOL_NAMES.includes(banned));
    }
    const r = await client.callTool({ name: 'browser_evaluate', arguments: {} });
    assert.equal(r.isError, true);
  } finally {
    await client.close();
    await gw.close();
    await mock.close();
  }
});

test('without a confirmed target every tool refuses and no request is made', async () => {
  const root = makeProject(WORK);
  const mock = await startMockServiceNow({ tables: { sys_scope: [] } });
  setCandidate(root, WORK, INSTANCE, pack.instancePattern); // candidate only
  const session = fakeSession();
  const gw = gateway(root, mock, { session });
  try {
    for (const [name, args] of [['sn_query', { table: 'sys_scope', fields: ['sys_id'] }], ['ui_navigate', { url: '/' }], ['ui_commit_update_set', { package: 'X' }]]) {
      const r = await gw.call(name, args);
      assert.equal(r.isError, true);
      assert.match(text(r), /TARGET_UNCONFIRMED/);
    }
    assert.equal(mock.requests.length, 0);
    assert.equal(session.calls.length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('without any work item the gateway refuses with TARGET_UNCONFIRMED', async () => {
  const root = makeProject(WORK);
  const mock = await startMockServiceNow();
  const gw = gateway(root, mock, { workId: null });
  try {
    const r = await gw.call('sn_instance_info', {});
    assert.equal(r.isError, true);
    assert.match(text(r), /TARGET_UNCONFIRMED/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('REST tools read the confirmed target with GET only and carry evidence', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({
    tables: {
      sys_update_xml: [
        { sys_id: '1'.repeat(32), type: 'Business Rule', name: 'a', target_name: 'x', update_set: '2'.repeat(32), application: 'global', sys_updated_on: '' },
        { sys_id: '3'.repeat(32), type: 'Script Include', name: 'b', target_name: 'y', update_set: '2'.repeat(32), application: 'global', sys_updated_on: '' },
      ],
      sys_user: [{ sys_id: ME, user_name: USER }],
      sys_user_has_role: [{ 'role.name': 'admin' }],
      sys_properties: [{ name: 'glide.buildtag', value: 'glide-x' }],
    },
  });
  const gw = gateway(root, mock);
  try {
    const c = JSON.parse(text(await gw.call('sn_customizations', {})));
    assert.equal(c.count, 2);
    assert.deepEqual(Object.keys(c.by_type).sort(), ['Business Rule', 'Script Include']);
    assert.match(c.evidence.url, /\/api\/now\/table\/sys_update_xml/);

    const info = JSON.parse(text(await gw.call('sn_instance_info', {})));
    assert.equal(info.user, USER);
    assert.equal(info.warnings.length, 1);

    const denied = await gw.call('sn_query', { table: 'sys_user', fields: ['email'] });
    assert.equal(denied.isError, true);
    assert.match(text(denied), /TABLE_NOT_ALLOWED/);
    const prefs = await gw.call('sn_query', { table: 'sys_user_preference', fields: ['user', 'value'] });
    assert.match(text(prefs), /TABLE_NOT_ALLOWED/);
    const noFields = await gw.call('sn_query', { table: 'sys_scope' });
    assert.match(text(noFields), /ARGS_INVALID/);

    assert.ok(mock.requests.every((r) => r.method === 'GET'));
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('every call is audited and no credential value reaches the audit trail', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({ tables: { sys_scope: [] } });
  const gw = gateway(root, mock);
  try {
    await gw.call('sn_query', { table: 'sys_scope', fields: ['sys_id'] });
    await gw.call('sn_query', { table: 'sys_user', fields: ['email'] });
    await gw.call('ui_type', { label: 'Search', value: `my ${PASSWORD} here` }); // fails in the fake session, still audited
    const lines = auditLines(root).filter((l) => l.tool.startsWith('sn_') || l.tool.startsWith('ui_'));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => l.ok), [true, false, false]);
    const raw = readFileSync(path.join(root, '.snowgate', 'audit', `${WORK}.jsonl`), 'utf8');
    assert.ok(!raw.includes(PASSWORD));
    assert.ok(!raw.includes(Buffer.from(`${USER}:${PASSWORD}`).toString('base64')));
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('redact drops secret-looking keys and masks known secret values', () => {
  const out = redact({ password: 'x', nested: { token: 'y', note: 'has s3cret-value inside' } }, ['s3cret-value']);
  assert.deepEqual(out, { password: '<redacted>', nested: { token: '<redacted>', note: 'has <redacted> inside' } });
});

// --- upload / commit gates -------------------------------------------------

function writePackage(root, { state = 'peer-reviewed', changeId = 'CHG-1' } = {}) {
  const dir = path.join(root, 'changes', `${changeId}-pkg`);
  mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  writeFileSync(path.join(dir, 'manifest.yaml'), [
    `change_id: ${changeId}`, `task_id: ${WORK}`, 'process_version: 2', 'title: "t"', 'source_baseline: "none"',
    'xml_strategy: capture-and-export', `xml_artifact: "changes/${changeId}-pkg/update-set.xml"`, `lifecycle_state: ${state}`,
    `target: {instance: "${INSTANCE}", confirmed_by: "alice", confirmed_at: "2026-10-19"}`,
    'expected_components: [sc_cat_item]', 'verified_components: []', '',
  ].join('\n'));
  writeFileSync(path.join(dir, 'plan.md'), `task_id: ${WORK}\n## Evidence Register\n\n| Claim or component | Status | Evidence source | Evidence location or URL | Required preflight action |\n|---|---|---|---|---|\n| x | Assumed | docs | https://docs.servicenow.com/ | confirm |\n`);
  writeFileSync(path.join(dir, 'discovery.md'), 'notes');
  writeFileSync(path.join(dir, 'verification.md'), '# Verification\n');
  writeFileSync(path.join(dir, 'evidence', 'preview.png'), 'png');
  const xml = path.join(dir, 'update-set.xml');
  writeFileSync(xml, '<unload><sys_remote_update_set action="INSERT_OR_UPDATE"><name>CHG-1 update set</name></sys_remote_update_set></unload>');
  return xml;
}

const approve = (root, purpose, xml, changeId = 'CHG-1') => recordApproval(root, WORK, { changeId, purpose, xmlPath: xml, ask: async () => changeId, who: 'alice' });

test('upload refuses without approval, with a stale approval, and below peer-reviewed', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({ tables: { sys_remote_update_set: [] } });
  const session = fakeSession();
  const gw = gateway(root, mock, { session });
  try {
    writePackage(root, { state: 'xml-generated' });
    const xml = path.join(root, 'changes', 'CHG-1-pkg', 'update-set.xml');
    await approve(root, 'plan', xml);
    assert.match(text(await gw.call('ui_upload_update_set', { package: 'CHG-1' })), /PACKAGE_STATE/);

    writePackage(root, { state: 'peer-reviewed' });
    assert.match(text(await gw.call('ui_upload_update_set', { package: 'CHG-1' })), /APPROVAL_MISSING/);

    await approve(root, 'upload', xml);
    writeFileSync(xml, '<unload><sys_remote_update_set><name>tampered</name></sys_remote_update_set></unload>');
    assert.match(text(await gw.call('ui_upload_update_set', { package: 'CHG-1' })), /APPROVAL_STALE/);
    assert.equal(session.calls.length, 0, 'no browser step may run before the gates pass');
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('upload passes the gates with a current approval and runs unlocked once', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({ tables: { sys_remote_update_set: [{ sys_id: '9'.repeat(32), name: 'CHG-1 update set', state: 'loaded', sys_created_on: '' }] } });
  const session = fakeSession();
  const gw = createGateway({
    root, workId: WORK, pack, env,
    clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: mock.fetchImpl }),
    sessionFactory: () => ({ ...session, withUnlocked: async () => { session.calls.push('withUnlocked'); } }),
  });
  try {
    const xml = writePackage(root, { state: 'peer-reviewed' });
    await approve(root, 'plan', xml);
    await approve(root, 'upload', xml);
    const r = await gw.call('ui_upload_update_set', { package: 'CHG-1' });
    assert.equal(r.isError, undefined, text(r));
    assert.equal(JSON.parse(text(r)).remote_update_set.state, 'loaded');
    assert.deepEqual(session.calls, ['withUnlocked']);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('commit refuses without a commit approval and when the approval is stale', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({
    tables: {
      sys_remote_update_set: [{ sys_id: '9'.repeat(32), name: 'CHG-1 update set', state: 'previewed', sys_created_on: '' }],
      sys_update_preview_problem: [],
    },
  });
  const session = fakeSession();
  const gw = gateway(root, mock, { session });
  try {
    const xml = writePackage(root, { state: 'awaiting-human-approval' });
    await approve(root, 'plan', xml);
    await approve(root, 'upload', xml);
    assert.match(text(await gw.call('ui_commit_update_set', { package: 'CHG-1' })), /APPROVAL_MISSING/);
    // A commit approval for an older file is stale, even when the upload
    // approval was renewed for the edited file.
    await approve(root, 'commit', xml);
    writeFileSync(xml, readFileSync(xml, 'utf8').replace('</unload>', '<!-- edit --></unload>'));
    await approve(root, 'upload', xml);
    assert.match(text(await gw.call('ui_commit_update_set', { package: 'CHG-1' })), /APPROVAL_STALE/);
    assert.equal(session.calls.length, 0);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('commit refuses a package of another work item or target', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow();
  const gw = gateway(root, mock);
  try {
    const xml = writePackage(root, { state: 'awaiting-human-approval' });
    writeFileSync(path.join(path.dirname(xml), 'manifest.yaml'), readFileSync(path.join(path.dirname(xml), 'manifest.yaml'), 'utf8').replace(INSTANCE, 'other.service-now.com'));
    assert.match(text(await gw.call('ui_commit_update_set', { package: 'CHG-1' })), /PACKAGE_TARGET_MISMATCH/);
  } finally {
    await gw.close();
    await mock.close();
  }
});

const REMOTE = { sys_id: '9'.repeat(32), name: 'CHG-1 update set', sys_created_on: '' };

function gatewayWith(root, mock, session) {
  return createGateway({
    root, workId: WORK, pack, env,
    clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: mock.fetchImpl }),
    sessionFactory: () => session,
  });
}

function recordingSession() {
  const calls = [];
  return { calls, origin: `https://${INSTANCE}`, withUnlocked: async (_fn, opts) => { calls.push(opts?.onDialog ? 'withUnlocked+dialog' : 'withUnlocked'); }, close: async () => {} };
}

test('preview refuses without a current upload approval', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({ tables: { sys_remote_update_set: [{ ...REMOTE, state: 'loaded' }], sys_update_preview_problem: [] } });
  const session = recordingSession();
  const gw = gatewayWith(root, mock, session);
  try {
    const xml = writePackage(root, { state: 'imported' });
    await approve(root, 'plan', xml);
    assert.match(text(await gw.call('ui_preview_update_set', { package: 'CHG-1' })), /APPROVAL_MISSING/);
    assert.deepEqual(session.calls, []);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('preview with a current upload approval runs unlocked once and returns problems', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const problem = { sys_id: '8'.repeat(32), type: 'error', status: '', description: 'Could not find a record', remote_update_set: REMOTE.sys_id };
  const mock = await startMockServiceNow({ tables: { sys_remote_update_set: [{ ...REMOTE, state: 'previewed' }], sys_update_preview_problem: [problem] } });
  const session = recordingSession();
  const gw = gatewayWith(root, mock, session);
  try {
    const xml = writePackage(root, { state: 'imported' });
    await approve(root, 'plan', xml);
    await approve(root, 'upload', xml);
    const r = await gw.call('ui_preview_update_set', { package: 'CHG-1' });
    assert.equal(r.isError, undefined, text(r));
    assert.deepEqual(JSON.parse(text(r)).problems, [problem]);
    assert.deepEqual(session.calls, ['withUnlocked']);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('commit refuses unresolved preview problems', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({
    tables: {
      sys_remote_update_set: [{ ...REMOTE, state: 'previewed' }],
      sys_update_preview_problem: [{ sys_id: '8'.repeat(32), type: 'error', status: '', description: 'x', remote_update_set: REMOTE.sys_id }],
    },
  });
  const session = recordingSession();
  const gw = gatewayWith(root, mock, session);
  try {
    const xml = writePackage(root, { state: 'awaiting-human-approval' });
    for (const purpose of ['plan', 'upload', 'commit']) await approve(root, purpose, xml);
    assert.match(text(await gw.call('ui_commit_update_set', { package: 'CHG-1' })), /PREVIEW_PROBLEMS/);
    assert.deepEqual(session.calls, []);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('commit passes with a current commit approval and runs unlocked exactly once', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({
    tables: {
      sys_remote_update_set: [{ ...REMOTE, state: 'previewed' }],
      sys_update_preview_problem: [{ sys_id: '8'.repeat(32), type: 'warning', status: 'ignored', description: 'x', remote_update_set: REMOTE.sys_id }],
    },
  });
  const session = recordingSession();
  const gw = gatewayWith(root, mock, session);
  try {
    const xml = writePackage(root, { state: 'awaiting-human-approval' });
    for (const purpose of ['plan', 'upload', 'commit']) await approve(root, purpose, xml);
    const r = await gw.call('ui_commit_update_set', { package: 'CHG-1' });
    assert.equal(r.isError, undefined, text(r));
    const out = JSON.parse(text(r));
    assert.equal(out.committed, 'CHG-1');
    assert.equal(out.approval.approved_by, 'alice');
    assert.deepEqual(session.calls, ['withUnlocked+dialog']);
    assert.ok(mock.requests.every((q) => q.method === 'GET'));
  } finally {
    await gw.close();
    await mock.close();
  }
});
