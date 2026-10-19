import { chromium } from 'playwright';
import { ensureProfileDir } from './browser-profile.js';
import { SnowgateError } from './errors.js';

// ServiceNow's session cookies (JSESSIONID, glide_user_session, ...) carry no
// expiry, and a browser drops such cookies when it closes, so the session would
// never reach the gateway's later browser on the same profile. Before closing,
// the instance host's session cookies are saved again with an explicit expiry
// so the profile keeps them. The instance's own server-side session timeout
// still applies; when it ends the gateway reports SESSION_EXPIRED. Cookies of
// other hosts (the identity provider) are left as they are.
async function keepSessionCookies(context, origin, env) {
  const hours = Number(env.SNOWGATE_SESSION_HOURS ?? 12);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) {
    throw new SnowgateError('SNOWGATE_SESSION_HOURS must be a number of hours between 0 and 168.', 'CONFIG_INVALID');
  }
  const expires = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const session = (await context.cookies(origin)).filter((c) => c.expires === -1);
  if (session.length) await context.addCookies(session.map((c) => ({ ...c, expires })));
  return session.length;
}

// `snowgate login`: a human signs into the confirmed target through SSO in a
// visible browser on the dedicated snowgate profile. The gateway's locks are
// not active here on purpose — SSO must reach the identity provider — which is
// why this is a human-only, interactive command and never a gateway tool.
export async function interactiveLogin({
  instance,
  origin = `https://${instance}`,
  env = process.env,
  waitForHuman,
  launchPersistent = (dir, opts) => chromium.launchPersistentContext(dir, opts),
}) {
  const dir = ensureProfileDir(instance, env);
  const context = await launchPersistent(dir, { headless: false, acceptDownloads: false, serviceWorkers: 'block' });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForHuman(`Sign in to ${instance} in the browser window (SSO), then press Enter here: `);
    await page.goto(`${origin}/`, { waitUntil: 'load' }).catch(() => {});
    const url = page.url();
    const signedIn = url.startsWith(origin) && !/\/login\.do/.test(url) && (await page.locator('#user_password').count()) === 0;
    if (!signedIn) {
      throw new SnowgateError(`Not signed in: the browser is at ${new URL(url).host}, not a signed-in page of ${instance}.`, 'SESSION_NOT_ESTABLISHED');
    }
    const kept = await keepSessionCookies(context, origin, env);
    return { dir, kept };
  } finally {
    await context.close().catch(() => {});
  }
}
