import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { SnowgateError } from './errors.js';
import { approvalFor } from './config.js';
import { normalizeInstance } from './instance.js';
import { requireWorkItem, snowgateDir } from './workspace.js';

// Per-work-item platform state (PLAN §15 A4). YallaFlow 1.0 cannot hold the
// target or the change-package mapping, so snowgate keeps it here until the
// Pack API exists.
export function workFile(root, workId) {
  return snowgateDir(root, 'work', `${workId}.yaml`);
}

export function readWork(root, workId) {
  requireWorkItem(root, workId);
  const file = workFile(root, workId);
  const blank = {
    work_id: workId,
    target: { instance: null, confirmed_by: null, confirmed_at: null, candidate_instance: null },
    change_packages: [],
  };
  if (!existsSync(file)) return blank;
  const doc = parse(readFileSync(file, 'utf8')) ?? {};
  return { ...blank, ...doc, target: { ...blank.target, ...doc.target } };
}

export function writeWork(root, work) {
  const file = workFile(root, work.work_id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stringify(work));
}

// Records a candidate. A candidate never authorises anything by itself; a
// changed candidate invalidates any previously confirmed target. When a human
// approved the instance for this project (approved_instances, written by
// snowgate setup), the target is confirmed at once under that approval.
export function setCandidate(root, workId, instanceInput, pattern, now = new Date()) {
  const instance = normalizeInstance(instanceInput, pattern);
  const work = readWork(root, workId);
  if (work.target.instance && work.target.instance !== instance) {
    work.target.instance = null;
    work.target.confirmed_by = null;
    work.target.confirmed_at = null;
    delete work.target.confirmation;
  }
  work.target.candidate_instance = instance;
  const approval = approvalFor(root, instance);
  if (approval && work.target.instance !== instance) {
    work.target.instance = instance;
    work.target.confirmed_by = approval.approved_by;
    work.target.confirmed_at = now.toISOString();
    work.target.confirmation = { via: 'approved_instances', approved_at: approval.approved_at };
  }
  writeWork(root, work);
  return work;
}

// The human must type the candidate host back exactly. `ask` is injected so the
// CLI can require a real TTY while tests stay deterministic.
export async function confirmTarget(root, workId, { ask, who, now = new Date() }) {
  const work = readWork(root, workId);
  const candidate = work.target.candidate_instance;
  if (!candidate) {
    throw new SnowgateError(`No candidate instance for ${workId}. Run \`snowgate target set <instance> --work ${workId}\` first.`, 'NO_CANDIDATE');
  }
  if (!who) throw new SnowgateError('Cannot record confirmed_by: no identity available.', 'NO_IDENTITY');
  const typed = (await ask(`Type the instance host to confirm it as the target for ${workId} (${candidate}): `)).trim();
  if (typed !== candidate) {
    throw new SnowgateError('Confirmation did not match the candidate instance. Target not confirmed.', 'CONFIRM_MISMATCH');
  }
  work.target.instance = candidate;
  work.target.confirmed_by = who;
  work.target.confirmed_at = now.toISOString();
  work.target.confirmation = { via: 'human' };
  writeWork(root, work);
  return work;
}

export function requireConfirmedTarget(root, workId) {
  const { target } = readWork(root, workId);
  // A confirmation that rested on the project approval ends when a human
  // removes the instance from approved_instances.
  const revoked = target.confirmation?.via === 'approved_instances' && !approvalFor(root, target.instance);
  if (!target.instance || !target.confirmed_by || !target.confirmed_at || revoked) {
    throw new SnowgateError(
      `${workId} has no confirmed target instance. Run \`snowgate target set <instance> --work ${workId}\`, then \`snowgate target confirm --work ${workId}\`.`,
      'TARGET_UNCONFIRMED',
    );
  }
  return target.instance;
}
