import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { MARKER } from './adapters/install.js';
import { profileDir } from './browser-profile.js';
import { loadConfig } from './config.js';
import { resolveWorkId } from './gateway/server.js';
import { loadPack } from './pack.js';
import { validatePackages } from './validate/packages.js';
import { readWork } from './work.js';

// snowgate doctor (PLAN §9): configuration, credentials, adapters and the
// gateway-exclusivity check (A6). Read-only; it never contacts an instance.
const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const readJsonSafe = (file) => {
  const text = readText(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// A6: any Playwright MCP configured beside the gateway is a way around it.
export function rawPlaywrightServers(root, { home = homedir() } = {}) {
  const found = [];
  const scan = (where, servers) => {
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      if (/playwright/i.test(`${name} ${cfg?.command ?? ''} ${(cfg?.args ?? []).join(' ')}`)) found.push(`${where}: ${name}`);
    }
  };
  scan('.mcp.json', readJsonSafe(path.join(root, '.mcp.json'))?.mcpServers);
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) scan(f, readJsonSafe(path.join(root, f))?.mcpServers);
  const userConfig = readJsonSafe(path.join(home, '.claude.json'));
  scan('~/.claude.json', userConfig?.mcpServers);
  scan(`~/.claude.json (project ${root})`, userConfig?.projects?.[root]?.mcpServers);
  for (const toml of [path.join(root, '.codex', 'config.toml'), path.join(home, '.codex', 'config.toml')]) {
    let section = null;
    for (const line of (readText(toml) ?? '').split('\n')) {
      const header = /^\s*\[+([^\]]+)\]+/.exec(line);
      if (header) {
        section = /^mcp_servers\.(.+)$/.exec(header[1].trim())?.[1] ?? null;
        if (section && /playwright/i.test(section)) found.push(`${toml.replace(home, '~')}: ${section}`);
      } else if (section && /playwright/i.test(line)) {
        found.push(`${toml.replace(home, '~')}: ${section}`);
        section = null;
      }
    }
  }
  return found;
}

export async function doctor(root, { env = process.env, workId, home = homedir() } = {}) {
  const checks = [];
  const add = (level, message) => checks.push({ level, message });

  let pack;
  try {
    pack = loadPack();
    add('ok', `pack.yaml ${pack.name} ${pack.version} is valid.`);
  } catch (e) {
    add('error', e.message);
  }

  let config;
  try {
    config = loadConfig(root);
    add('ok', `.snowgate/config.yaml: changes_dir=${config.changes_dir}, ui_auth=${config.ui_auth}.`);
  } catch (e) {
    add('error', e.message);
  }

  const userVar = pack?.config.credentials.env?.user ?? 'SN_USER';
  const passVar = pack?.config.credentials.env?.password ?? 'SN_PASSWORD';
  const missing = [userVar, passVar].filter((v) => !env[v]);
  add(missing.length ? 'warn' : 'ok', missing.length ? `${missing.join(' and ')} not set: REST tools and discover need them.` : `${userVar} and ${passVar} are set (values not shown).`);

  const id = resolveWorkId(root, workId ?? env.SNOWGATE_WORK);
  if (!id) {
    add('warn', 'No work item (--work, SNOWGATE_WORK, or an active YallaFlow item): the gateway refuses instance tools.');
  } else {
    try {
      const { target } = readWork(root, id);
      if (!target.instance) {
        add('warn', `${id} has no confirmed target${target.candidate_instance ? ` (candidate ${target.candidate_instance})` : ''}.`);
      } else {
        add('ok', `${id} target ${target.instance}, confirmed by ${target.confirmed_by}.`);
        if (config?.ui_auth === 'profile') {
          add(existsSync(profileDir(target.instance, env)) ? 'ok' : 'warn',
            existsSync(profileDir(target.instance, env)) ? `SSO browser profile for ${target.instance} exists (validity is checked on first use).` : `No SSO browser profile for ${target.instance}: a human must run snowgate login --work ${id}.`);
        }
      }
    } catch (e) {
      add('error', e.message);
    }
  }

  const exe = chromium.executablePath();
  add(existsSync(exe) ? 'ok' : 'error', existsSync(exe) ? 'Playwright Chromium is installed.' : 'Playwright Chromium is missing: run npx playwright install chromium.');

  const raw = rawPlaywrightServers(root, { home });
  if (raw.length) add('warn', `A raw Playwright MCP is configured beside the gateway and could bypass it (PLAN §15 A6): ${raw.join('; ')}. The snowgate hooks block its tools, but remove it for this project.`);
  else add('ok', 'No raw Playwright MCP configured beside the gateway.');

  const plugin = path.join(root, '.claude', 'skills', 'snowgate');
  const managed = (f) => (readText(f) ?? '').includes(MARKER);
  if (existsSync(plugin)) {
    const ok = ['hooks/hooks.json', 'hook.mjs', 'mcp.mjs', '.mcp.json'].every((f) => existsSync(path.join(plugin, f))) && managed(path.join(plugin, 'hook.mjs'));
    add(ok ? 'ok' : 'error', ok ? 'Claude adapter installed (.claude/skills/snowgate).' : 'Claude adapter is incomplete or edited: run snowgate init --agent claude.');
  } else {
    add('info', 'Claude adapter not installed (snowgate init --agent claude).');
  }
  const codex = path.join(root, '.codex', 'config.toml');
  if (existsSync(codex)) add(managed(codex) ? 'ok' : 'warn', managed(codex) ? 'Codex adapter installed (.codex/config.toml; trust the project in Codex to load its hooks).' : '.codex/config.toml exists but is not managed by snowgate; make sure it declares [mcp_servers.snowgate] and the PreToolUse hook.');
  else add('info', 'Codex adapter not installed (snowgate init --agent codex).');

  const verify = path.join(root, '.snowgate', 'bin', 'verify-change-packages');
  add(existsSync(verify) ? 'ok' : 'info', existsSync(verify) ? 'yallaflow adapter installed (verify --script .snowgate/bin/verify-change-packages).' : 'yallaflow adapter not installed (snowgate init).');
  if (existsSync(path.join(root, '.git'))) {
    const pre = path.join(root, '.git', 'hooks', 'pre-commit');
    add(managed(pre) ? 'ok' : 'warn', managed(pre) ? 'git pre-commit hook runs snowgate validate --secrets.' : 'git pre-commit hook is not snowgate\'s: run snowgate init, or call snowgate validate --secrets from your hook.');
  }

  if (config) {
    const { errors } = validatePackages(root);
    add(errors.length ? 'warn' : 'ok', errors.length ? `snowgate validate reports ${errors.length} problem(s).` : 'Change packages validate.');
  }
  return { ok: !checks.some((c) => c.level === 'error'), checks };
}
