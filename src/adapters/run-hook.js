import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from '../config.js';
import { pendingGaps } from '../feedback.js';
import { resolveWorkId } from '../gateway/server.js';
import { scanFiles, stagedFiles } from '../validate/secrets.js';
import { validatePackages } from '../validate/packages.js';
import { readWork } from '../work.js';
import { findProjectRoot } from '../workspace.js';
import { isGitCommit, preToolUse } from './policy.js';

// `snowgate hook <event>`: one agent-agnostic entry point for Claude Code and
// Codex hooks. Both send the same stdin JSON (tool_name, tool_input, cwd) and
// both treat exit code 2 + stderr as a block that holds over allow rules.
const BLOCK = 2;

function projectRoot(input, env) {
  for (const start of [input?.cwd, env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (!start) continue;
    try {
      return findProjectRoot(start);
    } catch {
      // not inside a YallaFlow project from here
    }
  }
  return null;
}

function gitCommitGate(root) {
  const problems = validatePackages(root).errors.map((e) => `  - ${e}`);
  let secrets = [];
  try {
    secrets = scanFiles(root, stagedFiles(root)).map((s) => `  - ${s}`);
  } catch {
    // not a git checkout: nothing staged to scan
  }
  if (!problems.length && !secrets.length) return null;
  return [
    problems.length ? `Change package validation failed:\n${problems.join('\n')}` : '',
    secrets.length ? `Secret scan found possible credentials in staged files:\n${secrets.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function sessionContext(root, env = process.env) {
  const lines = ['snowgate is active in this project. ServiceNow instances are reached only through the snowgate MCP gateway tools; direct browser or Playwright tools on an instance are blocked.'];
  const workId = resolveWorkId(root, env.SNOWGATE_WORK);
  if (!workId) {
    lines.push('No YallaFlow work item is active, so the gateway refuses instance tools until one is.');
  } else {
    try {
      const { target } = readWork(root, workId);
      lines.push(target.instance
        ? `Active work item ${workId}; confirmed target ${target.instance} (confirmed by ${target.confirmed_by} at ${target.confirmed_at}).`
        : `Active work item ${workId}; no confirmed target${target.candidate_instance ? ` (candidate ${target.candidate_instance} awaits human confirmation)` : ''}.`);
    } catch {
      lines.push(`Active work item ${workId} is not a YallaFlow work item in this project.`);
    }
  }
  const approved = loadConfig(root).approved_instances.map((a) => a.instance);
  lines.push(approved.length
    ? `Instances approved for this project: ${approved.join(', ')}. To work on one, bind it to the active work item yourself with \`snowgate target set <instance> --work <work-id>\` (it confirms automatically), then use the gateway tools or \`snowgate discover --work <work-id>\`.`
    : 'No instances are approved for this project yet; a human runs snowgate setup.');
  const changes = path.join(root, loadConfig(root).changes_dir);
  if (existsSync(changes)) {
    const states = [];
    for (const entry of readdirSync(changes).sort()) {
      const manifest = path.join(changes, entry, 'manifest.yaml');
      if (entry.startsWith('_') || !existsSync(manifest)) continue;
      try {
        const m = parse(readFileSync(manifest, 'utf8')) ?? {};
        states.push(`${m.change_id ?? entry}: ${m.lifecycle_state ?? '?'}`);
      } catch {
        states.push(`${entry}: manifest unreadable`);
      }
    }
    if (states.length) lines.push(`Change packages: ${states.join('; ')}.`);
    const { errors } = validatePackages(root);
    if (errors.length) lines.push(`snowgate validate currently reports ${errors.length} problem(s).`);
  }
  const data = loadConfig(root).data;
  lines.push(data === 'all'
    ? 'Data access: any table and field on the target can be read with sn_query/sn_get_record, except sensitive data (password fields, secret/token/credential-like names, session/token/credential tables). A project can limit this with data: listed or none in .snowgate/config.yaml.'
    : `Data access is limited by this project (data: ${data}): configuration tables${data === 'listed' ? ' plus data_tables' : ''} only; sensitive data is never readable.`);
  lines.push('To change something on the instance: the task lives in YallaFlow (work on its active work item). (1) Call ui_use_update_set first, and change nothing until it reports current: true. (2) Make the change in the browser with ui_navigate / ui_type / ui_click. (3) Verify it with sn_get_record or ui_snapshot. (4) Record the update set and the changed records in the YallaFlow work item. (5) Leave the update set In Progress: do not complete, back out, export or commit unless the user asks.');
  lines.push('When snowgate does not let you see or do something you need, call the sn_report_gap tool; refused fields, tables and tools are recorded automatically.');
  const pending = pendingGaps(root).length;
  if (pending) lines.push(`${pending} feedback gap(s) have not been sent to the snowgate developers; suggest that the user runs snowgate feedback send.`);
  lines.push('Discovery results in .snowgate/discovery/<instance>/<time>/ (report.md, project-map.json) are readable; .snowgate/ is never edited by agents.');
  if (loadConfig(root).credentials === 'project') {
    lines.push('Credentials are in agent-visible mode (.snowgate.env, dev instances); with ui_auth: password the gateway signs in again by itself when the session ends.');
  }
  lines.push('Instance approval, package approvals, credentials and SSO sign-in are human acts (snowgate setup, snowgate approve, snowgate credentials set, snowgate login). Change-package checks run with snowgate validate (or yallaflow verify <id> --script .snowgate/bin/verify-change-packages).');
  return lines.join('\n');
}

export async function runHook(event, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let input = {};
  try {
    const raw = await new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding?.('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data));
      stdin.on('error', reject);
    });
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    if (event === 'pre-tool-use') {
      stderr.write('snowgate: hook input could not be read; refusing for safety.\n');
      return BLOCK;
    }
    return 0;
  }
  const root = projectRoot(input, env);

  if (event === 'pre-tool-use') {
    const reason = preToolUse(input, { root, env });
    if (reason) {
      stderr.write(`snowgate: ${reason}\n`);
      return BLOCK;
    }
    if (root && (input.tool_name === 'Bash' || input.tool_name === 'shell') && isGitCommit(input.tool_input?.command)) {
      const failure = gitCommitGate(root);
      if (failure) {
        stderr.write(`snowgate: commit blocked.\n${failure}\n`);
        return BLOCK;
      }
    }
    return 0;
  }

  if (event === 'post-tool-use') {
    const file = input.tool_input?.file_path;
    if (!root || !file) return 0;
    const changes = path.join(root, loadConfig(root).changes_dir);
    if (!path.resolve(input.cwd || root, file).startsWith(`${changes}${path.sep}`)) return 0;
    const { errors } = validatePackages(root);
    if (errors.length) {
      stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `snowgate validate reports:\n${errors.map((e) => `- ${e}`).join('\n')}` },
      }));
    }
    return 0;
  }

  if (event === 'session-start') {
    if (!root) return 0;
    stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(root, env).slice(0, 9000) } }));
    return 0;
  }

  stderr.write(`snowgate: unknown hook event ${event}\n`);
  return 0;
}
