import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { SnowgateError } from './errors.js';

// Where ServiceNow credentials come from (PF-0008). Precedence:
//   1. the environment variables named in pack.yaml (SN_USER / SN_PASSWORD);
//   2. the store chosen in .snowgate/config.yaml `credentials:`
//        protected (default) — a per-instance 0600 file outside the project,
//                  written by `snowgate credentials set`; agent hooks deny
//                  any access to it.
//        project   — `.snowgate.env` in the project root, for dev instances
//                  where the agent may see the credentials. `snowgate init`
//                  adds it to .gitignore and `validate --secrets` refuses to
//                  commit it.
// The mode lives in .snowgate/config.yaml, which agents cannot write, so only
// a human can switch an instance to the agent-visible store.
export const PROJECT_ENV_FILE = '.snowgate.env';

export function credentialsRoot(env = process.env) {
  if (env.SNOWGATE_CREDENTIALS_DIR) return path.resolve(env.SNOWGATE_CREDENTIALS_DIR);
  const config = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(config, 'snowgate', 'credentials');
}

export function credentialsFile(instance, env = process.env) {
  if (!/^[a-z0-9.-]+$/.test(instance ?? '')) throw new SnowgateError(`"${instance}" is not an instance host.`, 'INSTANCE_INVALID');
  return path.join(credentialsRoot(env), `${instance}.json`);
}

export function projectEnvFile(root) {
  return path.join(root, PROJECT_ENV_FILE);
}

// Minimal KEY=VALUE reader: comments, optional quotes, no interpolation.
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function vars(pack) {
  return { userVar: pack.config.credentials.env?.user ?? 'SN_USER', passVar: pack.config.credentials.env?.password ?? 'SN_PASSWORD' };
}

// { user, password, source } — source names where they came from, never the values.
export function resolveCredentials(root, instance, { pack, env = process.env }) {
  const { userVar, passVar } = vars(pack);
  if (env[userVar] && env[passVar]) return { user: env[userVar], password: env[passVar], source: 'environment' };

  const mode = loadConfig(root).credentials;
  if (mode === 'project') {
    const file = projectEnvFile(root);
    if (existsSync(file)) {
      const values = parseEnvFile(readFileSync(file, 'utf8'));
      if (values[userVar] && values[passVar]) return { user: values[userVar], password: values[passVar], source: PROJECT_ENV_FILE };
    }
    return { user: null, password: null, source: null, mode };
  }
  if (instance) {
    const file = credentialsFile(instance, env);
    if (existsSync(file)) {
      try {
        const { user, password } = JSON.parse(readFileSync(file, 'utf8'));
        if (user && password) return { user, password, source: 'protected credentials file' };
      } catch {
        throw new SnowgateError(`The credentials file for ${instance} is unreadable; run snowgate credentials set again.`, 'CREDENTIALS_INVALID');
      }
    }
  }
  return { user: null, password: null, source: null, mode };
}

export function missingCredentialsHint(root, instance, workId, pack) {
  const { userVar, passVar } = vars(pack);
  const mode = loadConfig(root).credentials;
  return mode === 'project'
    ? `No credentials: put ${userVar} and ${passVar} in ${PROJECT_ENV_FILE} at the project root (agent-visible mode), or set them in the environment.`
    : `No credentials for ${instance ?? 'the target'}: a human must run snowgate credentials set --work ${workId ?? '<PF-id>'} (stored outside the project, not readable by agents), or set ${userVar}/${passVar} in the environment.`;
}

export function writeCredentials(root, instance, { user, password, pack, env = process.env }) {
  if (!user || !password) throw new SnowgateError('Both a user name and a password are required.', 'CREDENTIALS_INVALID');
  if (/[\^=\s]/.test(user)) throw new SnowgateError('The user name contains characters that cannot be used safely in an encoded query.', 'CREDENTIALS_INVALID');
  const mode = loadConfig(root).credentials;
  if (mode === 'project') {
    const { userVar, passVar } = vars(pack);
    const file = projectEnvFile(root);
    const existing = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
    const merged = { ...existing, [userVar]: user, [passVar]: password };
    const quote = (v) => (/[\s#"'$`\\]/.test(v) ? `'${v.replace(/'/g, "'\\''")}'` : v);
    writeFileSync(file, `# snowgate credentials (agent-visible mode). Never commit this file.\n${Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`).join('\n')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return { file, mode };
  }
  const file = credentialsFile(instance, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileSync(file, `${JSON.stringify({ user, password })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, mode };
}

export function removeCredentials(root, instance, { pack, env = process.env }) {
  const mode = loadConfig(root).credentials;
  if (mode === 'project') {
    const { userVar, passVar } = vars(pack);
    const file = projectEnvFile(root);
    if (!existsSync(file)) return { file, existed: false, mode };
    const kept = readFileSync(file, 'utf8').split('\n').filter((line) => !new RegExp(`^\\s*(export\\s+)?(${userVar}|${passVar})\\s*=`).test(line));
    writeFileSync(file, kept.join('\n'));
    return { file, existed: true, mode };
  }
  const file = credentialsFile(instance, env);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return { file, existed, mode };
}
