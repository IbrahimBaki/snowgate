import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { SnowgateError } from './errors.js';

export const WORK_ID_PATTERN = /^PF-(?:[A-Za-z0-9]+-)?\d{4}$/;

// snowgate always runs inside a YallaFlow project: YallaFlow is the source of
// truth for work items, snowgate only adds platform state under .snowgate/.
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (isDir(path.join(dir, '.yallaflow'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new SnowgateError(
        'No YallaFlow project found (no .yallaflow/ in this folder or its parents). Run `yallaflow init` first.',
        'NO_PROJECT',
      );
    }
    dir = parent;
  }
}

export function requireWorkItem(root, workId) {
  if (!WORK_ID_PATTERN.test(workId ?? '')) {
    throw new SnowgateError(`"${workId}" is not a YallaFlow work id (expected e.g. PF-0001).`, 'WORK_INVALID');
  }
  if (!isDir(path.join(root, '.yallaflow', 'work', workId))) {
    throw new SnowgateError(`YallaFlow work item ${workId} does not exist in this project.`, 'WORK_MISSING');
  }
  return workId;
}

export function snowgateDir(root, ...parts) {
  return path.join(root, '.snowgate', ...parts);
}

function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}
