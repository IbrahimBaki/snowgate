import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createGateway } from '../src/gateway/server.js';
import { deepDecode, lockedToken } from '../src/gateway/guards.js';
import { loadPack } from '../src/pack.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, PASSWORD, USER, makeProject } from './helpers.js';

// A real Chromium against a local stand-in for the instance (AC-003). The
// fixture logs every path it serves, so "never served" proves the request was
// aborted in the browser, whatever frame or wrapper it came from.
const WORK = 'PF-0001';
const pack = loadPack();

function startSite(pages, redirects = {}) {
  const served = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    served.push(url.pathname + url.search);
    if (redirects[url.pathname]) {
      res.writeHead(302, { location: redirects[url.pathname]() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/login.do') {
      res.writeHead(302, { location: '/home.do' });
      return res.end();
    }
    const body = pages[url.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(typeof body === 'function' ? body() : body ?? '<p>not found</p>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    resolve({ origin, served, close: () => new Promise((r) => server.close(r)) });
  }));
}

const page = (title, body) => `<!doctype html><title>${title}</title><body>${body}</body>`;

async function setup() {
  const off = await startSite({ '/': page('elsewhere', '<p>off target</p>') });
  const NX = `/now/nav/ui/classic/params/target/${encodeURIComponent('sys_remote_update_set_list.do?sysparm_query=state%3Dloaded')}`;
  const site = await startSite({
    '/login.do': page('login', '<form method="post" action="/login.do"><input id="user_name" name="u"><input id="user_password" name="p" type="password"><button id="sysverb_login" type="submit">Log in</button></form>'),
    '/home.do': page('home', `
      <h1>Home</h1>
      <a href="/sys_remote_update_set_list.do">Retrieved update sets</a>
      <a href="${NX}">Next Experience update sets</a>
      <a href="${off.origin}/">Somewhere else</a>
      <label>Search <input name="q"></label>
      <label>Secret <input name="pw" type="password"></label>
      <iframe name="gsft_main" src="/incident_list.do"></iframe>`),
    '/incident_list.do': page('incidents', '<p>list</p>'),
    '/frame-locked.do': page('frame', '<iframe name="gsft_main" src="/sys_update_set.do?sys_id=0123456789abcdef0123456789abcdef"></iframe>'),
    '/nav-wrapper.do': page('wrap', `<iframe name="gsft_main" src="/nav_to.do?uri=${encodeURIComponent(encodeURIComponent('sys_remote_update_set.do?sys_id=1'))}"></iframe>`),
    '/sw-page.do': page('sw', `<p id="s">pending</p><script>
      navigator.serviceWorker.register('/sw.js').then(() => { document.getElementById('s').textContent = 'registered'; },
        (e) => { document.getElementById('s').textContent = 'refused'; });
    </script>`),
    '/sw.js': () => "self.addEventListener('install', (e) => e.waitUntil(fetch('/sys_update_set.do?via=sw').catch(() => {})));",
    '/sys_remote_update_set_list.do': page('LOCKED', '<p>locked</p>'),
    '/sys_update_set.do': page('LOCKED', '<p>locked</p>'),
    '/img-redirect.do': page('img', '<img src="/redirect-off.do">'),
  }, {
    '/redirect-off.do': () => `${off.origin}/`,
    '/redirect-locked.do': () => '/sys_update_set.do?sys_id=1',
  });
  const root = makeProject(WORK);
  // This fixture exercises the password form; SSO profiles are covered in sso-profile.test.js.
  mkdirSync(path.join(root, '.snowgate'), { recursive: true });
  writeFileSync(path.join(root, '.snowgate', 'config.yaml'), 'ui_auth: password\n');
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
  const gw = createGateway({ root, workId: WORK, pack, env: { SN_USER: USER, SN_PASSWORD: PASSWORD }, originFor: () => site.origin });
  const lockedServed = () => site.served.filter((p) => /update_set|nav_to\.do|\/now\/nav/.test(p));
  return { site, off, gw, NX, lockedServed, close: async () => { await gw.close(); await site.close(); await off.close(); } };
}

const text = (r) => r.content[0].text;

test('guards decode Next Experience and nav_to wrappers', () => {
  assert.equal(lockedToken(`/now/nav/ui/classic/params/target/${encodeURIComponent('sys_remote_update_set.do?sys_id=1')}`), 'sys_remote_update_set');
  assert.equal(lockedToken(`/nav_to.do?uri=${encodeURIComponent(encodeURIComponent('sys_update_preview_xml.do'))}`), 'sys_update_preview');
  assert.equal(lockedToken('/xmlhttp.do', 'sysparm_processor=UpdateSetCommitAjaxProcessor'), 'updateset');
  assert.equal(lockedToken('/incident_list.do'), null);
  assert.equal(deepDecode('%2520'), ' ');
});

test('the browser lock holds for top-level, iframe, wrapper, click and off-target navigation', { timeout: 90000 }, async (t) => {
  const env = await setup();
  try {
    await t.test('a normal page with a gsft_main iframe opens', async () => {
      const r = await env.gw.call('ui_navigate', { url: '/home.do' });
      assert.equal(r.isError, undefined, text(r));
      const { frames } = JSON.parse(text(r));
      assert.ok(frames.some((f) => f.name === 'gsft_main' && f.url.endsWith('/incident_list.do')));
    });

    await t.test('top-level navigation to a locked page is refused', async () => {
      const r = await env.gw.call('ui_navigate', { url: '/sys_remote_update_set_list.do' });
      assert.equal(r.isError, true);
      assert.match(text(r), /URL_LOCKED/);
    });

    await t.test('a Next Experience-encoded locked target is refused', async () => {
      const r = await env.gw.call('ui_navigate', { url: env.NX });
      assert.match(text(r), /URL_LOCKED/);
    });

    await t.test('a locked page inside the gsft_main iframe is aborted', async () => {
      const r = await env.gw.call('ui_navigate', { url: '/frame-locked.do' });
      assert.match(text(r), /URL_LOCKED/);
      const w = await env.gw.call('ui_navigate', { url: '/nav-wrapper.do' });
      assert.match(text(w), /URL_LOCKED/);
    });

    await t.test('clicking a link to a locked page is refused', async () => {
      const nav = await env.gw.call('ui_navigate', { url: '/home.do' });
      assert.equal(nav.isError, undefined, text(nav));
      const r = await env.gw.call('ui_click', { role: 'link', name: 'Retrieved update sets' });
      assert.match(text(r), /URL_LOCKED/);
      await env.gw.call('ui_navigate', { url: '/home.do' });
      const nx = await env.gw.call('ui_click', { role: 'link', name: 'Next Experience update sets' });
      assert.match(text(nx), /URL_LOCKED/);
    });

    await t.test('off-target hosts are refused, by URL and by click', async () => {
      const r = await env.gw.call('ui_navigate', { url: `${env.off.origin}/` });
      assert.match(text(r), /HOST_LOCKED/);
      await env.gw.call('ui_navigate', { url: '/home.do' });
      const c = await env.gw.call('ui_click', { role: 'link', name: 'Somewhere else' });
      assert.match(text(c), /HOST_LOCKED/);
      assert.deepEqual(env.off.served, []);
    });

    await t.test('redirects to an off-target host or a locked page are refused', async () => {
      const o = await env.gw.call('ui_navigate', { url: '/redirect-off.do' });
      assert.match(text(o), /HOST_LOCKED/);
      const l = await env.gw.call('ui_navigate', { url: '/redirect-locked.do' });
      assert.match(text(l), /URL_LOCKED/);
      await env.gw.call('ui_navigate', { url: '/img-redirect.do' }); // a subresource redirect is aborted too
      assert.deepEqual(env.off.served, []);
    });

    await t.test('typing works, but never into a password field', async () => {
      const nav = await env.gw.call('ui_navigate', { url: '/home.do' });
      assert.equal(nav.isError, undefined, text(nav));
      const ok = await env.gw.call('ui_type', { label: 'Search', value: 'abc' });
      assert.equal(ok.isError, undefined, text(ok));
      const pw = await env.gw.call('ui_type', { label: 'Secret', value: 'abc' });
      assert.match(text(pw), /PASSWORD_FIELD/);
    });

    await t.test('a service worker cannot be registered to bypass the lock', async () => {
      const r = await env.gw.call('ui_navigate', { url: '/sw-page.do' });
      assert.equal(r.isError, undefined, text(r));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // Service workers are blocked outright: the script is never fetched, so
      // nothing it would request can escape the route handler.
      assert.ok(!env.site.served.includes('/sw.js'));
      assert.ok(!env.site.served.some((p) => p.includes('via=sw')));
    });

    await t.test('no locked page was ever served', () => {
      assert.deepEqual(env.lockedServed(), []);
    });
  } finally {
    await env.close();
  }
});
