import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { SnowgateError } from './errors.js';
import { snowgateDir } from './workspace.js';

// Per-repository settings in .snowgate/config.yaml. Generic rules ship in
// snowgate; anything project-specific (where packages live, which packages are
// grandfathered) lives here.
// ui_auth: how the gateway's browser authenticates — `profile` (SSO session in
// the dedicated snowgate profile, default) or `password` (login.do form).
const DEFAULTS = { changes_dir: 'changes', legacy_packages: [], ui_auth: 'profile' };

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
  if (!Array.isArray(config.legacy_packages)) {
    throw new SnowgateError('.snowgate/config.yaml validate.legacy_packages must be a list.', 'CONFIG_INVALID');
  }
  return config;
}
