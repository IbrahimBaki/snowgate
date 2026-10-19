import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPack, validatePack } from '../src/pack.js';

test('the shipped pack.yaml loads and is valid', () => {
  const pack = loadPack();
  assert.equal(pack.name, 'servicenow');
  assert.ok(pack.instancePattern.test('dev12345.service-now.com'));
  assert.ok(!pack.instancePattern.test('evil.example.com'));
});

test('a standing default instance is rejected', () => {
  const errors = validatePack({ name: 'x', version: '0.1.0', config: { instance: { scope: 'global', pattern: '.*' } }, skills: [], guards: [] });
  assert.ok(errors.some((e) => e.includes('per-task')));
});

test('duplicate ids and unknown stages are rejected', () => {
  const skill = { id: 'a', file: 'a.md', stage: 'nowhere' };
  const errors = validatePack({ name: 'x', version: '0.1.0', config: { instance: { scope: 'per-task', pattern: '.*' } }, skills: [skill, skill], guards: [] });
  assert.ok(errors.some((e) => e.includes('duplicated')));
  assert.ok(errors.some((e) => e.includes('unknown stage')));
});
