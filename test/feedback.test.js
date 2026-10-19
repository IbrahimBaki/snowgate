import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { preToolUse } from '../src/adapters/policy.js';
import { sessionContext } from '../src/adapters/run-hook.js';
import { main } from '../src/cli/main.js';
import { discover } from '../src/discover.js';
import { buildIssue, feedbackRepo, issueUrl, markSent, pendingGaps, readGaps, recordGap, redact } from '../src/feedback.js';
import { createGateway } from '../src/gateway/server.js';
import { loadPack } from '../src/pack.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, ME, PASSWORD, USER, makeProject, schemaTables, startMockServiceNow } from './helpers.js';

// PF-0014: feedback collection, with nothing from the instance.
const WORK = 'PF-0001';
const pack = loadPack();

test('redaction removes instance hosts, sys_ids, e-mail addresses, URLs and paths', () => {
  const out = redact(`dev446072.service-now.com record 6b7b610193c05b1075d9f9fbdd03d6a3 by a.b@acme.io see https://dev1.service-now.com/x.do?sys_id=1 file /home/ibrahim/proj/.snowgate/x`);
  assert.ok(!/service-now|6b7b6101|acme\.io|ibrahim|https/.test(out), out);
  assert.match(out, /<instance> record <sys_id> by <email> see <url> file <path>/);
});

test('gaps are kept once per fingerprint with a count, and come back after new sightings', () => {
  const root = makeProject(WORK);
  recordGap(root, { kind: 'refusal', code: 'FIELD_NOT_ALLOWED', subject: 'sp_instance.widget_parameters', detail: 'first' });
  recordGap(root, { kind: 'refusal', code: 'FIELD_NOT_ALLOWED', subject: 'sp_instance.widget_parameters', detail: 'second' });
  assert.equal(readGaps(root).length, 1);
  assert.equal(readGaps(root)[0].count, 2);
  assert.equal(pendingGaps(root).length, 1);
  markSent(root, [readGaps(root)[0].fingerprint]);
  assert.equal(pendingGaps(root).length, 0);
  recordGap(root, { kind: 'refusal', code: 'FIELD_NOT_ALLOWED', subject: 'sp_instance.widget_parameters' });
  assert.equal(pendingGaps(root).length, 1);
});

test('the issue carries fingerprints and no instance data; the prefilled URL stays within GitHub limits', () => {
  const root = makeProject(WORK);
  recordGap(root, { kind: 'agent-report', code: 'AGENT_REPORT', subject: 'catalog fulfilment', detail: 'No flow found on dev446072.service-now.com for 432d7041930c1b1075d9f9fbdd03d621', suggestion: 'allow sc_cat_item.flow_designer_flow' });
  for (let i = 0; i < 40; i += 1) recordGap(root, { kind: 'refusal', code: 'TABLE_NOT_ALLOWED', subject: `u_table_${i}`, detail: 'x'.repeat(300) });
  const issue = buildIssue(pendingGaps(root));
  assert.match(issue.body, /fingerprint: `AGENT_REPORT:catalog fulfilment`/);
  assert.ok(!/dev446072|432d7041/.test(issue.title + issue.body));
  const url = issueUrl('IbrahimBaki/snowgate-feedback', issue);
  assert.ok(url.startsWith('https://github.com/IbrahimBaki/snowgate-feedback/issues/new?labels=feedback&title='));
  assert.ok(url.length <= 7500);
  assert.equal(feedbackRepo({}), 'IbrahimBaki/snowgate-feedback');
  assert.equal(feedbackRepo({ SNOWGATE_FEEDBACK_REPO: 'someone/else' }), 'someone/else');
  assert.throws(() => feedbackRepo({ SNOWGATE_FEEDBACK_REPO: 'not a repo' }));
});

async function confirmed(root) {
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
}

test('gateway refusals become gaps; sn_report_gap needs no target and keeps no instance data', async () => {
  const root = makeProject(WORK);
  const mock = await startMockServiceNow({ tables: { sys_scope: [], ...schemaTables({ sp_widget: { parent: 'sys_metadata', fields: { name: 'string', token_counter: 'integer' } }, sys_metadata: {} }) } });
  const gw = createGateway({ root, workId: WORK, pack, env: { SN_USER: USER, SN_PASSWORD: PASSWORD }, clientFactory: (o) => new ReadOnlyClient({ ...o, fetchImpl: mock.fetchImpl }) });
  try {
    // No target yet: reporting still works.
    const r = await gw.call('sn_report_gap', { summary: `Cannot see the flow behind a catalog item on ${INSTANCE}`, need: 'to explain what happens after submit', area: 'sc_cat_item.flow_designer_flow' });
    assert.equal(r.isError, undefined, r.content[0].text);
    await confirmed(root);
    // A typo is not a gap; a sensitive-looking refusal is (it may be a false positive).
    await gw.call('sn_get_record', { table: 'sp_widget', sys_id: 'a'.repeat(32), fields: ['secret_sauce'] });
    await gw.call('sn_query', { table: 'sp_widget', fields: ['name', 'token_counter'] });
    await gw.call('sn_query', { table: 'sys_user_session', fields: ['sys_id'] });
    await gw.call('browser_evaluate', {});
    const codes = readGaps(root).map((g) => g.fingerprint).sort();
    assert.deepEqual(codes, ['AGENT_REPORT:sc_cat_item.flow_designer_flow', 'FIELD_SENSITIVE:sp_widget.secret_sauce', 'FIELD_SENSITIVE:sp_widget.token_counter', 'TABLE_SENSITIVE:sys_user_session', 'TOOL_UNKNOWN:tool browser_evaluate']);
    assert.ok(!JSON.stringify(readGaps(root)).includes(INSTANCE));
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('discover records unreadable tables as gaps', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const mock = await startMockServiceNow({ tables: { sys_user: [{ sys_id: ME, user_name: USER }], sys_user_has_role: [], sys_properties: [], sys_update_set: [], sys_update_xml: [], sys_user_preference: [], sys_remote_update_set: [] }, forbidden: ['sys_hub_flow'] });
  try {
    await discover({ root, workId: WORK, client: new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl, pattern: pack.instancePattern }), pattern: pack.instancePattern });
    assert.ok(readGaps(root).some((g) => g.fingerprint === 'TABLE_ACCESS:sys_hub_flow'));
  } finally {
    await mock.close();
  }
});

test('feedback list is open to agents, send is human-only; sessions remind about unsent gaps', async () => {
  const root = makeProject(WORK);
  recordGap(root, { kind: 'refusal', code: 'TABLE_NOT_ALLOWED', subject: 'u_course' });
  const deny = (command) => preToolUse({ tool_name: 'Bash', tool_input: { command }, cwd: root }, { root, env: {} });
  assert.equal(deny('snowgate feedback list'), null);
  assert.match(deny('snowgate feedback send'), /human-only/);
  let out = '';
  assert.equal(await main(['feedback', 'list'], { cwd: root, stdout: { write: (s) => (out += s) }, stderr: { write: () => {} } }), 0);
  assert.match(out, /1 gap\(s\) waiting to be sent to IbrahimBaki\/snowgate-feedback/);
  const stdin = new PassThrough();
  stdin.isTTY = false;
  let err = '';
  assert.equal(await main(['feedback', 'send'], { cwd: root, stdin, stdout: { write: () => {} }, stderr: { write: (s) => (err += s) } }), 1);
  assert.match(err, /interactive terminal/);
  assert.match(sessionContext(root, {}), /1 feedback gap\(s\) have not been sent/);
});
