import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { SnowgateError } from './errors.js';

export const PACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STAGES = new Set(['discovery', 'plan', 'implementation', 'approval', 'verification', 'close', 'any']);

export function loadPack(file = path.join(PACK_ROOT, 'pack.yaml')) {
  const doc = parse(readFileSync(file, 'utf8'));
  const errors = validatePack(doc);
  if (errors.length) {
    throw new SnowgateError(`Invalid pack file ${file}:\n  - ${errors.join('\n  - ')}`, 'PACK_INVALID');
  }
  return { ...doc, instancePattern: new RegExp(doc.config.instance.pattern) };
}

export function validatePack(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['pack file is empty or not a mapping'];
  if (typeof doc.name !== 'string' || !doc.name) errors.push('name is required');
  if (typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+/.test(doc.version)) errors.push('version must be semver');

  const instance = doc.config?.instance;
  if (instance?.scope !== 'per-task') {
    errors.push('config.instance.scope must be "per-task" — a standing default instance is not allowed');
  }
  if (typeof instance?.pattern !== 'string') {
    errors.push('config.instance.pattern is required');
  } else {
    try {
      new RegExp(instance.pattern);
    } catch {
      errors.push('config.instance.pattern is not a valid regular expression');
    }
  }

  for (const [key, required] of [['skills', ['id', 'file', 'stage']], ['guards', ['id', 'on', 'rule']]]) {
    if (!Array.isArray(doc[key])) {
      errors.push(`${key} must be a list`);
      continue;
    }
    const seen = new Set();
    for (const item of doc[key]) {
      for (const field of required) {
        if (item?.[field] === undefined) errors.push(`${key} entry ${item?.id ?? '?'} is missing ${field}`);
      }
      if (seen.has(item?.id)) errors.push(`${key} id ${item.id} is duplicated`);
      seen.add(item?.id);
      if (key === 'skills' && item?.stage && !STAGES.has(item.stage)) {
        errors.push(`skill ${item.id} has unknown stage ${item.stage}`);
      }
    }
  }
  return errors;
}
