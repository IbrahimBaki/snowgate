import { profileDir } from './browser-profile.js';
import { AuthError, SnowgateError } from './errors.js';
import { BrowserSession } from './playwright/session.js';
import { ReadOnlyClient } from './rest/client.js';

// Checks that credentials (or the SSO session) actually work against the
// instance, so `snowgate setup` can say so before the first task does.
// Result status: basic | session | rejected | unreachable | missing.
export async function checkAccess({ instance, user, password, uiAuth, pattern, env = process.env, origin = `https://${instance}`, fetchImpl, sessionFactory = (o) => new BrowserSession(o) }) {
  if (user && password) {
    try {
      await new ReadOnlyClient({ instance, user, password, mode: 'basic', pattern, fetchImpl }).whoami();
      return { status: 'basic', message: `REST works with ${user} (Basic auth).` };
    } catch (e) {
      if (!(e instanceof AuthError)) return { status: 'unreachable', message: `Could not check ${instance}: ${e.message}` };
    }
  }
  // Basic refused or no credentials: try the browser session.
  const session = sessionFactory({ origin, auth: uiAuth, profileDir: profileDir(instance, env), user, password });
  try {
    try {
      await session.login();
    } catch (e) {
      if (e instanceof AuthError) return { status: 'rejected', message: `${instance} rejected the user name or password.` };
      if (e instanceof SnowgateError && ['NO_SESSION', 'SESSION_EXPIRED', 'NO_CREDENTIALS'].includes(e.code)) {
        return { status: 'missing', message: e.message };
      }
      return { status: 'unreachable', message: `Could not sign in to ${instance}: ${e.message}` };
    }
    try {
      await new ReadOnlyClient({ instance, mode: 'session', sessionFetch: (url, init) => session.restFetch(String(url).replace(`https://${instance}`, origin), init), pattern }).whoami();
      return { status: 'session', message: user && password
        ? `Signed in, but ${instance} refuses Basic auth for REST; snowgate will use the browser session for REST (checked: works).`
        : `REST works through the signed-in browser session.` };
    } catch (e) {
      return { status: 'unreachable', message: `Signed in, but REST through the session failed: ${e.message}` };
    }
  } finally {
    await session.close();
  }
}
