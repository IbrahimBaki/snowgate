import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateway, normalizeArgs, signature } from '../src/gateway/server.js';
import { TOOLS } from '../src/gateway/tools.js';
import { loadPack } from '../src/pack.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, PASSWORD, USER, makeProject, startMockServiceNow } from './helpers.js';

// PF-0019: fewer wasted calls from guessed parameters.
const tool = (name) => TOOLS.find((t) => t.name === name);

test('a comma-separated fields string becomes a list; numbers in strings become integers', () => {
  assert.deepEqual(normalizeArgs(tool('sn_query'), { table: 'sp_widget', fields: 'name, sys_id', limit: '5' }), { table: 'sp_widget', fields: ['name', 'sys_id'], limit: 5 });
});

test('aliases map common slips, but never override the real parameter', () => {
  assert.deepEqual(normalizeArgs(tool('ui_use_update_set'), { name: 'Fix title' }), { title: 'Fix title' });
  assert.deepEqual(normalizeArgs(tool('ui_screenshot'), { name: 'after' }), { label: 'after' });
  assert.deepEqual(normalizeArgs(tool('sn_update_set_contents'), { sys_id: 'a'.repeat(32) }), { update_set: 'a'.repeat(32) });
  // The real parameter wins; the leftover alias is dropped as unknown.
  const both = normalizeArgs(tool('ui_use_update_set'), { name: 'x', title: 'y' });
  assert.deepEqual(both, { title: 'y' });
  assert.deepEqual(both._ignored, ['name']);
  // ui_type's own `text` locates by visible text; it is not an alias of value.
  assert.deepEqual(normalizeArgs(tool('ui_type'), { text: 'Search', value: 'abc' }), { text: 'Search', value: 'abc' });
});

test('argument errors state the expected parameters', async () => {
  assert.match(signature(tool('sn_query')), /^table \(string, required\), fields \(array of string, required\), query \(string\), limit \(integer\)$/);
  const root = makeProject('PF-0001');
  setCandidate(root, 'PF-0001', INSTANCE, loadPack().instancePattern);
  await confirmTarget(root, 'PF-0001', { ask: async () => INSTANCE, who: 'alice' });
  const mock = await startMockServiceNow({ tables: { sys_scope: [{ sys_id: '1' }] } });
  const gw = createGateway({ root, workId: 'PF-0001', pack: loadPack(), env: { SN_USER: USER, SN_PASSWORD: PASSWORD }, clientFactory: (o) => new ReadOnlyClient({ ...o, fetchImpl: mock.fetchImpl }) });
  try {
    const bad = await gw.call('sn_get_record', { table: 'sys_scope' });
    assert.match(bad.content[0].text, /ARGS_INVALID.*Expected: table \(string, required\), sys_id \(string, required\), fields \(array of string, required\)/);
    const ok = await gw.call('sn_query', { table: 'sys_scope', fields: 'sys_id' });
    assert.equal(ok.isError, undefined, ok.content[0].text);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('PF-0021: unknown parameters are dropped and reported; screenshot label defaults; text means value next to a locator', () => {
  const extra = normalizeArgs(tool('ui_use_update_set'), { create: 'true', title: 'Fix' });
  assert.deepEqual(extra, { title: 'Fix' });
  assert.deepEqual(extra._ignored, ['create']);
  assert.deepEqual(normalizeArgs(tool('ui_screenshot'), {}), { label: 'screenshot' });
  assert.deepEqual(normalizeArgs(tool('ui_type'), { role: 'textbox', name: 'Default value', text: '' }), { role: 'textbox', name: 'Default value', value: '' });
});
