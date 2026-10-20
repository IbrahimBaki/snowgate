import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { main } from '../src/cli/main.js';
import { snowgateDir } from '../src/workspace.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, PASSWORD, USER, basicAuth, makeProject, startMockServiceNow } from './helpers.js';

// PF-0022: snowgate check verifies stored values on the confirmed target.
const VAR = 'a'.repeat(32);
let mock;
let realFetch;
before(async () => {
  mock = await startMockServiceNow({
    tables: {
      item_option_new: (params) => [{ sys_id: VAR, name: 'preferred_language', mandatory: 'true', default_value: '' }]
        .filter((r) => params.get('sysparm_query') === `sys_id=${r.sys_id}`),
    },
    expectedAuth: basicAuth(),
  });
  // mock.fetchImpl calls the global fetch, so wrap the real one instead.
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).replace(`https://${INSTANCE}`, mock.origin), init);
});
after(() => {
  globalThis.fetch = realFetch;
  return mock.close();
});

async function project() {
  const root = makeProject();
  setCandidate(root, 'PF-0001', INSTANCE);
  await confirmTarget(root, 'PF-0001', { ask: async () => INSTANCE, who: 'Tester', now: new Date('2026-10-20T00:00:00Z') });
  return root;
}

function run(argv, cwd) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  return main(argv, { cwd, env: { SN_USER: USER, SN_PASSWORD: PASSWORD }, stdin: new PassThrough(), stdout, stderr }).then((code) => ({ code, out, err }));
}

test('check passes when every stored value matches, and is audited', async () => {
  const root = await project();
  const r = await run(['check', 'item_option_new', VAR, 'mandatory=true', 'name=preferred_language', 'default_value=', '--work', 'PF-0001'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /All 3 field\(s\) match/);
  const audit = readFileSync(snowgateDir(root, 'audit', 'PF-0001.jsonl'), 'utf8');
  assert.match(audit, /"tool":"check".*"ok":true/);
});

test('check fails on a mismatch and names the stored value', async () => {
  const root = await project();
  const r = await run(['check', 'item_option_new', VAR, 'mandatory=false', '--work', 'PF-0001'], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /MISMATCH {2}mandatory: expected "false", stored "true"/);
});

test('check fails when the record does not exist', async () => {
  const root = await project();
  const r = await run(['check', 'item_option_new', 'b'.repeat(32), 'mandatory=true', '--work', 'PF-0001'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /No item_option_new record/);
});

test('check usage errors: no pairs, a bad pair, or a bad sys_id', async () => {
  const root = await project();
  for (const args of [['item_option_new', VAR], ['item_option_new', VAR, 'mandatory'], ['item_option_new', 'nope', 'a=b']]) {
    const r = await run(['check', ...args, '--work', 'PF-0001'], root);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: snowgate check/);
  }
});
