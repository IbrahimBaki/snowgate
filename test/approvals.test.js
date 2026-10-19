import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { approvalsFile, recordApproval, requireApproval } from '../src/approvals.js';
import { main } from '../src/cli/main.js';
import { scanText } from '../src/validate/secrets.js';
import { makeProject } from './helpers.js';

const WORK = 'PF-0001';

function xmlIn(root, body = '<unload></unload>') {
  const file = path.join(root, 'update-set.xml');
  writeFileSync(file, body);
  return file;
}

test('approve records who, when and the XML hash after the change_id is typed back', async () => {
  const root = makeProject(WORK);
  const xml = xmlIn(root);
  const record = await recordApproval(root, WORK, { changeId: 'CHG-1', purpose: 'upload', xmlPath: xml, ask: async () => 'CHG-1', who: 'alice' });
  assert.equal(record.approved_by, 'alice');
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(requireApproval(root, WORK, 'CHG-1', 'upload', xml).sha256, record.sha256);
  assert.equal(readFileSync(approvalsFile(root, WORK), 'utf8').trim().split('\n').length, 1);
});

test('a mistyped change_id records nothing', async () => {
  const root = makeProject(WORK);
  const xml = xmlIn(root);
  await assert.rejects(
    recordApproval(root, WORK, { changeId: 'CHG-1', purpose: 'commit', xmlPath: xml, ask: async () => 'CHG-2', who: 'alice' }),
    { code: 'APPROVAL_MISMATCH' },
  );
  assert.throws(() => requireApproval(root, WORK, 'CHG-1', 'commit', xml), { code: 'APPROVAL_MISSING' });
});

test('an approval goes stale when update-set.xml changes', async () => {
  const root = makeProject(WORK);
  const xml = xmlIn(root);
  await recordApproval(root, WORK, { changeId: 'CHG-1', purpose: 'commit', xmlPath: xml, ask: async () => 'CHG-1', who: 'alice' });
  writeFileSync(xml, '<unload><tampered/></unload>');
  assert.throws(() => requireApproval(root, WORK, 'CHG-1', 'commit', xml), { code: 'APPROVAL_STALE' });
});

test('upload approval does not stand in for commit approval', async () => {
  const root = makeProject(WORK);
  const xml = xmlIn(root);
  await recordApproval(root, WORK, { changeId: 'CHG-1', purpose: 'upload', xmlPath: xml, ask: async () => 'CHG-1', who: 'alice' });
  assert.throws(() => requireApproval(root, WORK, 'CHG-1', 'commit', xml), { code: 'APPROVAL_MISSING' });
});

test('snowgate approve refuses non-interactive input', async () => {
  const root = makeProject(WORK);
  const stdin = new PassThrough();
  stdin.isTTY = false;
  let err = '';
  const code = await main(['approve', '--work', WORK, '--package', 'CHG-1', '--for', 'commit'], {
    cwd: root,
    stdin,
    stdout: { write: () => {} },
    stderr: { write: (s) => (err += s) },
  });
  assert.equal(code, 1);
  assert.match(err, /interactive terminal/);
});

test('secret scan flags credentials and ignores placeholders', () => {
  assert.equal(scanText('password: hunter2hunter').length, 1);
  assert.equal(scanText('Authorization: Bearer abcdefghijklmnop').length, 1);
  assert.equal(scanText('JSESSIONID=ABCDEF1234567890').length, 1);
  assert.equal(scanText('-----BEGIN RSA PRIVATE KEY-----').length, 1);
  assert.equal(scanText('api_key = AbCdEf1234567890').length, 1);
  assert.equal(scanText('secret_token: AbCdEf1234567890').length, 1);
  assert.equal(scanText('glide_user_session=abcdef1234567890').length, 1);
  assert.equal(scanText('X-UserToken: abcdef1234567890ab').length, 1);
  assert.equal(scanText('password: <your-password>').length, 0);
  assert.equal(scanText('api_key = xxxxxxxxxxxx').length, 0);
  assert.equal(scanText('nothing to see here').length, 0);
});
