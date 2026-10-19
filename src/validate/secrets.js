import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Heuristic secret scan of files staged for commit (port of the origin's
// check_secrets.py). A cheap local backstop so a ServiceNow session cookie or
// token does not land in Git — not a replacement for a real secret scanner.
const PATTERNS = [
  [/password\s*[:=]\s*['"]?[^\s'"]{3,}/i, 'possible password literal'],
  [/api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{10,}/i, 'possible API key'],
  [/secret[_-]?(key|token)?\s*[:=]\s*['"]?[A-Za-z0-9_-]{10,}/i, 'possible secret/token'],
  [/bearer\s+[A-Za-z0-9_.-]{10,}/i, 'possible bearer token'],
  [/\bJSESSIONID\s*=\s*[A-Za-z0-9!]{10,}/i, 'possible ServiceNow session cookie'],
  [/glide_user_session\s*=\s*[A-Za-z0-9]{10,}/i, 'possible ServiceNow session value'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key material'],
  [/x-usertoken\s*[:=]\s*['"]?[A-Za-z0-9_-]{10,}/i, 'possible ServiceNow user token header'],
];
const ALLOWED_PLACEHOLDER = /<[^>]+>|xxx+|\bexample\b|\bTODO\b/i;
const EXCLUDE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.pdf'];

export function scanText(text) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    for (const [pattern, label] of PATTERNS) {
      const m = pattern.exec(line);
      if (m && !ALLOWED_PLACEHOLDER.test(m[0])) findings.push({ line: i + 1, label });
    }
  });
  return findings;
}

export function stagedFiles(root) {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !EXCLUDE_SUFFIXES.some((s) => f.toLowerCase().endsWith(s)));
}

// Findings name the file, line and kind only — never the matched value.
export function scanFiles(root, files) {
  const problems = [];
  for (const f of files) {
    const abs = path.join(root, f);
    let text;
    try {
      if (!statSync(abs).isFile()) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const { line, label } of scanText(text)) problems.push(`${f}:${line}: ${label}`);
  }
  return problems;
}
