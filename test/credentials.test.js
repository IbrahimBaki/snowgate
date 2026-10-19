import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ensureGitignore } from '../src/adapters/install.js';
import { preToolUse } from '../src/adapters/policy.js';
import { main } from '../src/cli/main.js';
import { loadConfig } from '../src/config.js';
import { credentialsFile, credentialsRoot, removeCredentials, resolveCredentials, writeCredentials } from '../src/credentials.js';
import { createGateway } from '../src/gateway/server.js';
import { loadPack } from '../src/pack.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { scanFiles } from '../src/validate/secrets.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, PASSWORD, USER, basicAuth, makeProject, startMockServiceNow } from './helpers.js';

// PF-0008: protected (default) and agent-visible project credential stores.
const WORK = 'PF-0001';
const pack = loadPack();
const isolated = () => ({ SNOWGATE_CREDENTIALS_DIR: mkdtempSync(path.join(tmpdir(), 'snowgate-creds-')), SNOWGATE_PROFILE_DIR: mkdtempSync(path.join(tmpdir(), 'snowgate-prof-')) });
const setMode = (root, yaml) => {
  mkdirSync(path.join(root, '.snowgate'), { recursive: true });
  writeFileSync(path.join(root, '.snowgate', 'config.yaml'), yaml);
};
async function confirmed(root) {
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
}

test('the protected store is the default: an owner-only file outside the project', () => {
  const root = makeProject(WORK);
  const env = isolated();
  assert.equal(loadConfig(root).credentials, 'protected');
  assert.equal(resolveCredentials(root, INSTANCE, { pack, env }).user, null);
  const { file } = writeCredentials(root, INSTANCE, { user: USER, password: PASSWORD, pack, env });
  assert.equal(file, credentialsFile(INSTANCE, env));
  assert.ok(!file.startsWith(root));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(resolveCredentials(root, INSTANCE, { pack, env }), { user: USER, password: PASSWORD, source: 'protected credentials file' });
  // Environment variables win.
  assert.equal(resolveCredentials(root, INSTANCE, { pack, env: { ...env, SN_USER: 'ci', SN_PASSWORD: 'ci-secret' } }).source, 'environment');
  removeCredentials(root, INSTANCE, { pack, env });
  assert.equal(resolveCredentials(root, INSTANCE, { pack, env }).user, null);
});

test('the project store reads .snowgate.env, and removing keeps unrelated lines', () => {
  const root = makeProject(WORK);
  const env = isolated();
  setMode(root, 'credentials: project\n');
  writeFileSync(path.join(root, '.snowgate.env'), `# dev\nOTHER=1\nSN_USER=${USER}\nSN_PASSWORD="${PASSWORD}"\n`);
  assert.deepEqual(resolveCredentials(root, INSTANCE, { pack, env }), { user: USER, password: PASSWORD, source: '.snowgate.env' });
  removeCredentials(root, INSTANCE, { pack, env });
  assert.equal(readFileSync(path.join(root, '.snowgate.env'), 'utf8').includes('OTHER=1'), true);
  assert.equal(resolveCredentials(root, INSTANCE, { pack, env }).user, null);
  writeCredentials(root, INSTANCE, { user: USER, password: 'with space#', pack, env });
  assert.equal(resolveCredentials(root, INSTANCE, { pack, env }).password, 'with space#');
});

test('an unknown credentials mode is a configuration error', () => {
  const root = makeProject(WORK);
  setMode(root, 'credentials: everywhere\n');
  assert.throws(() => loadConfig(root), { code: 'CONFIG_INVALID' });
});

test('agents cannot read the protected store or run credentials set/remove; the project store is visible', () => {
  const root = makeProject(WORK);
  const env = isolated();
  const deny = (tool_name, tool_input) => preToolUse({ tool_name, tool_input, cwd: root }, { root, env });
  assert.match(deny('Read', { file_path: credentialsFile(INSTANCE, env) }), /credential store/);
  assert.match(deny('Bash', { command: `cat ${credentialsRoot(env)}/${INSTANCE}.json` }), /credential store/);
  assert.match(deny('Bash', { command: 'cat ~/.config/snowgate/credentials/x.json' }), /credential store/);
  assert.match(deny('Bash', { command: 'snowgate credentials set --work PF-0001' }), /human-only/);
  assert.match(deny('Bash', { command: 'snowgate credentials remove --work PF-0001' }), /human-only/);
  assert.equal(deny('Bash', { command: 'snowgate credentials show --work PF-0001' }), null);
  assert.equal(deny('Read', { file_path: path.join(root, '.snowgate.env') }), null);
  // The mode itself lives in agent-protected config.
  assert.match(deny('Write', { file_path: path.join(root, '.snowgate', 'config.yaml'), content: 'credentials: project' }), /protected/);
});

test('.snowgate.env is kept out of git: .gitignore entry and commit refusal', () => {
  const root = makeProject(WORK);
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  ensureGitignore(root);
  ensureGitignore(root);
  const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.equal(ignore.split('.snowgate.env').length, 2);
  assert.match(ignore, /^node_modules\//);
  writeFileSync(path.join(root, '.snowgate.env'), 'SN_USER=x\n');
  assert.match(scanFiles(root, ['.snowgate.env'])[0], /never commit/);
});

test('credentials set refuses non-interactive input; show never prints the password', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const env = isolated();
  writeCredentials(root, INSTANCE, { user: USER, password: PASSWORD, pack, env });
  const io = () => {
    const stdin = new PassThrough();
    stdin.isTTY = false;
    const o = { out: '', err: '' };
    return { o, opts: { cwd: root, env, stdin, stdout: { write: (s) => (o.out += s) }, stderr: { write: (s) => (o.err += s) } } };
  };
  const a = io();
  assert.equal(await main(['credentials', 'set', '--work', WORK], a.opts), 1);
  assert.match(a.o.err, /interactive terminal/);
  const b = io();
  assert.equal(await main(['credentials', 'show', '--work', WORK], b.opts), 0);
  assert.match(b.o.out, new RegExp(`user ${USER} from protected credentials file`));
  assert.ok(!b.o.out.includes(PASSWORD));
});

test('the gateway uses the protected store for REST and keeps the password out of audit', async () => {
  const root = makeProject(WORK);
  await confirmed(root);
  const env = isolated();
  const mock = await startMockServiceNow({ tables: { sys_scope: [] }, expectedAuth: basicAuth() });
  let gw = createGateway({ root, workId: WORK, pack, env, clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: mock.fetchImpl }) });
  try {
    // auto (default) without credentials falls back to the browser session,
    // which has no signed-in profile here.
    const noSession = await gw.call('sn_query', { table: 'sys_scope', fields: ['sys_id'] });
    assert.match(noSession.content[0].text, /NO_SESSION/);
    setMode(root, 'rest_auth: basic\n');
    const gwBasic = createGateway({ root, workId: WORK, pack, env, clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: mock.fetchImpl }) });
    const missing = await gwBasic.call('sn_query', { table: 'sys_scope', fields: ['sys_id'] });
    assert.match(missing.content[0].text, /NO_CREDENTIALS.*snowgate credentials set/);
    await gwBasic.close();
    writeCredentials(root, INSTANCE, { user: USER, password: PASSWORD, pack, env });
    setMode(root, 'rest_auth: auto\n');
    await gw.close();
    gw = createGateway({ root, workId: WORK, pack, env, clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: mock.fetchImpl }) });
    const ok = await gw.call('sn_query', { table: 'sys_scope', fields: ['sys_id'] });
    assert.equal(ok.isError, undefined, ok.content[0].text);
    await gw.call('ui_type', { label: 'x', value: `leak ${PASSWORD}` });
    const audit = readFileSync(path.join(root, '.snowgate', 'audit', `${WORK}.jsonl`), 'utf8');
    assert.ok(!audit.includes(PASSWORD));
  } finally {
    await gw.close();
    await mock.close();
  }
});

// --- automatic re-login with ui_auth: password ------------------------------

function startExpiringSite() {
  const state = { sessions: new Set(), logins: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const sid = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const html = (b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body>${b}</body>`); };
    if (url.pathname === '/login.do' && req.method === 'POST') {
      state.logins += 1;
      const id = `s${state.logins}`;
      state.sessions.add(id);
      res.writeHead(302, { 'set-cookie': `sid=${id}; Path=/; HttpOnly`, location: '/home.do' });
      return res.end();
    }
    if (url.pathname === '/login.do') return html('<form method="post" action="/login.do"><input id="user_name"><input id="user_password" type="password"><button id="sysverb_login">Log in</button></form>');
    if (url.pathname === '/expire') { state.sessions.clear(); return html('expired'); }
    if (!sid || !state.sessions.has(sid)) { res.writeHead(302, { location: '/login.do' }); return res.end(); }
    if (url.pathname === '/home.do') return html('<h1>Home</h1><a href="/list.do">List</a>');
    if (url.pathname === '/list.do') return html('<h1>List</h1>');
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

test('with ui_auth: password the gateway signs in again when the instance session ends', { timeout: 60000 }, async () => {
  const site = await startExpiringSite();
  const root = makeProject(WORK);
  await confirmed(root);
  setMode(root, 'credentials: project\nui_auth: password\n');
  writeFileSync(path.join(root, '.snowgate.env'), `SN_USER=${USER}\nSN_PASSWORD=${PASSWORD}\n`);
  const gw = createGateway({ root, workId: WORK, pack, env: isolated(), originFor: () => site.origin });
  const text = (r) => r.content[0].text;
  try {
    const first = await gw.call('ui_navigate', { url: '/home.do' });
    assert.match(JSON.parse(text(first)).url, /\/home\.do$/, text(first));
    assert.equal(site.state.logins, 1);

    site.state.sessions.clear(); // the instance ends the session
    const again = await gw.call('ui_navigate', { url: '/list.do' });
    assert.match(JSON.parse(text(again)).url, /\/list\.do$/, text(again));
    assert.equal(site.state.logins, 2);

    await gw.call('ui_navigate', { url: '/home.do' });
    site.state.sessions.clear();
    const click = await gw.call('ui_click', { role: 'link', name: 'List' });
    assert.match(text(click), /SESSION_RENEWED/);
    assert.equal(site.state.logins, 3);
    assert.ok(!readFileSync(path.join(root, '.snowgate', 'audit', `${WORK}.jsonl`), 'utf8').includes(PASSWORD));
  } finally {
    await gw.close();
    await site.close();
  }
});
