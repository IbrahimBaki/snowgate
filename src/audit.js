import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { snowgateDir } from './workspace.js';

// Append-only audit trail per work item (PLAN §7.3). Callers must never pass
// credentials; entries hold tool, target, and result summaries only.
export function appendAudit(root, workId, entry, now = new Date()) {
  const file = snowgateDir(root, 'audit', `${workId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), work_id: workId, ...entry })}\n`);
}
