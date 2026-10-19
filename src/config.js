import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, parse, parseDocument } from 'yaml';
import { SnowgateError } from './errors.js';
import { snowgateDir } from './workspace.js';

// Per-repository settings in .snowgate/config.yaml. Generic rules ship in
// snowgate; anything project-specific (where packages live, which packages are
// grandfathered) lives here.
// ui_auth: how the gateway's browser authenticates — `profile` (SSO session in
// the dedicated snowgate profile, default) or `password` (login.do form).
// credentials: `protected` (per-instance file outside the project, agents
// cannot read it; default) or `project` (.snowgate.env, agent-visible, for dev).
// approved_instances: hosts a human approved once for this project (snowgate
// setup); an agent's `target set` on one of them confirms automatically.
// rest_auth: how REST authenticates — auto (Basic, then the browser session on
// 401; default), basic, or session.
// data: what REST may read — all (default; every table except sensitive
// data), listed (configuration + data_tables) or none (configuration only).
const DEFAULTS = { changes_dir: 'changes', legacy_packages: [], ui_auth: 'profile', credentials: 'protected', approved_instances: [], rest_auth: 'auto', data: 'all', data_tables: [] };

export function loadConfig(root) {
  const file = snowgateDir(root, 'config.yaml');
  if (!existsSync(file)) return { ...DEFAULTS };
  let doc;
  try {
    doc = parse(readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    throw new SnowgateError(`.snowgate/config.yaml failed to parse (${e.message}).`, 'CONFIG_INVALID');
  }
  const validate = doc.validate ?? {};
  const config = { ...DEFAULTS, ...doc, legacy_packages: validate.legacy_packages ?? doc.legacy_packages ?? [] };
  if (typeof config.changes_dir !== 'string' || !config.changes_dir || config.changes_dir.includes('..')) {
    throw new SnowgateError('.snowgate/config.yaml changes_dir must be a relative folder inside the project.', 'CONFIG_INVALID');
  }
  if (config.ui_auth !== 'profile' && config.ui_auth !== 'password') {
    throw new SnowgateError('.snowgate/config.yaml ui_auth must be "profile" or "password".', 'CONFIG_INVALID');
  }
  if (!['all', 'listed', 'none'].includes(config.data) || !Array.isArray(config.data_tables)) {
    throw new SnowgateError('.snowgate/config.yaml data must be "all", "listed" or "none", and data_tables a list.', 'CONFIG_INVALID');
  }
  if (!['auto', 'basic', 'session'].includes(config.rest_auth)) {
    throw new SnowgateError('.snowgate/config.yaml rest_auth must be "auto", "basic" or "session".', 'CONFIG_INVALID');
  }
  if (config.credentials !== 'protected' && config.credentials !== 'project') {
    throw new SnowgateError('.snowgate/config.yaml credentials must be "protected" or "project".', 'CONFIG_INVALID');
  }
  if (!Array.isArray(config.approved_instances) || config.approved_instances.some((a) => !a?.instance || !a?.approved_by || !a?.approved_at)) {
    throw new SnowgateError('.snowgate/config.yaml approved_instances entries need instance, approved_by and approved_at (use snowgate setup).', 'CONFIG_INVALID');
  }
  if (!Array.isArray(config.legacy_packages)) {
    throw new SnowgateError('.snowgate/config.yaml validate.legacy_packages must be a list.', 'CONFIG_INVALID');
  }
  return config;
}

export function approvalFor(root, instance) {
  return loadConfig(root).approved_instances.find((a) => a.instance === instance) ?? null;
}

// Rewrites .snowgate/config.yaml keys, keeping the rest of the file (and its
// comments) as they are. Only human commands (snowgate setup) call this.
export function updateConfig(root, changes) {
  const file = snowgateDir(root, 'config.yaml');
  const doc = existsSync(file) ? parseDocument(readFileSync(file, 'utf8')) : new Document({});
  for (const [key, value] of Object.entries(changes)) doc.set(key, value);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, String(doc));
  return loadConfig(root);
}
