import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuthError, TableAccessError } from '../src/errors.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { INSTANCE, PASSWORD, USER, basicAuth, startMockServiceNow } from './helpers.js';

const rows = Array.from({ length: 7 }, (_, i) => ({ sys_id: String(i).padStart(32, '0'), name: `Set ${i}`, state: 'complete', secret_col: 'x' }));
let mock;

before(async () => {
  mock = await startMockServiceNow({ tables: { sys_update_set: rows }, forbidden: ['sys_script'], expectedAuth: basicAuth() });
});
after(() => mock.close());

const client = (opts = {}) => new ReadOnlyClient({ instance: INSTANCE, user: USER, password: PASSWORD, fetchImpl: mock.fetchImpl, ...opts });

test('queries an allow-listed table with explicit fields, GET only, paginated', async () => {
  const { records, evidence } = await client({ pageSize: 3 }).query('sys_update_set', { fields: ['sys_id', 'name'] });
  assert.equal(records.length, 7);
  assert.deepEqual(Object.keys(records[0]).sort(), ['name', 'sys_id']);
  assert.equal(evidence.count, 7);
  assert.equal(evidence.truncated, false);
  assert.match(evidence.url, /^https:\/\/dev12345\.service-now\.com\/api\/now\/table\/sys_update_set\?/);
  assert.ok(mock.requests.every((r) => r.method === 'GET'));
  assert.ok(mock.requests.length >= 3);
});

test('evidence never carries credentials', async () => {
  const { evidence } = await client().query('sys_update_set', { fields: ['sys_id'] });
  const text = JSON.stringify(evidence);
  assert.ok(!text.includes(PASSWORD));
  assert.ok(!text.includes(basicAuth()));
});

test('refuses tables off the allowlist before any request', async () => {
  const before = mock.requests.length;
  await assert.rejects(client().query('sys_user', { fields: ['sys_id'] }), { code: 'TABLE_NOT_ALLOWED' });
  await assert.rejects(client().query('incident', { fields: ['sys_id'] }), { code: 'TABLE_NOT_ALLOWED' });
  assert.equal(mock.requests.length, before);
});

test('fields are mandatory and restricted to the allowlist', async () => {
  await assert.rejects(client().query('sys_update_set', {}), { code: 'FIELDS_REQUIRED' });
  await assert.rejects(client().query('sys_update_set', { fields: [] }), { code: 'FIELDS_REQUIRED' });
  await assert.rejects(client().query('sys_update_set', { fields: ['sys_id', 'secret_col'] }), { code: 'FIELD_NOT_ALLOWED' });
});

test('maps 403 to TableAccessError and 401 to AuthError', async () => {
  await assert.rejects(client().query('sys_script', { fields: ['sys_id'] }), (e) => e instanceof TableAccessError && e.status === 403);
  await assert.rejects(
    new ReadOnlyClient({ instance: INSTANCE, user: USER, password: 'wrong', fetchImpl: mock.fetchImpl }).query('sys_update_set', { fields: ['sys_id'] }),
    AuthError,
  );
});

test('safety cap marks results as truncated', async () => {
  const { records, evidence } = await client({ pageSize: 2, maxRecords: 4 }).query('sys_update_set', { fields: ['sys_id'] });
  assert.equal(records.length, 4);
  assert.equal(evidence.truncated, true);
});

test('rejects bad instances, missing credentials, and unsafe user names', () => {
  assert.throws(() => client({ instance: 'evil.example.com' }), { code: 'INSTANCE_INVALID' });
  assert.throws(() => client({ instance: 'dev1.service-now.com.evil.com' }), { code: 'INSTANCE_INVALID' });
  assert.throws(() => client({ password: '' }), { code: 'NO_CREDENTIALS' });
  assert.throws(() => client({ user: 'a^ORuser_name!=x' }), { code: 'CREDENTIALS_INVALID' });
});

test('REST layer contains no write verbs (structural check)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rest');
  for (const file of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /\b(POST|PUT|PATCH|DELETE)\b/, `${file} mentions a write verb`);
    assert.doesNotMatch(src, /method:\s*(?![\s']|'GET')|method:\s*'(?!GET')/, `${file} sets a non-GET method`);
  }
});
