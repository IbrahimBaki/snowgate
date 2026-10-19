import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { AuthError, SnowgateError } from '../errors.js';
import { classifyRequest } from '../gateway/guards.js';

// The gateway's own browser (PLAN D1 = drive Playwright directly). Every
// request from every frame passes the route handler, so the host lock and the
// update-set lock hold for iframes and Next Experience wrappers alike.
//
// Authentication (PF-0001 D1 amendment):
//   profile  (default) — the dedicated per-instance snowgate profile that a
//            human signed into via SSO with `snowgate login`; no password
//            reaches snowgate at all.
//   password — opt-in: a fresh in-memory context that fills login.do with
//            SN_USER / SN_PASSWORD (instances without SSO).
// Either way: no downloads, no service workers, popups closed, dialogs
// dismissed unless a dedicated tool takes over. There is no evaluate/run_code
// surface anywhere in this class.
export class BrowserSession {
  #origin;
  #user;
  #password;
  #launch;
  #launchPersistent;
  #auth;
  #profileDir;
  #headless;
  #browser = null;
  #context = null;
  #page = null;
  #loggedIn = false;
  #unlocked = false;
  #dialog = null;
  #blocked = [];

  constructor({
    origin,
    auth = 'profile',
    profileDir = null,
    user,
    password,
    headless = true,
    launch = (opts) => chromium.launch(opts),
    launchPersistent = (dir, opts) => chromium.launchPersistentContext(dir, opts),
  }) {
    if (auth !== 'profile' && auth !== 'password') throw new SnowgateError(`Unknown ui_auth "${auth}" (profile or password).`, 'CONFIG_INVALID');
    this.#origin = new URL(origin).origin;
    this.#auth = auth;
    this.#profileDir = profileDir;
    this.#user = user;
    this.#password = password;
    this.#headless = headless;
    this.#launch = launch;
    this.#launchPersistent = launchPersistent;
  }

  get origin() {
    return this.#origin;
  }

  async #ensureStarted() {
    if (this.#page) return;
    // Service workers are blocked: requests they make would bypass the route
    // handler, and with it the host and update-set locks.
    const options = { acceptDownloads: false, serviceWorkers: 'block' };
    if (this.#auth === 'profile') {
      if (!this.#profileDir || !existsSync(this.#profileDir)) {
        throw new SnowgateError(`No snowgate browser session for ${new URL(this.#origin).host}. A human must run: snowgate login --work <PF-id>`, 'NO_SESSION');
      }
      this.#context = await this.#launchPersistent(this.#profileDir, { ...options, headless: this.#headless });
    } else {
      this.#browser = await this.#launch({ headless: this.#headless });
      this.#context = await this.#browser.newContext(options);
    }
    await this.#context.route('**/*', (route, request) => this.#onRequest(route, request));
    this.#context.on('page', (p) => {
      if (this.#page && p !== this.#page) p.close().catch(() => {});
    });
    const [existing, ...extra] = this.#context.pages();
    for (const p of extra) await p.close().catch(() => {});
    this.#page = existing ?? (await this.#context.newPage());
    this.#page.on('dialog', (d) => (this.#dialog ? this.#dialog(d) : d.dismiss()).catch(() => {}));
  }

  // A dedicated tool may lift the update-set lock for its own call; the host
  // lock is never lifted.
  #permits(verdict) {
    return verdict.allowed || (this.#unlocked && verdict.code === 'URL_LOCKED');
  }

  #block(route, request, url, verdict) {
    this.#blocked.push({ url, reason: verdict.reason, code: verdict.code, navigation: request.isNavigationRequest() });
    return route.abort('blockedbyclient');
  }

  // route.continue() would let the browser follow redirects without asking
  // this handler again, so an allowed URL could 302 to another host or a
  // locked page. Requests are therefore fetched with redirects disabled; a
  // redirect is only handed back to the browser (which then requests the new
  // URL through this handler) after its Location passes the same checks.
  async #onRequest(route, request) {
    const url = request.url();
    const verdict = classifyRequest(url, { origin: this.#origin, body: request.postData() ?? '' });
    if (!this.#permits(verdict)) return this.#block(route, request, url, verdict);
    if (/^(about|data|blob):/i.test(url)) return route.continue();
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch {
      return route.abort('failed').catch(() => {});
    }
    const location = response.status() >= 300 && response.status() < 400 ? response.headers().location : null;
    if (location) {
      let next;
      try {
        next = new URL(location, url).toString();
      } catch {
        return this.#block(route, request, location, { reason: 'unparseable redirect', code: 'HOST_LOCKED' });
      }
      const redirectVerdict = classifyRequest(next, { origin: this.#origin });
      if (!this.#permits(redirectVerdict)) return this.#block(route, request, next, redirectVerdict);
    }
    return route.fulfill({ response }).catch(() => {});
  }

  // Runs fn(page) with the update-set lock lifted (the host lock stays). Only
  // dedicated, approval-gated tools call this; the page is left on about:blank
  // afterwards so no generic tool inherits an unlocked surface.
  async withUnlocked(fn, { onDialog } = {}) {
    await this.login();
    this.#unlocked = true;
    this.#dialog = onDialog ?? null;
    try {
      return await fn(this.#page);
    } finally {
      this.#unlocked = false;
      this.#dialog = null;
      this.#blocked = [];
      await this.#page.goto('about:blank').catch(() => {});
    }
  }

  takeBlocked() {
    const blocked = this.#blocked;
    this.#blocked = [];
    return blocked;
  }

  async login() {
    await this.#ensureStarted();
    if (this.#loggedIn) return;
    if (this.#auth === 'profile') {
      // The SSO session must still be valid: an expired one redirects to the
      // identity provider, which the host lock aborts.
      await this.#page.goto(`${this.#origin}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.#page.waitForLoadState('load').catch(() => {});
      const blocked = this.takeBlocked();
      const offTarget = blocked.some((b) => b.navigation && b.code === 'HOST_LOCKED');
      const onLogin = !this.#page.url().startsWith(this.#origin) || /\/login\.do/.test(this.#page.url()) || (await this.#page.locator('#user_password').count()) > 0;
      if (offTarget || onLogin) {
        await this.#page.goto('about:blank').catch(() => {});
        throw new SnowgateError(`The snowgate SSO session for ${new URL(this.#origin).host} has expired or is not signed in. A human must run: snowgate login --work <PF-id>`, 'SESSION_EXPIRED');
      }
      this.#loggedIn = true;
      return;
    }
    if (!this.#user || !this.#password) {
      throw new SnowgateError('ServiceNow credentials are missing (set SN_USER and SN_PASSWORD in the environment).', 'NO_CREDENTIALS');
    }
    // Standard ServiceNow login form ids. Credentials are filled here and
    // never pass through the agent or the audit trail.
    await this.#page.goto(`${this.#origin}/login.do`, { waitUntil: 'domcontentloaded' });
    await this.#page.fill('#user_name', this.#user);
    await this.#page.fill('#user_password', this.#password);
    await Promise.all([this.#page.waitForLoadState('domcontentloaded'), this.#page.click('#sysverb_login')]);
    await this.#page.waitForLoadState('load').catch(() => {});
    if (await this.#page.locator('#user_password').count()) {
      throw new AuthError(`UI login to ${new URL(this.#origin).host} failed.`);
    }
    this.#loggedIn = true;
  }

  frames() {
    return this.#page ? this.#page.frames().map((f, index) => ({ index, name: f.name(), url: f.url() })) : [];
  }

  // After every action: no frame may sit on an off-target or locked URL.
  async postCheck() {
    const blocked = this.takeBlocked();
    const bad = this.frames().find((f) => !/^(about:|chrome-error:)/.test(f.url) && !classifyRequest(f.url, { origin: this.#origin }).allowed);
    const lockedNav = blocked.find((b) => b.navigation);
    if (bad || lockedNav) {
      await this.#page.goto('about:blank').catch(() => {});
      const where = bad ? bad.url : lockedNav.url;
      const code = bad ? classifyRequest(bad.url, { origin: this.#origin }).code ?? 'URL_LOCKED' : lockedNav.code ?? 'URL_LOCKED';
      const hint = code === 'HOST_LOCKED' && this.#auth === 'profile'
        ? ' If the instance redirected to its identity provider, the SSO session has expired: a human must run snowgate login --work <PF-id>.'
        : '';
      throw new SnowgateError(
        `Refused: the action led to ${where}, which is outside what generic UI tools may reach. Update-set pages are only reachable through ui_upload_update_set / ui_preview_update_set / ui_commit_update_set.${hint}`,
        code,
      );
    }
    return blocked;
  }

  frame(index = 0) {
    const frames = this.#page.frames();
    const f = frames[index];
    if (!f) throw new SnowgateError(`No frame ${index}; ui_snapshot lists the frames.`, 'FRAME_MISSING');
    return f;
  }

  async navigate(url) {
    await this.login();
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
      if (!/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(e.message)) throw e;
    });
    await this.#page.waitForLoadState('load').catch(() => {});
  }

  async snapshot() {
    await this.login();
    const out = [];
    for (const [index, f] of this.#page.frames().entries()) {
      let aria = null;
      try {
        aria = await f.locator('body').ariaSnapshot({ timeout: 5000 });
      } catch {
        aria = null;
      }
      out.push({ index, name: f.name(), url: f.url(), aria });
    }
    return out;
  }

  // Exactly one element must match: role (+ accessible name), label, or text.
  async locate({ frame = 0, role, name, label, text, exact = false }) {
    await this.login();
    const f = this.frame(frame);
    let loc;
    if (role) loc = f.getByRole(role, name ? { name, exact } : {});
    else if (label) loc = f.getByLabel(label, { exact });
    else if (text) loc = f.getByText(text, { exact });
    else throw new SnowgateError('Give role (+ name), label, or text to locate an element.', 'LOCATOR_REQUIRED');
    const count = await loc.count();
    if (count !== 1) throw new SnowgateError(`The locator matched ${count} elements; it must match exactly one.`, 'LOCATOR_AMBIGUOUS');
    return loc;
  }

  async click(target) {
    const loc = await this.locate(target);
    await loc.click({ timeout: 10000 });
    await this.#page.waitForLoadState('load').catch(() => {});
  }

  async type(target, value, { submit = false } = {}) {
    const loc = await this.locate(target);
    if ((await loc.getAttribute('type')) === 'password') {
      throw new SnowgateError('Typing into password fields is not allowed through the gateway.', 'PASSWORD_FIELD');
    }
    await loc.fill(value, { timeout: 10000 });
    if (submit) await loc.press('Enter');
    await this.#page.waitForLoadState('load').catch(() => {});
  }

  async screenshot(file) {
    await this.login();
    await this.#page.screenshot({ path: file, fullPage: true });
  }

  pageUrl() {
    return this.#page?.url() ?? null;
  }

  async close() {
    if (this.#browser) await this.#browser.close().catch(() => {});
    else await this.#context?.close().catch(() => {});
    this.#browser = null;
    this.#context = null;
    this.#page = null;
    this.#loggedIn = false;
  }
}
