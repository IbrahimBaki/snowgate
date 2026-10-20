import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import { PACK_ROOT } from './pack.js';
import { snowgateDir } from './workspace.js';

// Feedback collection (PF-0014). Gaps met while using snowgate — refused
// fields or tables, unreadable tables, missing tools, and gaps an agent
// reports — are recorded once per fingerprint with a count. Nothing from the
// instance is kept: hosts, sys_ids, e-mail addresses, URLs and paths are
// redacted before a gap is stored. `snowgate feedback send` turns pending
// gaps into an issue in a public feedback repository after the user confirms.
const MAX_DETAIL = 400;
const MAX_DETAILS = 3;
// GitHub rejects very long prefilled URLs; the full text is always also saved.
const MAX_URL = 7500;

function packageInfo() {
  const pkg = JSON.parse(readFileSync(path.join(PACK_ROOT, 'package.json'), 'utf8'));
  return { version: pkg.version, repo: pkg.snowgate?.feedbackRepo ?? 'IbrahimBaki/snowgate-feedback' };
}

export function feedbackRepo(env = process.env) {
  const repo = env.SNOWGATE_FEEDBACK_REPO || packageInfo().repo;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`"${repo}" is not an owner/name GitHub repository.`);
  return repo;
}

export function redact(text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^\s)"'<>]+/gi, '<url>')
    .replace(/\b[a-z0-9-]+\.service-now(?:servicesgc)?\.com\b/gi, '<instance>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<sys_id>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(?:\/(?:home|Users|tmp|var|opt)\/|[A-Za-z]:\\)[^\s'"]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
}

const store = (root) => snowgateDir(root, 'feedback', 'gaps.json');

export function readGaps(root) {
  const file = store(root);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')).gaps ?? [];
  } catch {
    return [];
  }
}

function writeGaps(root, gaps) {
  const file = store(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ gaps }, null, 2)}\n`);
}

// kind: refusal | discovery-limitation | agent-report
// code: e.g. FIELD_NOT_ALLOWED; subject: what it was about (table.field, tool…)
export function recordGap(root, { kind, code, subject, detail = '', suggestion = '' }, now = new Date()) {
  if (!root) return null;
  const cleanSubject = redact(subject).slice(0, 120) || '(unspecified)';
  const fingerprint = `${code}:${cleanSubject}`;
  const gaps = readGaps(root);
  let gap = gaps.find((g) => g.fingerprint === fingerprint);
  if (!gap) {
    gap = { fingerprint, kind, code, subject: cleanSubject, details: [], suggestion: '', count: 0, first_seen: now.toISOString(), last_seen: null, sent_count: 0, sent_at: null };
    gaps.push(gap);
  }
  gap.count += 1;
  gap.last_seen = now.toISOString();
  gap.snowgate_version = packageInfo().version;
  const d = redact(detail);
  if (d && !gap.details.includes(d) && gap.details.length < MAX_DETAILS) gap.details.push(d);
  const s = redact(suggestion);
  if (s) gap.suggestion = s;
  writeGaps(root, gaps);
  return gap;
}

// Not sent yet, or seen again since it was sent.
export function pendingGaps(root) {
  return readGaps(root).filter((g) => g.count > g.sent_count);
}

// Remove gaps (all, or only those already sent).
export function clearGaps(root, { sentOnly = false } = {}) {
  const gaps = readGaps(root);
  const kept = sentOnly ? gaps.filter((g) => g.count > g.sent_count) : [];
  writeGaps(root, kept);
  return gaps.length - kept.length;
}

export function markSent(root, fingerprints, now = new Date()) {
  const gaps = readGaps(root);
  for (const g of gaps) {
    if (fingerprints.includes(g.fingerprint)) {
      g.sent_count = g.count;
      g.sent_at = now.toISOString();
    }
  }
  writeGaps(root, gaps);
}

export function buildIssue(gaps) {
  const { version } = packageInfo();
  const title = gaps.length === 1
    ? `[feedback] ${gaps[0].code}: ${gaps[0].subject}`
    : `[feedback] ${gaps.length} gaps from snowgate ${version}`;
  const lines = [
    `snowgate ${version} · Node ${process.versions.node} · ${platform()}`,
    '',
    'Collected automatically by `snowgate feedback send`. Instance names, sys_ids, e-mail addresses, URLs and paths are removed.',
    '',
  ];
  for (const g of gaps) {
    lines.push(`### ${g.code}: ${g.subject}`, '', `- kind: ${g.kind}`, `- seen: ${g.count - g.sent_count} time(s) since last report (${g.count} total)`);
    for (const d of g.details) lines.push(`- detail: ${d}`);
    if (g.suggestion) lines.push(`- suggestion: ${g.suggestion}`);
    lines.push(`- fingerprint: \`${g.fingerprint}\``, '');
  }
  return { title: title.slice(0, 200), body: lines.join('\n') };
}

export function issueUrl(repo, { title, body }) {
  const base = `https://github.com/${repo}/issues/new?labels=feedback&title=${encodeURIComponent(title)}&body=`;
  let text = body;
  while (base.length + encodeURIComponent(text).length > MAX_URL && text.length > 200) {
    text = `${text.slice(0, Math.floor(text.length * 0.8))}\n\n… (shortened; the full report is in the saved Markdown file)`;
  }
  return base + encodeURIComponent(text);
}

export function saveMarkdown(root, { title, body }, now = new Date()) {
  const file = snowgateDir(root, 'feedback', `feedback-${now.toISOString().replace(/[:.]/g, '-')}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# ${title}\n\n${body}\n`);
  return file;
}

// Which refusals are worth reporting: capability gaps, and sensitive-data
// refusals (so a rule that blocks something harmless can be corrected).
const GAP_CODES = new Set(['FIELD_NOT_ALLOWED', 'TABLE_NOT_ALLOWED', 'TABLE_ACCESS', 'TOOL_UNKNOWN', 'FIELD_SENSITIVE', 'TABLE_SENSITIVE', 'QUERY_SENSITIVE', 'UI_ACTION_FAILED']);

// One gap per refused field, so the same field asked in different requests
// adds to one count.
export function gapsFromError(error, { tool }) {
  if (!GAP_CODES.has(error?.code)) return [];
  const d = error.details ?? {};
  const detail = `${tool}: ${error.message}`;
  if (error.code === 'FIELD_NOT_ALLOWED' || error.code === 'FIELD_SENSITIVE') return (d.fields ?? []).map((f) => ({ kind: 'refusal', code: error.code, subject: `${d.table}.${f}`, detail }));
  if (error.code === 'QUERY_SENSITIVE') return [{ kind: 'refusal', code: error.code, subject: 'query filter', detail }];
  // UI failures are grouped by tool and kind of failure, not by page.
  if (error.code === 'UI_ACTION_FAILED') return [{ kind: 'ui-failure', code: error.code, subject: `${tool} ${d.action ?? ''} ${d.kind ?? ''}`.replace(/\s+/g, ' ').trim(), detail }];
  const subject = error.code === 'TOOL_UNKNOWN' ? `tool ${tool}` : d.table ?? error.table ?? tool;
  return [{ kind: 'refusal', code: error.code, subject, detail }];
}
