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
  #missingHint;
  #userToken = null;
  #opening = false;

  constructor({
    origin,
    auth = 'profile',
    profileDir = null,
    user,
    password,
    headless = true,
    missingHint = null,
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
    this.#missingHint = missingHint;
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
    // Popups opened by a page are closed; pages the gateway opens itself are not.
    this.#context.on('page', (p) => {
      if (this.#opening || !this.#page || p === this.#page) return;
      p.close().catch(() => {});
    });
    const [existing, ...extra] = this.#context.pages();
    for (const p of extra) await p.close().catch(() => {});
    this.#attach(existing ?? (await this.#context.newPage()));
  }

  // Dialogs: a "leave page?" (beforeunload) prompt is accepted, since leaving
  // was asked for explicitly — dismissing it cancels the navigation itself
  // (net::ERR_ABORTED). Alerts and confirms are dismissed unless a dedicated
  // tool handles them.
  #attach(page) {
    this.#page = page;
    page.on('dialog', (d) => {
      const answer = d.type() === 'beforeunload' ? d.accept() : this.#dialog ? this.#dialog(d) : d.dismiss();
      return Promise.resolve(answer).catch(() => {});
    });
  }

  // Leave whatever the page is doing: a fresh page in the same context keeps
  // the session (cookies) but none of the old page's state.
  async #resetPage() {
    const old = this.#page;
    this.#opening = true;
    try {
      this.#attach(await this.#context.newPage());
    } finally {
      this.#opening = false;
    }
    await old?.close({ runBeforeUnload: false }).catch(() => {});
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
      // Never leave a locked page (or a half-submitted form) behind.
      await this.#resetPage();
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
      throw new SnowgateError(this.#missingHint ?? 'ServiceNow credentials are missing.', 'NO_CREDENTIALS');
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

  // REST through the signed-in browser session (PF-0010), for instances that
  // refuse Basic auth: the session cookies plus the token the UI itself sends
  // (g_ck) as X-UserToken. GET only, and only to the confirmed target origin.
  async restFetch(input, init = {}) {
    const url = String(input);
    if ((init.method ?? 'GET') !== 'GET') throw new SnowgateError('The session REST path is read-only (GET).', 'METHOD_NOT_ALLOWED');
    if (new URL(url).origin !== this.#origin) throw new SnowgateError(`Refused: ${url} is not on the confirmed target.`, 'HOST_LOCKED');
    await this.login();
    const get = async () => {
      this.#userToken ??= await this.#fetchUserToken();
      const headers = { ...(init.headers ?? {}), 'X-UserToken': this.#userToken };
      delete headers.Authorization;
      return this.#context.request.get(url, { headers, maxRedirects: 0, failOnStatusCode: false });
    };
    let res = await get();
    if (res.status() === 401) {
      // The token or the session ended: renew once (password sign-in renews
      // the session; an SSO profile reports SESSION_EXPIRED).
      this.#userToken = null;
      this.#loggedIn = false;
      await this.login();
      res = await get();
    }
    return { status: res.status(), ok: res.ok(), json: () => res.json() };
  }

  // Same-origin redirects only (navpage.do redirects to the Next Experience
  // shell on newer instances).
  async #getSameOrigin(url, hops = 5) {
    let current = url;
    for (let i = 0; i <= hops; i += 1) {
      const res = await this.#context.request.get(current, { maxRedirects: 0, failOnStatusCode: false });
      const location = res.status() >= 300 && res.status() < 400 ? res.headers().location : null;
      if (!location) return res;
      const next = new URL(location, current);
      if (next.origin !== this.#origin) return res;
      current = next.toString();
    }
    return null;
  }

  async #fetchUserToken() {
    for (const page of ['/navpage.do', '/']) {
      const res = await this.#getSameOrigin(`${this.#origin}${page}`);
      const html = res?.ok() ? await res.text() : '';
      const token = /g_ck\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1] ?? /"g_ck"\s*:\s*"([^"]+)"/.exec(html)?.[1];
      if (token) return token;
    }
    throw new SnowgateError('Signed in, but the instance did not provide a session token for REST (g_ck).', 'SESSION_TOKEN_MISSING');
  }

  frames() {
    return this.#page ? this.#page.frames().map((f, index) => ({ index, name: f.name(), url: f.url() })) : [];
  }

  // After every action: no frame may sit on an off-target or locked URL.
  // Frames keep loading after the main page's load event, so wait for the
  // network to settle first; otherwise a frame request blocked a moment later
  // would be missed (and wrongly blamed on the next action).
  async postCheck() {
    await this.#page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    const blocked = this.takeBlocked();
    const bad = this.frames().find((f) => !/^(about:|chrome-error:)/.test(f.url) && !classifyRequest(f.url, { origin: this.#origin }).allowed);
    const lockedNav = blocked.find((b) => b.navigation);
    if (bad || lockedNav) {
      await this.#resetPage();
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

  // Password login only: did the instance end the session and show its login
  // form (top level or inside gsft_main)?
  async #sessionEnded() {
    if (this.#auth !== 'password' || !this.#page) return false;
    if (/\/login\.do/.test(this.#page.url())) return true;
    for (const f of this.#page.frames()) {
      if (await f.locator('#user_password').count().catch(() => 0)) return true;
    }
    return false;
  }

  // Signs in again with the configured credentials; the caller decides
  // whether the interrupted action can simply be repeated.
  async #renewIfEnded() {
    if (!(await this.#sessionEnded())) return false;
    this.#loggedIn = false;
    this.takeBlocked();
    await this.login();
    return true;
  }

  async #goto(url) {
    await this.#page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
      if (!/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(e.message)) throw e;
    });
    await this.#page.waitForLoadState('load').catch(() => {});
  }

  async navigate(url) {
    await this.login();
    // Requests blocked late by an earlier action must not fail this one.
    this.takeBlocked();
    await this.#goto(url);
    // Navigation is safe to repeat after an automatic re-login.
    if (await this.#renewIfEnded()) await this.#goto(url);
  }

  async #afterInteraction() {
    if (await this.#renewIfEnded()) {
      throw new SnowgateError('The instance session had ended; snowgate signed in again. Navigate back to the page and repeat the action.', 'SESSION_RENEWED');
    }
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
    this.takeBlocked();
    await loc.click({ timeout: 10000 });
    await this.#page.waitForLoadState('load').catch(() => {});
    await this.#afterInteraction();
  }

  async type(target, value, { submit = false } = {}) {
    const loc = await this.locate(target);
    this.takeBlocked();
    if ((await loc.getAttribute('type')) === 'password') {
      throw new SnowgateError('Typing into password fields is not allowed through the gateway.', 'PASSWORD_FIELD');
    }
    await loc.fill(value, { timeout: 10000 });
    if (submit) await loc.press('Enter');
    await this.#page.waitForLoadState('load').catch(() => {});
    await this.#afterInteraction();
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
