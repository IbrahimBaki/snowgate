import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { main } from '../src/cli/main.js';
import { makeProject } from './helpers.js';

function run(argv, { cwd, isTTY = false } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = isTTY;
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  return main(argv, { cwd, env: {}, stdin, stdout, stderr }).then((code) => ({ code, out, err }));
}

test('missing --work is a usage error', async () => {
  const { code, err } = await run(['target', 'show'], { cwd: makeProject() });
  assert.equal(code, 2);
  assert.match(err, /--work/);
});

test('init without --agent is a usage error', async () => {
  const { code, err } = await run(['init'], { cwd: makeProject() });
  assert.equal(code, 2);
  assert.match(err, /--agent claude\|codex/);
});

test('target set then show round-trips a candidate only', async () => {
  const cwd = makeProject();
  assert.equal((await run(['target', 'set', 'dev12345.service-now.com', '--work', 'PF-0001'], { cwd })).code, 0);
  const { code, out } = await run(['target', 'show', '--work', 'PF-0001'], { cwd });
  assert.equal(code, 0);
  assert.match(out, /"candidate_instance": "dev12345.service-now.com"/);
  assert.match(out, /"instance": null/);
});

test('target confirm refuses non-interactive input', async () => {
  const cwd = makeProject();
  await run(['target', 'set', 'dev12345.service-now.com', '--work', 'PF-0001'], { cwd });
  const { code, err } = await run(['target', 'confirm', '--work', 'PF-0001'], { cwd, isTTY: false });
  assert.equal(code, 1);
  assert.match(err, /interactive terminal/);
});

test('discover without a confirmed target fails before needing credentials', async () => {
  const cwd = makeProject();
  const { code, err } = await run(['discover', '--work', 'PF-0001'], { cwd });
  assert.equal(code, 1);
  assert.match(err, /no confirmed target/);
});
