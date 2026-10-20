import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PACK_ROOT } from '../pack.js';

// Adapters (PLAN §6): generate agent-specific files from one place. Generated
// files carry MARKER; a file without it is never overwritten.
export const MARKER = 'managed by snowgate init';

const readJson = (file) => JSON.parse(readFileSync(path.join(PACK_ROOT, file), 'utf8'));

function write(file, content, { mode } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
  return file;
}

function writeManaged(file, content, result, opts) {
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARKER)) {
    result.skipped.push({ file, reason: 'exists and is not managed by snowgate; add the snowgate entries by hand (snowgate doctor shows them)' });
    return;
  }
  result.written.push(write(file, content, opts));
}

// A tiny ES module that finds the installed snowgate and runs one entry point.
// Resolution order: SNOWGATE_HOME, the project's node_modules/snowgate, then
// the installation that ran `snowgate init`. A hook that cannot load snowgate
// exits 2, so the guard fails closed instead of silently allowing.
function shim({ home, body, failExit }) {
  return `// ${MARKER} — regenerate with \`snowgate init\`; do not edit.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function snowgateHome() {
  if (process.env.SNOWGATE_HOME) return process.env.SNOWGATE_HOME;
  try {
    return path.dirname(createRequire(path.join(here, '..', '..', '..', 'package.json')).resolve('snowgate/package.json'));
  } catch {
    return ${JSON.stringify(home)};
  }
}
const load = async (rel) => {
  const file = path.join(snowgateHome(), rel);
  if (!existsSync(file)) throw new Error(\`snowgate not found at \${file}\`);
  return import(pathToFileURL(file).href);
};
try {
${body}
} catch (e) {
  process.stderr.write(\`snowgate: could not run (\${e.message}). Reinstall snowgate or run snowgate init again.\\n\`);
  process.exitCode = ${failExit};
}
`;
}

export function installClaude(root, { home = PACK_ROOT } = {}) {
  const result = { written: [], skipped: [] };
  const dir = path.join(root, '.claude', 'skills', 'snowgate');
  const pkg = readJson('package.json');
  writeManaged(path.join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({
    name: 'snowgate',
    version: pkg.version,
    description: `ServiceNow guards and MCP gateway for this YallaFlow project (${MARKER}).`,
    author: { name: 'snowgate' },
  }, null, 2)}\n`, result);

  const hook = (event) => [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hook.mjs', event], timeout: 60 }];
  writeManaged(path.join(dir, 'hooks', 'hooks.json'), `${JSON.stringify({
    description: MARKER,
    hooks: {
      PreToolUse: [{ matcher: '.*', hooks: hook('pre-tool-use') }],
      PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: hook('post-tool-use') }],
      SessionStart: [{ hooks: hook('session-start') }],
    },
  }, null, 2)}\n`, result);

  writeManaged(path.join(dir, '.mcp.json'), `${JSON.stringify({
    mcpServers: { snowgate: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp.mjs'] } },
  }, null, 2)}\n`, result);

  writeManaged(path.join(dir, 'hook.mjs'), shim({
    home,
    failExit: 2,
    body: `  const { runHook } = await load('src/adapters/run-hook.js');
  process.exitCode = await runHook(process.argv[2]);`,
  }), result);

  // The change procedure as a plugin skill (also stated at session start).
  writeManaged(path.join(dir, 'skills', 'servicenow-changes', 'SKILL.md'), readFileSync(path.join(PACK_ROOT, 'skills', 'servicenow-changes', 'SKILL.md'), 'utf8').replace('---\n\n', `---\n\n<!-- ${MARKER} -->\n\n`), result);

  // The MCP server runs from the plugin directory; the project root is found
  // by walking up to .yallaflow/.
  writeManaged(path.join(dir, 'mcp.mjs'), shim({
    home,
    failExit: 1,
    body: `  const { main } = await load('src/cli/main.js');
  process.exitCode = await main(['mcp'], { cwd: here });`,
  }), result);
  return result;
}

const AGENTS_BEGIN = `<!-- snowgate:begin (${MARKER}) -->`;
const AGENTS_END = '<!-- snowgate:end -->';

export function installCodex(root, { home = PACK_ROOT } = {}) {
  const result = { written: [], skipped: [] };
  const bin = path.join(home, 'bin', 'snowgate.js');
  const lit = (s) => `'${s.replace(/'/g, '')}'`; // TOML literal string
  writeManaged(path.join(root, '.codex', 'config.toml'), `# ${MARKER} — regenerate with \`snowgate init --agent codex\`.
# Codex loads project hooks only after you trust this project's .codex/ layer.

[mcp_servers.snowgate]
command = "node"
args = [${lit(bin)}, "mcp"]
cwd = ${lit(root)}

[[hooks.PreToolUse]]
matcher = ".*"

[[hooks.PreToolUse.hooks]]
type = "command"
command = ${lit(`node "${bin}" hook pre-tool-use`)}
timeout = 60
statusMessage = "snowgate guard"
`, result);

  const file = path.join(root, 'AGENTS.md');
  const block = `${AGENTS_BEGIN}
## snowgate (ServiceNow)

- Reach ServiceNow instances only through the \`snowgate\` MCP tools; direct browser or Playwright tools on an instance are blocked.
- To change the instance: call \`ui_use_update_set\` first (the task's own update set), change through the UI tools, verify, record it in the YallaFlow work item, and leave the update set In Progress unless the user asks.
- Bind an instance approved for this project to your work item with \`snowgate target set <instance> --work <work-id>\`; it confirms automatically. Other instances need a human.
- Instance approval, package approvals, stored credentials and SSO sign-in are human acts (\`snowgate setup\`, \`snowgate approve\`, \`snowgate credentials set\`, \`snowgate login\`). Never edit \`.snowgate/\`.
- Verify a change made through the browser with \`yallaflow verify <id> -- snowgate check <table> <sys_id> <field>=<value>... --work <id>\` (stored values, read from the instance).
- Check change packages in \`changes/\` with \`snowgate validate\` or \`yallaflow verify <id> --script .snowgate/bin/verify-change-packages\`.
${AGENTS_END}
`;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const start = current.indexOf(AGENTS_BEGIN.slice(0, 20));
  const end = current.indexOf(AGENTS_END);
  const next = start >= 0 && end > start
    ? `${current.slice(0, start)}${block}${current.slice(end + AGENTS_END.length + 1)}`
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}`;
  result.written.push(write(file, next));
  return result;
}

// yallaflow adapter (PLAN §6): until a Pack API exists, the validator is wired
// as a YallaFlow verification script.
export function installYallaflow(root, { home = PACK_ROOT } = {}) {
  const result = { written: [], skipped: [] };
  writeManaged(path.join(root, '.snowgate', 'bin', 'verify-change-packages'), `#!/bin/sh
# ${MARKER} — used as: yallaflow verify <work-id> --script .snowgate/bin/verify-change-packages
exec node ${JSON.stringify(path.join(home, 'bin', 'snowgate.js'))} validate
`, result, { mode: 0o755 });
  return result;
}

// The agent-visible credential store (.snowgate.env) must never reach git.
export function ensureGitignore(root) {
  const result = { written: [], skipped: [] };
  const file = path.join(root, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === '.snowgate.env' || l.trim() === '/.snowgate.env')) return result;
  result.written.push(write(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# snowgate: agent-visible credentials (${MARKER})\n.snowgate.env\n`));
  return result;
}

// Agent-independent defense layer 3 (PLAN §5): a git pre-commit hook.
export function installGitHook(root, { home = PACK_ROOT } = {}) {
  const result = { written: [], skipped: [] };
  const hooks = path.join(root, '.git', 'hooks');
  if (!existsSync(path.join(root, '.git'))) {
    result.skipped.push({ file: hooks, reason: 'not a git checkout' });
    return result;
  }
  writeManaged(path.join(hooks, 'pre-commit'), `#!/bin/sh
# ${MARKER}: change-package validation and staged-file secret scan.
exec node ${JSON.stringify(path.join(home, 'bin', 'snowgate.js'))} validate --secrets
`, result, { mode: 0o755 });
  return result;
}
