import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SnowgateError } from './errors.js';

// The dedicated snowgate browser profile (PF-0001 D1 amendment). One profile
// per instance holds the SSO session a human established with `snowgate login`.
// It lives outside the project so it is never committed; the folder is
// owner-only because the cookies in it are a credential.
export function profilesRoot(env = process.env) {
  if (env.SNOWGATE_PROFILE_DIR) return path.resolve(env.SNOWGATE_PROFILE_DIR);
  const state = env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(state, 'snowgate', 'profiles');
}

export function profileDir(instance, env = process.env) {
  if (!/^[a-z0-9.-]+$/.test(instance ?? '')) throw new SnowgateError(`"${instance}" is not an instance host.`, 'INSTANCE_INVALID');
  return path.join(profilesRoot(env), instance);
}

export function ensureProfileDir(instance, env = process.env) {
  const dir = profileDir(instance, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function hasProfile(instance, env = process.env) {
  return existsSync(profileDir(instance, env));
}
