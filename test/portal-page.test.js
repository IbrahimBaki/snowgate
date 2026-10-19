import assert from 'node:assert/strict';
import test from 'node:test';
import { portalPage } from '../src/portal-page.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { INSTANCE, PASSWORD, USER, startMockServiceNow } from './helpers.js';

// PF-0013: a Service Portal page as one layout tree.
const id = (c) => c.repeat(32);
const PAGE = id('1'), C1 = id('2'), C2 = id('3'), R1 = id('4'), R2 = id('5'), COL1 = id('6'), COL2 = id('7'), NROW = id('8'), NCOL = id('9'), I1 = id('a'), I2 = id('b'), I3 = id('c');
const W = id('d');

const inList = (field, rows) => (params) => {
  const q = params.get('sysparm_query') ?? '';
  const m = new RegExp(`${field}IN([0-9a-f,]+)`).exec(q) ?? new RegExp(`${field}=([0-9a-f]{32}|[\\w.-]+)`).exec(q);
  if (!m) return [];
  const ids = m[1].split(',');
  return rows.filter((r) => ids.includes(r[field]));
};

const tables = {
  sp_page: inList('id', [{ sys_id: PAGE, id: 'edupulse_landing', title: 'EduPulse', public: 'true', css: '.hero{}', sys_scope: 'global', sys_created_by: 'admin', sys_created_on: '' }]),
  sp_container: inList('sp_page', [
    { sys_id: C2, name: 'EduPulse - Container 2', title: '', sp_page: PAGE, order: '200', width: 'container', class_name: '', background_color: '', sys_scope: 'global' },
    { sys_id: C1, name: 'EduPulse - Container 1', title: '', sp_page: PAGE, order: '100', width: 'container-fluid', class_name: 'hero', background_color: '#003366', sys_scope: 'global' },
  ]),
  sp_row: (params) => {
    const rows = [
      { sys_id: R1, sp_container: C1, sp_column: '', order: '1', class_name: '', sys_scope: 'global' },
      { sys_id: R2, sp_container: C2, sp_column: '', order: '1', class_name: '', sys_scope: 'global' },
      { sys_id: NROW, sp_container: '', sp_column: COL2, order: '1', class_name: 'nested', sys_scope: 'global' },
    ];
    return (params.get('sysparm_query') ?? '').startsWith('sp_container') ? inList('sp_container', rows)(params) : inList('sp_column', rows)(params);
  },
  sp_column: inList('sp_row', [
    { sys_id: COL1, sp_row: R1, order: '1', size: '12', size_xs: '', size_sm: '', size_lg: '', class_name: '', sys_scope: 'global' },
    { sys_id: COL2, sp_row: R2, order: '1', size: '12', size_xs: '', size_sm: '', size_lg: '', class_name: '', sys_scope: 'global' },
    { sys_id: NCOL, sp_row: NROW, order: '1', size: '6', size_xs: '', size_sm: '', size_lg: '', class_name: '', sys_scope: 'global' },
  ]),
  sp_instance: inList('sp_column', [
    { sys_id: I2, title: 'CTA', id: '', sp_widget: W, 'sp_widget.name': 'HTML', 'sp_widget.id': 'widget-html', sp_column: COL1, order: '2', active: 'true', class_name: '', widget_parameters: '{"html":{"value":"<a href=\\"?id=edupulse_register\\">Register</a>"}}', css: '', sys_scope: 'global', sys_created_by: 'admin', sys_created_on: '' },
    { sys_id: I1, title: 'Hero', id: '', sp_widget: W, 'sp_widget.name': 'HTML', 'sp_widget.id': 'widget-html', sp_column: COL1, order: '1', active: 'true', class_name: '', widget_parameters: '{"html":{"value":"<h1>Welcome to EduPulse</h1>"}}', css: 'h1{color:#fff}', sys_scope: 'global', sys_created_by: 'admin', sys_created_on: '' },
    { sys_id: I3, title: '', id: '', sp_widget: W, 'sp_widget.name': 'HTML', 'sp_widget.id': 'widget-html', sp_column: NCOL, order: '1', active: 'false', class_name: '', widget_parameters: 'not json', css: '', sys_scope: 'global', sys_created_by: 'admin', sys_created_on: '' },
  ]),
};

test('sn_portal_page returns the page as an ordered tree with widget content, nested rows included', async () => {
  const mock = await startMockServiceNow({ tables });
  const client = new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl });
  try {
    const page = await portalPage(client, 'edupulse_landing');
    assert.equal(page.page.id, 'edupulse_landing');
    assert.deepEqual(page.containers.map((c) => c.name), ['EduPulse - Container 1', 'EduPulse - Container 2']);
    const hero = page.containers[0].rows[0].columns[0].instances;
    assert.deepEqual(hero.map((i) => i.title), ['Hero', 'CTA']);
    assert.equal(hero[0].options.html.value, '<h1>Welcome to EduPulse</h1>');
    assert.equal(hero[0].widget.name, 'HTML');
    const nested = page.containers[1].rows[0].columns[0].rows[0].columns[0];
    assert.equal(nested.size, '6');
    assert.equal(nested.instances[0].active, 'false');
    assert.deepEqual(nested.instances[0].options, { _raw: 'not json' });
    assert.ok(page.evidence.length >= 6);
    assert.ok(mock.requests.every((r) => r.method === 'GET'));
  } finally {
    await mock.close();
  }
});

test('sn_portal_page rejects bad ids and reports unknown pages', async () => {
  const mock = await startMockServiceNow({ tables });
  const client = new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl });
  try {
    await assert.rejects(portalPage(client, "x' or 1=1"), { code: 'PAGE_INVALID' });
    await assert.rejects(portalPage(client, 'no_such_page'), { code: 'PAGE_NOT_FOUND' });
  } finally {
    await mock.close();
  }
});
