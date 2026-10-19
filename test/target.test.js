import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { confirmTarget, readWork, requireConfirmedTarget, setCandidate, workFile } from '../src/work.js';
import { makeProject } from './helpers.js';

const NOW = new Date('2026-10-19T12:00:00Z');

test('target set records only a candidate', () => {
  const root = makeProject();
  setCandidate(root, 'PF-0001', 'https://Dev12345.service-now.com/');
  const { target } = readWork(root, 'PF-0001');
  assert.deepEqual(target, { instance: null, confirmed_by: null, confirmed_at: null, candidate_instance: 'dev12345.service-now.com' });
  assert.ok(existsSync(workFile(root, 'PF-0001')));
  assert.throws(() => requireConfirmedTarget(root, 'PF-0001'), { code: 'TARGET_UNCONFIRMED' });
});

test('confirm requires the human to type the candidate back exactly', async () => {
  const root = makeProject();
  setCandidate(root, 'PF-0001', 'dev12345.service-now.com');
  await assert.rejects(confirmTarget(root, 'PF-0001', { ask: async () => 'dev99999.service-now.com', who: 'Tester', now: NOW }), { code: 'CONFIRM_MISMATCH' });
  assert.throws(() => requireConfirmedTarget(root, 'PF-0001'), { code: 'TARGET_UNCONFIRMED' });

  await confirmTarget(root, 'PF-0001', { ask: async () => ' dev12345.service-now.com\n', who: 'Tester', now: NOW });
  assert.equal(requireConfirmedTarget(root, 'PF-0001'), 'dev12345.service-now.com');
  const { target } = readWork(root, 'PF-0001');
  assert.equal(target.confirmed_by, 'Tester');
  assert.equal(target.confirmed_at, NOW.toISOString());
});

test('changing the candidate revokes the confirmed target', async () => {
  const root = makeProject();
  setCandidate(root, 'PF-0001', 'dev12345.service-now.com');
  await confirmTarget(root, 'PF-0001', { ask: async () => 'dev12345.service-now.com', who: 'Tester', now: NOW });
  setCandidate(root, 'PF-0001', 'dev67890.service-now.com');
  assert.throws(() => requireConfirmedTarget(root, 'PF-0001'), { code: 'TARGET_UNCONFIRMED' });
});

test('confirm without a candidate is refused', async () => {
  const root = makeProject();
  await assert.rejects(confirmTarget(root, 'PF-0001', { ask: async () => '', who: 'Tester' }), { code: 'NO_CANDIDATE' });
});

test('work item must exist in YallaFlow and instance must match the pattern', () => {
  const root = makeProject();
  assert.throws(() => setCandidate(root, 'PF-0002', 'dev12345.service-now.com'), { code: 'WORK_MISSING' });
  assert.throws(() => setCandidate(root, 'not-a-work-id', 'dev12345.service-now.com'), { code: 'WORK_INVALID' });
  assert.throws(() => setCandidate(root, 'PF-0001', 'dev12345.service-now.com/path'), { code: 'INSTANCE_INVALID' });
  assert.throws(() => setCandidate(root, 'PF-0001', 'user@dev12345.service-now.com'), { code: 'INSTANCE_INVALID' });
});
