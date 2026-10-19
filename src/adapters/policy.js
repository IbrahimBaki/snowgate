import path from 'node:path';
import { profilesRoot } from '../browser-profile.js';
import { credentialsRoot } from '../credentials.js';

// The agent-side guard policy shared by the claude and codex hooks (PLAN §10,
// §15 A6/A7). Hooks are defense layer 4: the gateway stays the primary guard.
// Every function here is pure so the rules can be tested without an agent.

// Paths the agent must not write: snowgate's own state (target confirmation,
// approvals, config, audit), the generated adapter files, and the agent
// settings that could switch the hooks off.
export function writeProtected(root) {
  return [
    path.join(root, '.snowgate'),
    path.join(root, '.claude', 'skills', 'snowgate'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.codex'),
  ];
}

// Paths the agent must not touch at all: the SSO browser profiles (cookies)
// and the protected credential store.
export function accessProtected(env = process.env) {
  return [profilesRoot(env), credentialsRoot(env)];
}

const within = (file, base) => file === base || file.startsWith(`${base}${path.sep}`);

function resolveIn(cwd, p) {
  if (typeof p !== 'string' || !p) return null;
  const expanded = p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p;
  return path.resolve(cwd, expanded);
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command']);
const READ_ONLY_COMMANDS = new Set([
  'cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'rg', 'jq', 'wc', 'stat', 'less', 'more', 'file', 'tree', 'du',
  'find', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'nl', 'column', 'realpath', 'readlink',
  'basename', 'dirname', 'cd', 'pwd', 'echo', 'printf', 'test', '[', 'snowgate', 'yallaflow',
]);
// Flags that turn an otherwise read-only command into a writer or a launcher.
const WRITING_FLAGS = /\s-(i|-in-place)\b|\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b|\bsystem\s*\(|>|\bw\s+\S/;
const GIT_COMMIT = /(^|[;&|]\s*)git\s+(-[^\s]+\s+)*commit\b/;

export const isGitCommit = (command) => GIT_COMMIT.test(command ?? '');

// Human-only commands check for a TTY, which an agent shell can fake (script,
// unbuffer, expect, a pty module). Agents therefore may not invoke them at all.
const HUMAN_ONLY = /snowgate(?:\.js)?["']?\s+(?:approve|login|setup|target\s+confirm|credentials\s+(?:set|remove)|feedback\s+send)\b/;
export const invokesHumanOnly = (text) => HUMAN_ONLY.test(text ?? '');

// Mentions of a protected path in free text (a shell command or a patch),
// by absolute path or by path relative to the project root.
function mentions(text, bases, root) {
  return bases.filter((b) => {
    const rel = path.relative(root, b);
    return text.includes(b) || (rel && !rel.startsWith('..') && text.includes(rel));
  });
}

function profileMentioned(text, env) {
  return accessProtected(env).some((base) => text.includes(base) || text.includes(base.replace(process.env.HOME ?? '\0', '~')))
    || /snowgate\/(profiles|credentials)/.test(text);
}

// Returns a deny reason, or null to let the call through.
export function preToolUse(input, { root, env = process.env }) {
  const tool = String(input?.tool_name ?? '');
  const args = input?.tool_input ?? {};
  const cwd = input?.cwd || root || process.cwd();
  const raw = JSON.stringify(args);

  // A6: the gateway must be the only way to drive a browser on an instance.
  if (/^mcp__.*playwright/i.test(tool)) {
    return 'Direct Playwright MCP tools are blocked: use the snowgate gateway tools (ui_navigate, ui_snapshot, ...), which enforce the instance and update-set locks.';
  }
  if (tool.startsWith('mcp__') && !/^mcp__(plugin_snowgate_)?snowgate__/.test(tool) && /service-now\.com/i.test(raw)) {
    return 'ServiceNow instances may only be reached through the snowgate gateway tools.';
  }

  if (SHELL_TOOLS.has(tool) && invokesHumanOnly(raw)) {
    return 'snowgate approve, snowgate login and snowgate target confirm are human-only: ask the user to run them in their own terminal.';
  }

  if (profileMentioned(raw, env)) {
    return 'The snowgate SSO browser profiles and the protected credential store hold secrets; agents may not read or change them.';
  }

  if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    const file = resolveIn(cwd, args.file_path ?? args.notebook_path ?? args.path);
    if (file && accessProtected(env).some((b) => within(file, b))) {
      return 'The snowgate SSO browser profiles and the protected credential store hold secrets; agents may not read or change them.';
    }
    if (file && root && WRITE_TOOLS.has(tool) && writeProtected(root).some((b) => within(file, b))) {
      return `${path.relative(root, file)} is protected: snowgate state, approvals, and agent settings are changed only by snowgate commands run by a human (PLAN §15 A7).`;
    }
    return null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = String(args.command ?? (Array.isArray(args.cmd) ? args.cmd.join(' ') : args.cmd ?? ''));
    if (root) {
      for (const segment of command.split(/&&|\|\||;|\|/)) {
        const words = segment.trim().split(/\s+/);
        const hits = mentions(segment, writeProtected(root), root);
        const readOnly = READ_ONLY_COMMANDS.has(words[0]) && !WRITING_FLAGS.test(segment);
        if (hits.length && !readOnly) {
          return `This command touches ${path.relative(root, hits[0])}, which only snowgate commands run by a human may change (PLAN §15 A7).`;
        }
      }
    }
    return null;
  }

  // Any other editing tool (e.g. Codex apply_patch): refuse patches that name
  // a protected path.
  if (root && mentions(raw, writeProtected(root), root).length) {
    return 'This change names a protected snowgate or agent-settings path (PLAN §15 A7).';
  }
  return null;
}
