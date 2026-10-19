import { chromium } from 'playwright';
import { ensureProfileDir } from './browser-profile.js';
import { SnowgateError } from './errors.js';

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
    return { dir };
  } finally {
    await context.close().catch(() => {});
  }
}
