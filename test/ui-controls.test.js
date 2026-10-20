import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { gapsFromError } from '../src/feedback.js';
import { BrowserSession } from '../src/playwright/session.js';
import { PASSWORD, USER } from './helpers.js';

// PF-0020: dropdowns, checkboxes and Service Portal (select2) pickers.
const PAGE = `<!doctype html><body>
<label for="mand">Mandatory</label>
<select id="mand"><option>Leave alone</option><option>True</option><option>False</option></select>
<label for="active">Active</label><input type="checkbox" id="active">
<label for="title">Title</label><input id="title">

<!-- select2 as Service Portal renders it: the real <select> is hidden -->
<div role="group" aria-label="Register as"><label for="sp_formfield_register_as">Register as</label></div>
<input id="s2id_autogen1" aria-label="Register as" class="select2-focusser">
<select id="sp_formfield_register_as" style="display:none"><option>Student</option><option>Parent</option><option>Teacher</option></select>
<div id="s2id_sp_formfield_register_as"><a class="select2-choice" href="#" onclick="event.preventDefault();document.getElementById('drop').className='select2-drop-active'"><span id="shown">Student</span></a></div>
<div id="drop" class="select2-drop" style="display:none"><ul class="select2-results">
  <li><div class="select2-result-label">Student</div></li><li><div class="select2-result-label">Parent</div></li><li><div class="select2-result-label">Teacher</div></li>
</ul></div>
<style>.select2-drop-active{display:block!important}</style>
<script>
  document.querySelectorAll('#drop .select2-result-label').forEach((el) => el.addEventListener('click', () => {
    const s = document.getElementById('sp_formfield_register_as');
    s.value = el.textContent; s.dispatchEvent(new Event('change'));
    document.getElementById('shown').textContent = el.textContent;
    document.getElementById('drop').className = 'select2-drop';
  }));
</script>

<!-- an autocomplete (reference) field -->
<label for="ref">Assigned to</label><input id="ref" oninput="document.getElementById('ac').innerHTML=this.value?'<li role=option>Abel Tuter</li><li role=option>Abraham Lincoln</li>':''">
<ul id="ac" role="listbox"></ul>
</body>`;

function site() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/login.do' && req.method === 'POST') { res.writeHead(302, { 'set-cookie': 'S=1; Path=/', location: '/form.do' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === '/login.do') return res.end('<form method="post" action="/login.do"><input id="user_name"><input id="user_password" type="password"><button id="sysverb_login">Log in</button></form>');
    res.end(PAGE);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}

test('ui_type sets dropdowns and checkboxes; ui_select handles select2 and autocomplete', { timeout: 60000 }, async () => {
  const s = await site();
  const session = new BrowserSession({ origin: s.origin, auth: 'password', user: USER, password: PASSWORD });
  try {
    await session.navigate(`${s.origin}/form.do`);
    // A choice list: by visible text.
    await session.type({ label: 'Mandatory' }, 'True');
    // A checkbox: true/false.
    await session.type({ label: 'Active' }, 'true');
    // A text field still types.
    await session.type({ label: 'Title' }, 'Hello');
    const f = session.frame(0);
    assert.equal(await f.locator('#mand').evaluate((e) => e.selectedOptions[0].text), 'True');
    assert.equal(await f.locator('#active').isChecked(), true);
    assert.equal(await f.locator('#title').inputValue(), 'Hello');

    // select2: opened and picked through its own control, then verified.
    const picked = await session.select({ label: 'Register as' }, 'Parent');
    assert.equal(picked.selected, 'Parent');
    assert.equal(await f.locator('#shown').textContent(), 'Parent');
    // ui_type on the same field takes the same path.
    await session.type({ label: 'Register as' }, 'Teacher');
    assert.equal(await f.locator('#sp_formfield_register_as').inputValue(), 'Teacher');

    // Autocomplete: type, then click the matching suggestion.
    await session.select({ label: 'Assigned to' }, 'Abel Tuter');

    // Clear errors instead of raw Playwright output.
    await assert.rejects(session.type({ label: 'Mandatory' }, 'Sometimes'), (e) => e.code === 'UI_ACTION_FAILED' && /not one of: Leave alone, True, False/.test(e.message) && !/\u001b/.test(e.message));
    await assert.rejects(session.select({ label: 'Register as' }, 'Principal'), (e) => e.code === 'UI_ACTION_FAILED' && /"Principal" is not one of: Student, Parent, Teacher/.test(e.message));
    await assert.rejects(session.select({ label: 'Assigned to' }, 'Nobody Here'), (e) => e.code === 'UI_ACTION_FAILED' && /No visible option "Nobody Here"/.test(e.message));
  } finally {
    await session.close();
    await s.close();
  }
});

test('UI failures become feedback grouped by tool and kind', () => {
  const e = Object.assign(new Error('x'), { code: 'UI_ACTION_FAILED', details: { action: 'select', kind: 'option-not-found' } });
  assert.deepEqual(gapsFromError(e, { tool: 'ui_select' }).map((g) => [g.kind, g.subject]), [['ui-failure', 'ui_select select option-not-found']]);
});
