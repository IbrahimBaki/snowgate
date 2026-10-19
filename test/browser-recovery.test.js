import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { BrowserSession } from '../src/playwright/session.js';
import { createAndMakeCurrent } from '../src/playwright/update-sets.js';
import { PASSWORD, USER } from './helpers.js';

// PF-0017: after a dedicated update-set step, and with "leave page?" prompts,
// the gateway browser must still navigate.
const DIRTY = "<script>let dirty=false;document.addEventListener('input',()=>{dirty=true});window.addEventListener('beforeunload',(e)=>{if(dirty){e.preventDefault();e.returnValue='';}});</script>";

function site() {
  const posts = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body>${b}</body>`); };
    if (url.pathname === '/login.do' && req.method === 'POST') { res.writeHead(302, { 'set-cookie': 'S=1; Path=/', location: '/home.do' }); return res.end(); }
    if (url.pathname === '/login.do') return html('<form method="post" action="/login.do"><input id="user_name"><input id="user_password" type="password"><button id="sysverb_login">Log in</button></form>');
    if (url.pathname === '/sys_update_set.do' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { posts.push(body); res.writeHead(302, { location: '/sys_update_set.do?sys_id=' + 'a'.repeat(32) }); res.end(); });
      return;
    }
    // Like ServiceNow: the form is dirty after typing, and the button submits a moment later.
    if (url.pathname === '/sys_update_set.do') return html(`<form id="f" method="post" action="/sys_update_set.do"><input id="sys_update_set.name" name="name"><button type="button" id="sysverb_insert_and_make_current" onclick="dirty=false;setTimeout(()=>document.getElementById('f').submit(),400)">Submit and Make Current</button></form>${DIRTY}`);
    if (url.pathname === '/edit.do') return html(`<label>Title <input name="title"></label>${DIRTY}`);
    if (url.pathname === '/form.do') return html('<button onclick="document.title=\'top\'">Update</button><p>fields</p><button onclick="document.title=\'bottom\'">Update</button>');
    return html(`<h1>${url.pathname}</h1>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ posts, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

test('after ui_use_update_set the browser is free again, and leave-page prompts do not abort navigation', { timeout: 60000 }, async () => {
  const s = await site();
  const session = new BrowserSession({ origin: s.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    await session.withUnlocked((page) => createAndMakeCurrent(page, s.origin, 'PF-0003 - Fix title'));
    assert.equal(s.posts.length, 1, 'the delayed submit was awaited');
    assert.match(s.posts[0], /name=PF-0003/);

    await session.navigate(`${s.origin}/home.do`);
    await session.postCheck();
    assert.match(session.pageUrl(), /\/home\.do$/);

    // A dirty form must not trap the browser.
    await session.navigate(`${s.origin}/edit.do`);
    await session.type({ label: 'Title' }, 'changed');
    await session.navigate(`${s.origin}/other.do`);
    await session.postCheck();
    assert.match(session.pageUrl(), /\/other\.do$/);
  } finally {
    await session.close();
    await s.close();
  }
});

test('a lock violation leaves the browser on a fresh page that can navigate', { timeout: 60000 }, async () => {
  const s = await site();
  const session = new BrowserSession({ origin: s.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    await session.navigate(`${s.origin}/edit.do`);
    await session.type({ label: 'Title' }, 'dirty');
    await session.navigate(`${s.origin}/sys_update_set.do?sys_id=-1`);
    await assert.rejects(session.postCheck(), { code: 'URL_LOCKED' });
    await session.navigate(`${s.origin}/home.do`);
    await session.postCheck();
    assert.match(session.pageUrl(), /\/home\.do$/);
  } finally {
    await session.close();
    await s.close();
  }
});

test('duplicate form buttons: the error says how many matched, and nth picks one', { timeout: 60000 }, async () => {
  const s = await site();
  const session = new BrowserSession({ origin: s.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    await session.navigate(`${s.origin}/form.do`);
    await assert.rejects(session.click({ role: 'button', name: 'Update' }), (e) => e.code === 'LOCATOR_AMBIGUOUS' && /matched 2 elements; pass nth \(0-1\)/.test(e.message));
    await session.click({ role: 'button', name: 'Update', nth: 1 });
    const snap = await session.snapshot();
    assert.ok(snap.length >= 1);
    await assert.rejects(session.click({ role: 'button', name: 'Update', nth: 5 }), { code: 'LOCATOR_AMBIGUOUS' });
  } finally {
    await session.close();
    await s.close();
  }
});
