import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGateway } from '../src/gateway/server.js';
import { loadPack } from '../src/pack.js';
import { BrowserSession } from '../src/playwright/session.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, ME, PASSWORD, USER, makeProject } from './helpers.js';

// PF-0010: REST through the browser session when Basic auth is refused.
const WORK = 'PF-0001';
const pack = loadPack();
const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('auto tries Basic, switches to the session on 401, and stays there', async () => {
  const basic = [];
  const session = [];
  const client = new ReadOnlyClient({
    instance: INSTANCE, user: USER, password: PASSWORD, mode: 'auto',
    fetchImpl: async (url, init) => { basic.push(init); return json(401, {}); },
    sessionFetch: async (url, init) => { session.push(init); return json(200, { result: [{ sys_id: '1' }] }); },
  });
  assert.equal(client.authMode, 'basic');
  await client.query('sys_scope', { fields: ['sys_id'] });
  await client.query('sys_scope', { fields: ['sys_id'] });
  assert.equal(basic.length, 1);
  assert.equal(session.length, 2);
  assert.equal(client.authMode, 'session');
  assert.ok(session.every((i) => i.method === 'GET' && !('Authorization' in i.headers)));
});

test('auto keeps Basic when it works, and session mode never sends a password', async () => {
  let sessionCalls = 0;
  const ok = new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, mode: 'auto', fetchImpl: async () => json(200, { result: [] }), sessionFetch: async () => { sessionCalls += 1; return json(200, { result: [] }); } });
  await ok.query('sys_scope', { fields: ['sys_id'] });
  assert.equal(sessionCalls, 0);

  const sent = [];
  const s = new ReadOnlyClient({ instance: INSTANCE, mode: 'session', fetchImpl: async () => assert.fail('Basic used'), sessionFetch: async (url, init) => { sent.push(url); return json(200, { result: [{ sys_id: ME, user_name: 'sso.user' }] }); } });
  const me = await s.whoami();
  assert.equal(me.user_name, 'sso.user');
  assert.match(decodeURIComponent(sent[0]), /sys_id=javascript:gs\.getUserID\(\)/);
});

// A stand-in instance that, like dev446072, refuses Basic auth on the Table
// API but accepts the UI session cookie plus X-UserToken.
function startInstance() {
  const seen = { basic: 0, session: 0, tokenFetches: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie ?? '';
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (url.pathname === '/login.do' && req.method === 'POST') {
      res.writeHead(302, { 'set-cookie': 'JSESSIONID=ok; Path=/; HttpOnly', location: '/navpage.do' });
      return res.end();
    }
    if (url.pathname === '/login.do') return send(200, 'text/html', '<form method="post" action="/login.do"><input id="user_name"><input id="user_password" type="password"><button id="sysverb_login">Log in</button></form>');
    // Like newer instances: navpage.do redirects to the Next Experience shell.
    if (url.pathname === '/navpage.do') { res.writeHead(302, { location: '/now/nav/ui/home' }); return res.end(); }
    if (url.pathname === '/now/nav/ui/home') {
      if (!cookie.includes('JSESSIONID=ok')) { res.writeHead(302, { location: '/login.do' }); return res.end(); }
      if (!(req.headers.accept ?? '').includes('text/html')) seen.tokenFetches += 1; // not the browser's own page load
      return send(200, 'text/html', "<script>var g_ck = 'tok-123';</script><h1>Home</h1>");
    }
    if (url.pathname.startsWith('/api/now/table/')) {
      if (req.headers.authorization) { seen.basic += 1; return send(401, 'application/json', JSON.stringify({ error: { message: 'User is not authenticated' } })); }
      if (cookie.includes('JSESSIONID=ok') && req.headers['x-usertoken'] === 'tok-123' && req.method === 'GET') {
        seen.session += 1;
        return send(200, 'application/json', JSON.stringify({ result: [{ sys_id: 'a'.repeat(32), scope: 'x_demo', name: 'Demo', version: '1', active: 'true' }] }));
      }
      return send(401, 'application/json', '{}');
    }
    send(404, 'text/plain', 'no');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ seen, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

test('BrowserSession.restFetch: GET only, target origin only, X-UserToken from the UI', { timeout: 60000 }, async () => {
  const site = await startInstance();
  const session = new BrowserSession({ origin: site.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    const r = await session.restFetch(`${site.origin}/api/now/table/sys_scope?sysparm_fields=sys_id`, { headers: { Accept: 'application/json', Authorization: 'Basic x' } });
    assert.equal(r.status, 200);
    assert.equal(site.seen.basic, 0, 'the Authorization header is dropped on the session path');
    await assert.rejects(session.restFetch('https://elsewhere.example/api/now/table/x'), { code: 'HOST_LOCKED' });
    await assert.rejects(session.restFetch(`${site.origin}/api/now/table/x`, { method: 'POST' }), { code: 'METHOD_NOT_ALLOWED' });
  } finally {
    await session.close();
    await site.close();
  }
});

test('the gateway REST tools work on an instance that refuses Basic auth (rest_auth auto)', { timeout: 60000 }, async () => {
  const site = await startInstance();
  const root = makeProject(WORK);
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
  mkdirSync(path.join(root, '.snowgate'), { recursive: true });
  writeFileSync(path.join(root, '.snowgate', 'config.yaml'), 'credentials: project\nui_auth: password\n');
  writeFileSync(path.join(root, '.snowgate.env'), `SN_USER=${USER}\nSN_PASSWORD=${PASSWORD}\n`);
  // The client builds https://<instance> URLs; point them (and the session) at the fixture.
  const rewrite = (url) => String(url).replace(`https://${INSTANCE}`, site.origin);
  const gw = createGateway({
    root, workId: WORK, pack, env: { SNOWGATE_PROFILE_DIR: mkdtempSync(path.join(tmpdir(), 'p-')) }, originFor: () => site.origin,
    clientFactory: (opts) => new ReadOnlyClient({ ...opts, fetchImpl: (url, init) => fetch(rewrite(url), init), sessionFetch: (url, init) => opts.sessionFetch(new URL(rewrite(url)), init) }),
  });
  try {
    const r = await gw.call('sn_query', { table: 'sys_scope', fields: ['sys_id', 'scope'] });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(JSON.parse(r.content[0].text).records[0].scope, 'x_demo');
    assert.equal(site.seen.basic, 1);
    assert.equal(site.seen.session, 1);
    await gw.call('sn_query', { table: 'sys_scope', fields: ['sys_id'] });
    assert.equal(site.seen.basic, 1, 'Basic is not retried once refused');
    assert.equal(site.seen.tokenFetches, 1, 'the token is reused');
  } finally {
    await gw.close();
    await site.close();
  }
});
