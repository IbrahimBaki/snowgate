import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { installClaude, installCodex, installGitHook, installYallaflow, MARKER } from '../src/adapters/install.js';
import { preToolUse } from '../src/adapters/policy.js';
import { doctor, rawPlaywrightServers } from '../src/doctor.js';
import { profilesRoot } from '../src/browser-profile.js';
import { makeProject } from './helpers.js';

const WORK = 'PF-0001';
const env = { SNOWGATE_PROFILE_DIR: '/tmp/snowgate-test-profiles' };
const deny = (root, tool_name, tool_input) => preToolUse({ tool_name, tool_input, cwd: root }, { root, env });

test('policy: raw Playwright and other browsers on an instance are blocked; snowgate tools pass', () => {
  const root = makeProject(WORK);
  assert.match(deny(root, 'mcp__playwright__browser_navigate', { url: 'https://example.com' }), /Playwright/);
  assert.match(deny(root, 'mcp__plugin_x_playwright__browser_click', {}), /Playwright/);
  assert.match(deny(root, 'mcp__claude-in-chrome__navigate', { url: 'https://dev1.service-now.com/' }), /snowgate gateway/);
  assert.equal(deny(root, 'mcp__claude-in-chrome__navigate', { url: 'https://docs.example.com/' }), null);
  assert.equal(deny(root, 'mcp__plugin_snowgate_snowgate__ui_navigate', { url: 'https://dev1.service-now.com/' }), null);
  assert.equal(deny(root, 'mcp__snowgate__sn_query', { table: 'sys_scope', fields: ['sys_id'] }), null);
});

test('policy: agents cannot write snowgate state, adapter files or agent settings (A7)', () => {
  const root = makeProject(WORK);
  for (const rel of ['.snowgate/work/PF-0001.yaml', '.snowgate/approvals/PF-0001.jsonl', '.snowgate/config.yaml', '.claude/skills/snowgate/hooks/hooks.json', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml']) {
    assert.match(deny(root, 'Write', { file_path: path.join(root, rel), content: 'x' }) ?? '', /protected/, rel);
    assert.match(deny(root, 'Edit', { file_path: path.join(root, rel), old_string: 'a', new_string: 'b' }) ?? '', /protected/, rel);
  }
  assert.equal(deny(root, 'Write', { file_path: path.join(root, 'changes/CHG-1/plan.md'), content: 'x' }), null);
  assert.equal(deny(root, 'Read', { file_path: path.join(root, '.snowgate/audit/PF-0001.jsonl') }), null);
  assert.equal(deny(root, 'Write', { file_path: path.join(root, 'notes.md'), content: 'mentions .snowgate/approvals in text' }), null);
});

test('policy: shell commands may read but not change protected paths', () => {
  const root = makeProject(WORK);
  assert.equal(deny(root, 'Bash', { command: 'cat .snowgate/audit/PF-0001.jsonl | tail -5' }), null);
  assert.equal(deny(root, 'Bash', { command: 'snowgate target show --work PF-0001' }), null);
  assert.equal(deny(root, 'Bash', { command: 'npm test' }), null);
  for (const command of [
    'echo "{}" >> .snowgate/approvals/PF-0001.jsonl',
    'rm -rf .snowgate',
    'sed -i s/x/y/ .snowgate/work/PF-0001.yaml',
    `cp /tmp/x ${path.join(root, '.claude/settings.json')}`,
    'git add . && mv evil.json .claude/skills/snowgate/hooks/hooks.json',
  ]) {
    assert.ok(deny(root, 'Bash', { command }), command);
  }
});

test('policy: agents can read discovery output with ordinary shell tools, but not write it', () => {
  const root = makeProject(WORK);
  for (const command of [
    'find .snowgate/discovery -name report.md',
    'cd .snowgate/discovery && ls -la',
    "sed -n '1,80p' .snowgate/discovery/x/report.md",
    "awk '/Hazards/,/Project map/' .snowgate/discovery/x/report.md",
    'tree .snowgate/discovery | head',
    'jq .by_type .snowgate/discovery/x/project-map.json',
  ]) {
    assert.equal(deny(root, 'Bash', { command }), null, command);
  }
  for (const command of [
    'find .snowgate -name "*.yaml" -delete',
    'find .snowgate -exec rm {} \\;',
    "sed -i 's/a/b/' .snowgate/work/PF-0001.yaml",
    "awk '{print > \".snowgate/approvals/x\"}' f",
    'echo x > .snowgate/work/PF-0001.yaml',
    "awk 'BEGIN{system(\"rm -rf .snowgate\")}'",
  ]) {
    assert.ok(deny(root, 'Bash', { command }), command);
  }
});

test('policy: agents cannot run human-only commands, even through a fake TTY', () => {
  const root = makeProject(WORK);
  for (const command of [
    'snowgate approve --work PF-0001 --package CHG-1 --for commit',
    'echo CHG-1 | script -qc "snowgate approve --work PF-0001 --package CHG-1 --for commit" /dev/null',
    'unbuffer snowgate target confirm --work PF-0001',
    'node /opt/snowgate/bin/snowgate.js login --work PF-0001',
    'npx snowgate   target   confirm --work PF-0001',
  ]) {
    assert.match(deny(root, 'Bash', { command }) ?? '', /human-only/, command);
  }
  assert.equal(deny(root, 'Bash', { command: 'snowgate target show --work PF-0001' }), null);
  assert.equal(deny(root, 'Bash', { command: 'snowgate target set dev1.service-now.com --work PF-0001' }), null);
  assert.match(deny(root, 'exec_command', { cmd: ['bash', '-lc', 'snowgate approve --work PF-0001 --package X --for plan'] }) ?? '', /human-only/);
  // Documentation that mentions the commands is not an invocation.
  assert.equal(deny(root, 'Write', { file_path: path.join(root, 'README.md'), content: 'Run snowgate approve --work PF-0001 yourself.' }), null);
});

test('policy: the SSO profile is off limits to every tool', () => {
  const root = makeProject(WORK);
  const profile = path.join(profilesRoot(env), 'dev1.service-now.com', 'Default', 'Cookies');
  assert.match(deny(root, 'Read', { file_path: profile }), /SSO/);
  assert.match(deny(root, 'Bash', { command: `sqlite3 ${profile} .dump` }), /SSO/);
  assert.match(deny(root, 'Bash', { command: 'ls ~/.local/state/snowgate/profiles' }), /SSO/);
  assert.match(deny(root, 'Grep', { pattern: 'x', path: profilesRoot(env) }), /SSO/);
});

test('policy: a Codex apply_patch naming a protected path is refused', () => {
  const root = makeProject(WORK);
  assert.ok(deny(root, 'apply_patch', { command: '*** Begin Patch\n*** Update File: .snowgate/work/PF-0001.yaml\n' }));
  assert.equal(deny(root, 'apply_patch', { command: '*** Begin Patch\n*** Update File: src/app.js\n' }), null);
});

test('policy: each line of a multi-line command is judged alone; quoted scripts and heredocs stay whole', () => {
  const root = makeProject(WORK);
  // PF-0007 trial: an assignment line, then yallaflow with a summary naming .snowgate.
  assert.equal(deny(root, 'Bash', { command: 'W=PF-0001\nyallaflow checkpoint $W --skill verification --complete --summary "no .snowgate files changed"' }), null);
  assert.equal(deny(root, 'Bash', { command: 'cat .snowgate/audit/PF-0001.jsonl 2>&1 | tail -5' }), null);
  assert.equal(deny(root, 'Bash', { command: 'ls .snowgate >/dev/null 2>&1 && echo ok' }), null);
  // Writes are still refused, on their own line or hidden in a script.
  assert.ok(deny(root, 'Bash', { command: 'W=1\nrm -rf .snowgate/approvals' }));
  assert.ok(deny(root, 'Bash', { command: 'W=1\necho x > .snowgate/work/PF-0001.yaml' }));
  assert.ok(deny(root, 'Bash', { command: 'node -e "1; test = require(\'fs\').writeFileSync(\'.snowgate/x\', \'\')"' }));
  assert.ok(deny(root, 'Bash', { command: 'node -e "\ntest = require(\'fs\').writeFileSync(\'.snowgate/x\', \'\')"' }));
  assert.ok(deny(root, 'Bash', { command: "python3 - <<EOF\ntest = open('.snowgate/x', 'w')\nEOF" }));
  assert.ok(deny(root, 'Bash', { command: 'cat .snowgate/a > .snowgate/b' }));
});

// --- generated adapter files -------------------------------------------------

function runShim(shim, event, input, extraEnv = {}) {
  return spawnSync(process.execPath, [shim, event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
  });
}

test('claude adapter: a project plugin whose hooks and MCP server use ${CLAUDE_PLUGIN_ROOT}', () => {
  const root = makeProject(WORK);
  const { written, skipped } = installClaude(root);
  assert.equal(skipped.length, 0);
  const dir = path.join(root, '.claude', 'skills', 'snowgate');
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'snowgate');
  const hooks = JSON.parse(readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const event of ['PreToolUse', 'PostToolUse', 'SessionStart']) {
    const h = hooks[event][0].hooks[0];
    assert.equal(h.command, 'node');
    assert.equal(h.args[0], '${CLAUDE_PLUGIN_ROOT}/hook.mjs');
  }
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.snowgate.args, ['${CLAUDE_PLUGIN_ROOT}/mcp.mjs']);
  assert.ok(written.length >= 5);
});

test('claude adapter: the hook shim blocks with exit 2, allows with 0, and fails closed', () => {
  const root = makeProject(WORK);
  installClaude(root);
  const shim = path.join(root, '.claude', 'skills', 'snowgate', 'hook.mjs');
  const blocked = runShim(shim, 'pre-tool-use', { tool_name: 'Write', tool_input: { file_path: path.join(root, '.snowgate/approvals/PF-0001.jsonl') }, cwd: root });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /protected/);
  const allowed = runShim(shim, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root });
  assert.equal(allowed.status, 0, allowed.stderr);
  const broken = runShim(shim, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root }, { SNOWGATE_HOME: '/nonexistent' });
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /could not run/);
});

test('claude adapter: the git commit gate blocks an invalid change package', () => {
  const root = makeProject(WORK);
  installClaude(root);
  mkdirSync(path.join(root, 'changes', 'BAD-pkg'), { recursive: true });
  writeFileSync(path.join(root, 'changes', 'BAD-pkg', 'manifest.yaml'), 'change_id: BAD\n');
  const shim = path.join(root, '.claude', 'skills', 'snowgate', 'hook.mjs');
  const r = runShim(shim, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' }, cwd: root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Change package validation failed/);
  const other = runShim(shim, 'pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: root });
  assert.equal(other.status, 0);
});

test('claude adapter: SessionStart reports the work item and target state; PostToolUse reports validation', () => {
  const root = makeProject(WORK);
  installClaude(root);
  const shim = path.join(root, '.claude', 'skills', 'snowgate', 'hook.mjs');
  const s = runShim(shim, 'session-start', { cwd: root }, { SNOWGATE_WORK: WORK });
  assert.equal(s.status, 0, s.stderr);
  const ctx = JSON.parse(s.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, /PF-0001; no confirmed target/);

  mkdirSync(path.join(root, 'changes', 'BAD-pkg'), { recursive: true });
  writeFileSync(path.join(root, 'changes', 'BAD-pkg', 'manifest.yaml'), 'change_id: BAD\n');
  const p = runShim(shim, 'post-tool-use', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'changes', 'BAD-pkg', 'manifest.yaml') }, cwd: root });
  assert.match(JSON.parse(p.stdout).hookSpecificOutput.additionalContext, /missing required key/);
});

test('adapters never overwrite files they do not manage', () => {
  const root = makeProject(WORK);
  mkdirSync(path.join(root, '.codex'), { recursive: true });
  writeFileSync(path.join(root, '.codex', 'config.toml'), 'model = "x"\n');
  const r = installCodex(root);
  assert.equal(readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8'), 'model = "x"\n');
  assert.equal(r.skipped.length, 1);
});

test('codex adapter: config.toml declares the gateway and the PreToolUse hook; AGENTS.md gets one block', () => {
  const root = makeProject(WORK);
  writeFileSync(path.join(root, 'AGENTS.md'), '# Project\n\nExisting text.\n');
  installCodex(root);
  installCodex(root); // idempotent
  const toml = readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.snowgate\]/);
  assert.match(toml, /\[\[hooks\.PreToolUse\]\]/);
  assert.match(toml, /hook pre-tool-use/);
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Existing text\./);
  assert.equal(agents.split('snowgate:begin').length, 2);
});

test('yallaflow adapter: an executable verify script that runs snowgate validate', () => {
  const root = makeProject(WORK);
  installYallaflow(root);
  const script = path.join(root, '.snowgate', 'bin', 'verify-change-packages');
  assert.equal(statSync(script).mode & 0o111, 0o111);
  const r = spawnSync(script, [], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /validation passed/);
});

test('git adapter: pre-commit runs validate --secrets, and only in a git checkout', () => {
  const root = makeProject(WORK);
  assert.equal(installGitHook(root).skipped[0].reason, 'not a git checkout');
  mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  installGitHook(root);
  assert.match(readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), /validate --secrets/);
});

test('doctor flags a raw Playwright MCP beside the gateway (A6)', async () => {
  const root = makeProject(WORK);
  const home = makeProject('PF-0002'); // an empty fake home
  assert.deepEqual(rawPlaywrightServers(root, { home }), []);
  writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }));
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.browser]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n');
  const found = rawPlaywrightServers(root, { home });
  assert.equal(found.length, 2, found.join('\n'));
  const report = await doctor(root, { env: {}, home });
  assert.ok(report.checks.some((c) => c.level === 'warn' && /raw Playwright MCP/.test(c.message)));
});

test('init + doctor through the CLI', () => {
  const root = makeProject(WORK);
  const bin = path.resolve('bin/snowgate.js');
  const init = spawnSync(process.execPath, [bin, 'init', '--agent', 'claude'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.ok(existsSync(path.join(root, '.claude', 'skills', 'snowgate', 'hook.mjs')));
  assert.ok(readFileSync(path.join(root, '.claude', 'skills', 'snowgate', 'hook.mjs'), 'utf8').includes(MARKER));
  const doc = spawnSync(process.execPath, [bin, 'doctor'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.match(doc.stdout, /Claude adapter installed/);
  assert.equal(spawnSync(process.execPath, [bin, 'init'], { cwd: root }).status, 2);
});
