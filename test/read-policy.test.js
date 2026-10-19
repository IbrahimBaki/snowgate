import assert from 'node:assert/strict';
import test from 'node:test';
import { gapsFromError } from '../src/feedback.js';
import { checkQuery } from '../src/rest/read-policy.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { INSTANCE, PASSWORD, USER, schemaTables, startMockServiceNow } from './helpers.js';

// PF-0015: any table and field except sensitive data, checked against the
// instance's own dictionary.
const schema = schemaTables({
  sys_metadata: { fields: { sys_updated_by: 'string', sys_updated_on: 'glide_date_time', sys_mod_count: 'integer' } },
  sp_widget: { parent: 'sys_metadata', fields: { name: 'string', script: 'script' } },
  task: { fields: { number: 'string', short_description: 'string', assigned_to: 'reference:sys_user' } },
  sc_req_item: { parent: 'task', fields: { cat_item: 'reference:sc_cat_item' } },
  sys_user: { fields: { user_name: 'string', email: 'email', user_password: 'password' } },
  oauth_entity: { parent: 'sys_metadata', fields: { name: 'string', client_secret: 'password2', redirect_url: 'url' } },
  u_vault: { fields: { label: 'string', u_blob: 'password2' } },
});
const rows = { sp_widget: [{ sys_id: '1', name: 'w', sys_updated_by: 'admin' }], sc_req_item: [{ sys_id: '2', number: 'RITM1' }], sys_user: [{ sys_id: '3', user_name: 'a' }], u_vault: [{ sys_id: '4', label: 'x' }] };

async function client(readPolicy) {
  const mock = await startMockServiceNow({ tables: { ...schema, ...rows } });
  return { mock, c: new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl, readPolicy }) };
}

test('data: all — any table and field, inherited ones included (e.g. audit fields)', async () => {
  const { mock, c } = await client({ data: 'all' });
  try {
    assert.equal((await c.query('sp_widget', { fields: ['name', 'sys_updated_by', 'sys_updated_on', 'sys_mod_count'] })).records.length, 1);
    assert.equal((await c.query('sc_req_item', { fields: ['number', 'short_description', 'assigned_to.user_name'] })).records.length, 1);
    await assert.rejects(c.query('sc_req_item', { fields: ['no_such_field'] }), { code: 'FIELD_UNKNOWN' });
    await assert.rejects(c.query('u_nothing', { fields: ['sys_id'] }), { code: 'TABLE_UNKNOWN' });
    assert.ok(mock.requests.every((r) => r.method === 'GET'));
  } finally {
    await mock.close();
  }
});

test('sensitive data is refused in every mode: by type, by name, through dot-walks, and in queries', async () => {
  const { mock, c } = await client({ data: 'all' });
  try {
    await assert.rejects(c.query('sys_user', { fields: ['user_password'] }), { code: 'FIELD_SENSITIVE' });
    await assert.rejects(c.query('u_vault', { fields: ['u_blob'] }), { code: 'FIELD_SENSITIVE' }); // type password2, harmless name
    await assert.rejects(c.query('oauth_entity', { fields: ['client_secret'] }), { code: 'FIELD_SENSITIVE' });
    await assert.rejects(c.query('sc_req_item', { fields: ['assigned_to.user_password'] }), { code: 'FIELD_SENSITIVE' });
    await assert.rejects(c.query('sys_user_session', { fields: ['sys_id'] }), { code: 'TABLE_SENSITIVE' });
    await assert.rejects(c.query('oauth_credential', { fields: ['sys_id'] }), { code: 'TABLE_SENSITIVE' });
    await assert.rejects(c.query('sys_user', { fields: ['user_name'], query: 'user_passwordSTARTSWITHa' }), { code: 'QUERY_SENSITIVE' });
    await assert.rejects(c.query('sys_user', { fields: ['user_name'], query: 'sys_id=javascript:gs.getUserID()' }), { code: 'QUERY_NOT_ALLOWED' });
  } finally {
    await mock.close();
  }
  // Even without a policy (the static allowlist), javascript: is refused.
  assert.throws(() => checkQuery('nameSTARTSWITHa^sys_id=javascript : new GlideRecord("x")'), { code: 'QUERY_NOT_ALLOWED' });
});

test('data: listed and none limit data tables but keep configuration readable', async () => {
  const none = await client({ data: 'none' });
  try {
    assert.equal((await none.c.query('sp_widget', { fields: ['name', 'sys_updated_by'] })).records.length, 1);
    await assert.rejects(none.c.query('sc_req_item', { fields: ['number'] }), { code: 'DATA_NOT_ALLOWED' });
  } finally {
    await none.mock.close();
  }
  const listed = await client({ data: 'listed', data_tables: ['sc_req_item'] });
  try {
    assert.equal((await listed.c.query('sc_req_item', { fields: ['number'] })).records.length, 1);
    await assert.rejects(listed.c.query('sys_user', { fields: ['user_name'] }), { code: 'DATA_NOT_ALLOWED' });
    // A dot-walk cannot reach a data table that is not listed.
    await assert.rejects(listed.c.query('sc_req_item', { fields: ['assigned_to.user_name'] }), { code: 'DATA_NOT_ALLOWED' });
  } finally {
    await listed.mock.close();
  }
});

test('one feedback gap per refused field', () => {
  const e = Object.assign(new Error('x'), { code: 'FIELD_NOT_ALLOWED', details: { table: 'sp_widget', fields: ['sys_updated_by', 'sys_updated_on', 'sys_mod_count'] } });
  assert.deepEqual(gapsFromError(e, { tool: 'sn_get_record' }).map((g) => g.subject), ['sp_widget.sys_updated_by', 'sp_widget.sys_updated_on', 'sp_widget.sys_mod_count']);
});
