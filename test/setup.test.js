import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { preToolUse } from '../src/adapters/policy.js';
import { main } from '../src/cli/main.js';
import { loadConfig, updateConfig } from '../src/config.js';
import { resolveCredentials } from '../src/credentials.js';
import { loadPack } from '../src/pack.js';
import { setup } from '../src/setup.js';
import { readWork, requireConfirmedTarget, setCandidate } from '../src/work.js';
import { INSTANCE, makeProject } from './helpers.js';

// PF-0009: project-approved instances and `snowgate setup`.
const WORK = 'PF-0001';
const pack = loadPack();
const env = () => ({ SNOWGATE_CREDENTIALS_DIR: mkdtempSync(path.join(tmpdir(), 'snowgate-creds-')), SNOWGATE_PROFILE_DIR: mkdtempSync(path.join(tmpdir(), 'snowgate-prof-')) });
const approve = (root, instance = INSTANCE) => updateConfig(root, { approved_instances: [{ instance, approved_by: 'alice', approved_at: '2026-10-19T00:00:00.000Z' }] });

test('target set on an approved instance confirms automatically, under the approver', () => {
  const root = makeProject(WORK);
  approve(root);
  const work = setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  assert.equal(work.target.instance, INSTANCE);
  assert.equal(work.target.confirmed_by, 'alice');
  assert.equal(work.target.confirmation.via, 'approved_instances');
  assert.equal(requireConfirmedTarget(root, WORK), INSTANCE);
});

test('an instance that is not approved stays a candidate', () => {
  const root = makeProject(WORK);
  approve(root);
  const work = setCandidate(root, WORK, 'prod1.service-now.com', pack.instancePattern);
  assert.equal(work.target.instance, null);
  assert.throws(() => requireConfirmedTarget(root, WORK), { code: 'TARGET_UNCONFIRMED' });
});

test('removing an instance from the approved list revokes targets that rested on it', () => {
  const root = makeProject(WORK);
  approve(root);
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  updateConfig(root, { approved_instances: [] });
  assert.throws(() => requireConfirmedTarget(root, WORK), { code: 'TARGET_UNCONFIRMED' });
});

test('the CLI target set reports the automatic confirmation', async () => {
  const root = makeProject(WORK);
  approve(root);
  let out = '';
  const code = await main(['target', 'set', INSTANCE, '--work', WORK], { cwd: root, stdout: { write: (s) => (out += s) }, stderr: { write: () => {} } });
  assert.equal(code, 0);
  assert.match(out, /confirmed: approved for this project by alice/);
});

test('agents cannot run setup or edit the approved list', () => {
  const root = makeProject(WORK);
  const deny = (tool_name, tool_input) => preToolUse({ tool_name, tool_input, cwd: root }, { root, env: env() });
  assert.match(deny('Bash', { command: 'snowgate setup' }), /human-only/);
  assert.match(deny('Edit', { file_path: path.join(root, '.snowgate', 'config.yaml'), old_string: 'a', new_string: 'b' }), /protected/);
});

// Tests never contact an instance: the access check is faked.
const okBasic = async () => ({ status: 'basic', message: 'REST works (Basic auth).' });

function scripted(answers) {
  const asked = [];
  const next = async (q) => {
    asked.push(q);
    assert.ok(answers.length, `unexpected question: ${q}`);
    return answers.shift();
  };
  return { asked, ask: next, askHidden: next };
}

test('setup in dev mode: four questions, then an agent can bind and use the instance', async () => {
  const root = makeProject(WORK);
  const e = env();
  writeFileSync(path.join(root, '.snowgate.env'), 'OTHER=keep\n');
  const s = scripted(['', 'dev446072', 'y', 'admin', 'pdi-pass']);
  const lines = [];
  const result = await setup({ root, pack, env: e, who: 'ibrahim', ask: s.ask, askHidden: s.askHidden, out: (l) => lines.push(l), chromiumInstalled: () => true, check: okBasic });
  assert.equal(s.asked.length, 5); // agent, instances, dev?, user, password
  assert.equal(result.agent, 'claude');
  const config = loadConfig(root);
  assert.deepEqual(config.approved_instances.map((a) => [a.instance, a.approved_by]), [['dev446072.service-now.com', 'ibrahim']]);
  assert.equal(config.credentials, 'project');
  assert.equal(config.ui_auth, 'password');
  const envFile = readFileSync(path.join(root, '.snowgate.env'), 'utf8');
  assert.match(envFile, /OTHER=keep/);
  assert.deepEqual(resolveCredentials(root, 'dev446072.service-now.com', { pack, env: e }), { user: 'admin', password: 'pdi-pass', source: '.snowgate.env' });
  assert.ok(existsSync(path.join(root, '.claude', 'skills', 'snowgate', 'hook.mjs')));
  assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.snowgate\.env/);
  assert.match(lines.at(-1), /Run snowgate discover on dev446072\.service-now\.com/);
  // What an agent then does on its own, with no human step:
  setCandidate(root, WORK, 'dev446072.service-now.com', pack.instancePattern);
  assert.equal(readWork(root, WORK).target.confirmed_by, 'ibrahim');

  // A second run keeps the approval and the saved password when answers are empty.
  const again = scripted(['', '', '', '', '']);
  await setup({ root, pack, env: e, who: 'someone-else', ask: again.ask, askHidden: again.askHidden, out: () => {}, chromiumInstalled: () => true, check: okBasic });
  assert.equal(loadConfig(root).approved_instances[0].approved_by, 'ibrahim');
  assert.equal(resolveCredentials(root, 'dev446072.service-now.com', { pack, env: e }).password, 'pdi-pass');
});

test('setup with SSO: protected store, REST credentials optional, sign-in offered per instance', async () => {
  const root = makeProject(WORK);
  const e = env();
  const logins = [];
  const s = scripted(['codex', 'dev1, dev2.service-now.com', 'n', 'y', 'svc', 'svc-pass', '', 'y', 'n']);
  const result = await setup({ root, pack, env: e, who: 'ibrahim', ask: s.ask, askHidden: s.askHidden, out: () => {}, chromiumInstalled: () => true, login: async (i) => logins.push(i), check: async (o) => (o.user ? { status: 'missing', message: 'sso' } : { status: 'session', message: 'REST works through the signed-in browser session.' }) });
  assert.equal(result.agent, 'codex');
  assert.equal(loadConfig(root).credentials, 'protected');
  assert.equal(loadConfig(root).ui_auth, 'profile');
  assert.equal(resolveCredentials(root, 'dev1.service-now.com', { pack, env: e }).source, 'protected credentials file');
  assert.equal(resolveCredentials(root, 'dev2.service-now.com', { pack, env: e }).user, null); // skipped
  assert.deepEqual(logins, ['dev1.service-now.com']);
  assert.ok(!existsSync(path.join(root, '.snowgate.env')));
  assert.ok(existsSync(path.join(root, '.codex', 'config.toml')));
});

test('setup refuses non-interactive input', async () => {
  const root = makeProject(WORK);
  const stdin = new PassThrough();
  stdin.isTTY = false;
  let err = '';
  assert.equal(await main(['setup'], { cwd: root, stdin, stdout: { write: () => {} }, stderr: { write: (s) => (err += s) } }), 1);
  assert.match(err, /interactive terminal/);
});

test('setup asks again when the instance rejects the password, and says when REST will use the session', async () => {
  const root = makeProject(WORK);
  const e = env();
  const tries = [];
  const check = async ({ password }) => {
    tries.push(password);
    return password === 'right' ? { status: 'session', message: 'Signed in, but dev1.service-now.com refuses Basic auth for REST; snowgate will use the browser session for REST (checked: works).' } : { status: 'rejected', message: 'dev1.service-now.com rejected the user name or password.' };
  };
  const s = scripted(['', 'dev1', 'y', 'admin', 'wrong', 'right']);
  const lines = [];
  await setup({ root, pack, env: e, who: 'ibrahim', ask: s.ask, askHidden: s.askHidden, out: (l) => lines.push(l), chromiumInstalled: () => true, check });
  assert.deepEqual(tries, ['wrong', 'right']);
  assert.ok(lines.some((l) => /rejected the user name or password\. Try again\./.test(l)));
  assert.ok(lines.some((l) => /refuses Basic auth for REST; snowgate will use the browser session/.test(l)));
  assert.equal(resolveCredentials(root, 'dev1.service-now.com', { pack, env: e }).password, 'right');
});
