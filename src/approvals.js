import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SnowgateError } from './errors.js';
import { requireWorkItem, snowgateDir } from './workspace.js';

// User-held approval records (PLAN §15 A5). Only `snowgate approve`, run by a
// human in a TTY, appends here. Upload and commit approvals bind the SHA-256 of
// the exact update-set.xml, so any later edit to the file invalidates them.
//
//   plan    — the human approved this change package's scope; required before
//             update-set.xml may exist (replaces the origin's tasks/ approval).
//   upload  — this exact XML may be uploaded to the target.
//   commit  — this exact XML may be committed on the target.
export const PURPOSES = ['plan', 'upload', 'commit'];
const HASHED = new Set(['upload', 'commit']);

export function approvalsFile(root, workId) {
  return snowgateDir(root, 'approvals', `${workId}.jsonl`);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function readApprovals(root, workId) {
  const file = approvalsFile(root, workId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// The human must type the change_id back exactly. `ask` is injected so the CLI
// can require a real TTY while tests stay deterministic.
export async function recordApproval(root, workId, { changeId, purpose, xmlPath, ask, who, now = new Date() }) {
  requireWorkItem(root, workId);
  if (!PURPOSES.includes(purpose)) {
    throw new SnowgateError(`--for must be one of ${PURPOSES.join(', ')}.`, 'APPROVAL_PURPOSE_INVALID');
  }
  if (!changeId) throw new SnowgateError('A change package id is required (--package <change_id>).', 'APPROVAL_PACKAGE_REQUIRED');
  if (!who) throw new SnowgateError('Cannot record approved_by: no identity available.', 'NO_IDENTITY');
  let hash = null;
  if (HASHED.has(purpose)) {
    if (!xmlPath || !existsSync(xmlPath)) {
      throw new SnowgateError(`${purpose} approval needs the package's update-set.xml, which does not exist.`, 'XML_MISSING');
    }
    hash = sha256File(xmlPath);
  }
  const shown = hash ? ` (update-set.xml sha256 ${hash.slice(0, 12)}…)` : '';
  const typed = (await ask(`Type the change package id to approve it for ${purpose} under ${workId}${shown}: `)).trim();
  if (typed !== changeId) {
    throw new SnowgateError('Approval did not match the change package id. Nothing recorded.', 'APPROVAL_MISMATCH');
  }
  const record = { change_id: changeId, for: purpose, sha256: hash, approved_by: who, approved_at: now.toISOString() };
  const file = approvalsFile(root, workId);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return record;
}

// The latest record for (change_id, purpose) decides. For hashed purposes the
// recorded hash must equal the current file's hash.
export function findApproval(root, workId, changeId, purpose) {
  return readApprovals(root, workId)
    .filter((r) => r.change_id === changeId && r.for === purpose)
    .at(-1) ?? null;
}

export function requireApproval(root, workId, changeId, purpose, xmlPath) {
  const record = findApproval(root, workId, changeId, purpose);
  if (!record || !record.approved_by || !record.approved_at) {
    throw new SnowgateError(
      `No ${purpose} approval for ${changeId} under ${workId}. A human must run: snowgate approve --work ${workId} --package ${changeId} --for ${purpose}`,
      'APPROVAL_MISSING',
    );
  }
  if (HASHED.has(purpose)) {
    const current = xmlPath && existsSync(xmlPath) ? sha256File(xmlPath) : null;
    if (!current || record.sha256 !== current) {
      throw new SnowgateError(
        `The ${purpose} approval for ${changeId} was given for a different update-set.xml (the file changed after approval). A human must approve the current file again.`,
        'APPROVAL_STALE',
      );
    }
  }
  return record;
}
