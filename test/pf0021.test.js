import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { preToolUse } from '../src/adapters/policy.js';
import { main } from '../src/cli/main.js';
import { SnowgateError } from '../src/errors.js';
import { clearGaps, gapsFromError, readGaps, recordGap } from '../src/feedback.js';
import { updateSetNameFor } from '../src/gateway/tools.js';
import { BrowserSession } from '../src/playwright/session.js';
import { PASSWORD, USER, makeProject } from './helpers.js';

// PF-0021: six fixes from the PF-0006 trial.

test('update-set names: no doubled work id, cut at a word within 80 characters', () => {
  const root = makeProject('PF-0006');
  assert.equal(updateSetNameFor(root, 'PF-0006', 'PF-0006 - Remove Arabic default'), 'PF-0006 - Remove Arabic default');
  assert.equal(updateSetNameFor(root, 'PF-0006', 'pf-0006: Remove it'), 'PF-0006 - Remove it');
  const long = updateSetNameFor(root, 'PF-0006', 'Remove Arabic default and add -- Select -- option to Preferred language on Register for EduPulse');
  assert.ok(long.length <= 80, long);
  assert.ok(!/ lan$/.test(long) && /\w$/.test(long), long);
  writeFileSync(path.join(root, '.yallaflow', 'work', 'PF-0006', 'meta.yaml'), 'title: Fix the title\n');
  assert.equal(updateSetNameFor(root, 'PF-0006'), 'PF-0006 - Fix the title');
});

test('error details reach feedback (action and kind of a UI failure)', () => {
  const e = new SnowgateError('click failed', 'UI_ACTION_FAILED', { action: 'click', kind: 'timeout' });
  assert.deepEqual(gapsFromError(e, { tool: 'ui_click' })[0].subject, 'ui_click click timeout');
});

test('feedback clear is human-only and can keep unsent gaps', async () => {
  const root = makeProject('PF-0001');
  recordGap(root, { kind: 'refusal', code: 'TABLE_NOT_ALLOWED', subject: 'a' });
  recordGap(root, { kind: 'refusal', code: 'TABLE_NOT_ALLOWED', subject: 'b' });
  assert.equal(clearGaps(root, { sentOnly: true }), 0);
  assert.equal(clearGaps(root), 2);
  assert.equal(readGaps(root).length, 0);
  assert.match(preToolUse({ tool_name: 'Bash', tool_input: { command: 'snowgate feedback clear' }, cwd: root }, { root, env: {} }), /human-only/);
  const stdin = new PassThrough();
  stdin.isTTY = false;
  assert.equal(await main(['feedback', 'clear'], { cwd: root, stdin, stdout: { write: () => {} }, stderr: { write: () => {} } }), 1);
});

// A ServiceNow-like form: hidden checkbox shown through its label, and an
// Update that returns to the update-set form left on the navigation stack.
function site() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = (b) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body>${b}</body>`); };
    if (url.pathname === '/login.do' && req.method === 'POST') { res.writeHead(302, { 'set-cookie': 'S=1; Path=/', location: '/home.do' }); return res.end(); }
    if (url.pathname === '/login.do') return html('<form method="post" action="/login.do"><input id="user_name"><input id="user_password" type="password"><button id="sysverb_login">Log in</button></form>');
    if (url.pathname === '/item_option_new.do' && req.method === 'POST') { res.writeHead(302, { location: '/sys_update_set.do?sys_id=-1' }); return res.end(); }
    if (url.pathname === '/item_option_new.do') {
      // Like ServiceNow: the form header is a .tabs2_section without a tab, and
      // only the active tab carries aria-controls.
      const show = (id) => `onclick="for(const s of document.querySelectorAll('[id^=section_tab]'))s.style.display=s.id==='${id}'?'':'none'"`;
      return html(`<form method="post" action="/item_option_new.do">
        <span class="tabs2_section tabs2_section_0">header</span>
        <span class="tabs2_tab" aria-controls="section_tab.a" ${show('section_tab.a')}>Question</span>
        <span class="tabs2_tab" ${show('section_tab.b')}>Auto-populate</span>
        <span class="tabs2_tab" ${show('section_tab.c')}>Type Specifications</span>
        <span id="section_tab.a" class="tabs2_section tab_section"><label for="q">Question</label><input id="q"></span>
        <span id="section_tab.b" class="tabs2_section tab_section" style="display:none">auto</span>
        <span id="section_tab.c" class="tabs2_section tab_section" style="display:none">
          <input type="checkbox" id="ni.include_none" style="opacity:0;position:absolute"><label id="label.ni.include_none" for="ni.include_none" class="checkbox-label">Include none</label>
        </span>
        <button type="submit">Update</button></form>`);
    }
    return html(`<h1>${url.pathname}</h1>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

test('hidden ServiceNow checkboxes toggle through their label; the post-save return to an update-set page is a notice', { timeout: 60000 }, async () => {
  const s = await site();
  const session = new BrowserSession({ origin: s.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    await session.navigate(`${s.origin}/item_option_new.do?sys_id=1`);
    const box = session.frame(0).locator('[id="ni.include_none"]');
    await session.click({ label: 'Include none' });
    assert.equal(await box.isChecked(), true);
    await session.type({ label: 'Include none' }, 'true'); // already on: no toggle
    assert.equal(await box.isChecked(), true);
    await session.type({ label: 'Include none' }, 'false');
    assert.equal(await box.isChecked(), false);

    await session.click({ role: 'button', name: 'Update' });
    await session.postCheck({ afterAction: true });
    assert.match(session.takeNotice(), /tried to return to an update-set page/);
    // Without afterAction (a plain navigation) it is still a refusal.
    await session.navigate(`${s.origin}/sys_update_set.do?sys_id=-1`);
    await assert.rejects(session.postCheck(), { code: 'URL_LOCKED' });
    await session.navigate(`${s.origin}/home.do`);
    await session.postCheck();
    assert.match(session.pageUrl(), /home\.do$/);
  } finally {
    await session.close();
    await s.close();
  }
});
