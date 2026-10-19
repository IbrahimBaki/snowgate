import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { chromium } from 'playwright';
import { profileDir } from '../src/browser-profile.js';
import { main } from '../src/cli/main.js';
import { createGateway } from '../src/gateway/server.js';
import { interactiveLogin } from '../src/login.js';
import { loadPack } from '../src/pack.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, makeProject } from './helpers.js';

// SSO with the dedicated snowgate profile (PF-0005). A local "instance" sends
// unauthenticated browsers to a local "identity provider" on another origin;
// the IdP may send them back with a session cookie.
const WORK = 'PF-0001';
const pack = loadPack();
const headless = (dir, opts) => chromium.launchPersistentContext(dir, { ...opts, headless: true });

function listen(handler) {
  const served = [];
  const server = createServer((req, res) => {
    served.push(req.url);
    handler(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    origin: `http://127.0.0.1:${server.address().port}`, served, close: () => new Promise((r) => server.close(r)),
  })));
}

async function setup({ idpSignsIn = true } = {}) {
  const site = {};
  const idp = await listen((req, res) => {
    if (idpSignsIn) {
      res.writeHead(302, { location: `${site.origin}/sso_callback.do` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<p>identity provider sign-in</p>');
  });
  Object.assign(site, await listen((req, res) => {
    if (req.url === '/sso_callback.do') {
      // Like ServiceNow's JSESSIONID: a session cookie with no expiry.
      res.writeHead(302, { 'set-cookie': 'sess=ok; Path=/; HttpOnly', location: '/home.do' });
      return res.end();
    }
    if (!(req.headers.cookie ?? '').includes('sess=ok')) {
      res.writeHead(302, { location: `${idp.origin}/saml?RelayState=x` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>home</title><h1>Signed in home</h1>');
  }));
  const root = makeProject(WORK);
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
  const env = { SNOWGATE_PROFILE_DIR: mkdtempSync(path.join(tmpdir(), 'snowgate-profiles-')) };
  const gateway = () => createGateway({
    root, workId: WORK, pack, env, originFor: () => site.origin,
    sessionFactory: (opts) => new (opts.BrowserSession ?? BrowserSessionHeadless)(opts),
  });
  return { site, idp, root, env, gateway, close: async () => { await site.close(); await idp.close(); } };
}

// The gateway is headless by default; only `snowgate login` opens a window.
import { BrowserSession } from '../src/playwright/session.js';
class BrowserSessionHeadless extends BrowserSession {}

const text = (r) => r.content[0].text;

test('without a signed-in profile the gateway refuses with NO_SESSION', async () => {
  const env = await setup();
  const gw = env.gateway();
  try {
    const r = await gw.call('ui_navigate', { url: '/home.do' });
    assert.match(text(r), /NO_SESSION/);
    assert.match(text(r), /snowgate login/);
  } finally {
    await gw.close();
    await env.close();
  }
});

test('snowgate login establishes the SSO session; the gateway reuses it with the lock active', { timeout: 60000 }, async () => {
  const env = await setup();
  const gw = env.gateway();
  try {
    const { dir } = await interactiveLogin({
      instance: INSTANCE, origin: env.site.origin, env: env.env, launchPersistent: headless,
      waitForHuman: () => new Promise((r) => setTimeout(r, 500)),
    });
    assert.equal(dir, profileDir(INSTANCE, env.env));
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    const r = await gw.call('ui_navigate', { url: '/home.do' });
    assert.equal(r.isError, undefined, text(r));
    assert.match(JSON.parse(text(r)).url, /\/home\.do$/);
    // The IdP was used by the human login only, never through the gateway.
    const idpHitsAfterLogin = env.idp.served.length;
    const locked = await gw.call('ui_navigate', { url: `${env.idp.origin}/saml` });
    assert.match(text(locked), /HOST_LOCKED/);
    assert.equal(env.idp.served.length, idpHitsAfterLogin);
  } finally {
    await gw.close();
    await env.close();
  }
});

test('an expired SSO session is reported as SESSION_EXPIRED and the IdP is never reached', { timeout: 60000 }, async () => {
  const env = await setup({ idpSignsIn: false });
  mkdirSync(profileDir(INSTANCE, env.env), { recursive: true, mode: 0o700 }); // a profile without a session
  const gw = env.gateway();
  try {
    const r = await gw.call('ui_snapshot', {});
    assert.match(text(r), /SESSION_EXPIRED/);
    assert.deepEqual(env.idp.served, []);
  } finally {
    await gw.close();
    await env.close();
  }
});

test('login fails clearly when the human does not finish signing in', { timeout: 60000 }, async () => {
  const env = await setup({ idpSignsIn: false });
  try {
    await assert.rejects(
      interactiveLogin({ instance: INSTANCE, origin: env.site.origin, env: env.env, launchPersistent: headless, waitForHuman: async () => {} }),
      { code: 'SESSION_NOT_ESTABLISHED' },
    );
  } finally {
    await env.close();
  }
});

test('snowgate login refuses non-interactive input', async () => {
  const root = makeProject(WORK);
  const stdin = new PassThrough();
  stdin.isTTY = false;
  let err = '';
  const code = await main(['login', '--work', WORK], { cwd: root, stdin, stdout: { write: () => {} }, stderr: { write: (s) => (err += s) } });
  assert.equal(code, 1);
  assert.match(err, /interactive terminal/);
});
