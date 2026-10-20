import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { updateSetTitle, updateSetNameFor } from '../src/gateway/tools.js';
import { BrowserSession } from '../src/playwright/session.js';
import { PASSWORD, USER, makeProject } from './helpers.js';

// PF-0023: a general post-save return notice; shortened names end on a word.

test('a shortened update-set name does not end on a short word and says it was shortened', () => {
  const root = makeProject('PF-0008');
  const r = updateSetTitle(root, 'PF-0008', 'Add French choice to preferred_language variable of Register for EduPulse catalog item');
  assert.equal(r.shortened, true);
  assert.ok(r.name.length <= 80, r.name);
  assert.equal(r.name, 'PF-0008 - Add French choice to preferred_language variable of Register');
  assert.deepEqual(updateSetTitle(root, 'PF-0008', 'Add French'), { name: 'PF-0008 - Add French', shortened: false });
  // Several short words in a row are all dropped.
  assert.match(updateSetNameFor(root, 'PF-0008', `${'word '.repeat(13)}and of the ${'x'.repeat(20)}`), /word$/);
});

// A related list's New opens the child form; Submit saves it and redirects to
// the parent form (the previous page). A failed save stays on the child form.
function site() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body>${b}</body>`); };
    if (url.pathname === '/login.do' && req.method === 'POST') { res.writeHead(302, { 'set-cookie': 'S=1; Path=/', location: '/home.do' }); return res.end(); }
    if (url.pathname === '/login.do') return html('<form method="post" action="/login.do"><input id="user_name"><input id="user_password" type="password"><button id="sysverb_login">Log in</button></form>');
    if (url.pathname === '/question_choice.do' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      return req.on('end', () => {
        if (!new URLSearchParams(body).get('text')) return html('<p>Text is mandatory</p><form method="post" action="/question_choice.do"><label for="t">Text</label><input id="t" name="text"><button type="submit">Submit</button></form>');
        res.writeHead(302, { location: '/item_option_new.do?sys_id=1' });
        return res.end();
      });
    }
    if (url.pathname === '/question_choice.do') return html('<form method="post" action="/question_choice.do"><label for="t">Text</label><input id="t" name="text"><button type="submit">Submit</button></form>');
    if (url.pathname === '/item_option_new.do') return html('<h1>Variable</h1><a href="/question_choice.do?sys_id=-1">New</a>');
    return html(`<h1>${url.pathname}</h1>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

test('a submit that returns to the previous page is a notice; one that stays on the form is not', { timeout: 60000 }, async () => {
  const s = await site();
  const session = new BrowserSession({ origin: s.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    await session.navigate(`${s.origin}/item_option_new.do?sys_id=1`);
    await session.click({ role: 'link', name: 'New' });
    await session.postCheck({ afterAction: true });
    assert.equal(session.takeNotice(), null, 'following a link is no submit');

    // Failed save: the instance shows the same form again.
    await session.click({ role: 'button', name: 'Submit' });
    await session.postCheck({ afterAction: true });
    assert.equal(session.takeNotice(), null);

    await session.type({ label: 'Text' }, 'French');
    await session.click({ role: 'button', name: 'Submit' });
    await session.postCheck({ afterAction: true });
    const notice = session.takeNotice();
    assert.match(notice, /Submitted question_choice\.do; ServiceNow then returned to its previous page \(item_option_new\.do\?sys_id=1\)/);
    assert.match(notice, /snowgate check/);
  } finally {
    await session.close();
    await s.close();
  }
});
