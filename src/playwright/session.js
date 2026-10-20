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
// What an element is, for choosing how to set it.
function describe(loc) {
  return loc.evaluate((e) => ({
    tag: e.tagName.toLowerCase(),
    type: (e.getAttribute('type') || e.type || '').toLowerCase(),
    id: e.id || '',
    hidden: e.offsetParent === null && getComputedStyle(e).position !== 'fixed',
    value: 'value' in e ? e.value : null,
    selected: e.tagName === 'SELECT' ? e.selectedOptions[0]?.text?.trim() ?? null : null,
    options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.text.trim()).slice(0, 30) : [],
  }));
}

const ANSI = /\u001b\[[0-9;]*m/g;

// Playwright errors become short, actionable snowgate errors.
async function uiStep(action, fn, extra = '') {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SnowgateError) throw e;
    const first = String(e.message).replace(ANSI, '').split('\n')[0].replace(/^locator\.\w+:\s*/, '');
    const kind = /not an <input>|not a <select>|not a checkbox/i.test(first) ? 'wrong-kind' : /Timeout/i.test(first) ? 'timeout' : 'other';
    const hint = kind === 'wrong-kind' ? 'Use ui_type with the option text for dropdowns and "true"/"false" for checkboxes, or ui_select for portal and reference pickers.'
      : kind === 'timeout' ? 'The element did not respond; check it with ui_snapshot. Dropdown options are picked with ui_select, not ui_click.'
        : 'Check the element with ui_snapshot.';
    throw new SnowgateError(`${action} failed: ${first}${extra ? ` (${extra})` : ''}. ${hint}`, 'UI_ACTION_FAILED', { action, kind });
  }
}

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
  // prefer: when several elements match (a portal label also names its group
  // and its select2 control), the one that is a field of this kind wins.
  async locate({ frame = 0, role, name, label, text, exact = false, nth }, { prefer } = {}) {
    await this.login();
    const f = this.frame(frame);
    let loc;
    if (role) loc = f.getByRole(role, name ? { name, exact } : {});
    else if (label) loc = f.getByLabel(label, { exact });
    else if (text) loc = f.getByText(text, { exact });
    else throw new SnowgateError('Give role (+ name), label, or text to locate an element.', 'LOCATOR_REQUIRED');
    // Pages that render late (Angular in the portal) get a moment to show it.
    let count = await loc.count();
    if (count === 0) {
      await loc.first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
      count = await loc.count();
    }
    // A position among matches shifts when the page adds elements (an open
    // dropdown does), so a chosen element is pinned by its id when it has one.
    const pin = async (one) => {
      const id = await one.evaluate((e) => e.id).catch(() => '');
      return id ? f.locator(`[id="${id.replace(/"/g, '\\"')}"]`) : one;
    };
    if (nth !== undefined) {
      if (nth >= count) throw new SnowgateError(`nth ${nth} is out of range: the locator matched ${count} element(s).`, 'LOCATOR_AMBIGUOUS');
      return pin(loc.nth(nth));
    }
    if (count === 0) throw new SnowgateError('The locator matched no element; check the frame and names with ui_snapshot.', 'LOCATOR_AMBIGUOUS');
    // prefer is an ordered list of tag groups: the first group with exactly
    // one match wins (a select first, then a single text input).
    if (count > 1 && prefer) {
      const tags = await loc.evaluateAll((els) => els.map((e) => e.tagName.toLowerCase()));
      for (const group of prefer) {
        const fields = tags.map((t, i) => (group.includes(t) ? i : -1)).filter((i) => i >= 0);
        if (fields.length === 1) return pin(loc.nth(fields[0]));
      }
    }
    if (count > 1) throw new SnowgateError(`The locator matched ${count} elements; pass nth (0-${count - 1}) to pick one, e.g. nth: 0 for the first form button.`, 'LOCATOR_AMBIGUOUS');
    return loc;
  }

  async click(target) {
    const loc = await this.locate(target);
    this.takeBlocked();
    await uiStep('click', () => loc.click({ timeout: 10000 }));
    await this.#page.waitForLoadState('load').catch(() => {});
    await this.#afterInteraction();
  }

  // Fills a field according to what it is: text is typed, a dropdown gets the
  // option chosen, a checkbox or radio is set from "true"/"false".
  async type(target, value, { submit = false } = {}) {
    const loc = await this.locate(target, { prefer: [['select'], ['input', 'textarea']] });
    this.takeBlocked();
    const el = await describe(loc);
    if (el.type === 'password') {
      throw new SnowgateError('Typing into password fields is not allowed through the gateway.', 'PASSWORD_FIELD');
    }
    if (el.tag === 'select') {
      await this.#choose(target, loc, el, value);
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      await uiStep('check', () => loc.setChecked(/^(true|yes|1|on|checked)$/i.test(String(value)), { timeout: 10000 }));
    } else {
      await uiStep('type', () => loc.fill(value, { timeout: 10000 }));
      if (submit) await loc.press('Enter');
    }
    await this.#page.waitForLoadState('load').catch(() => {});
    await this.#afterInteraction();
  }

  // ui_select: pick an option by its visible text in a native dropdown, a
  // Service Portal select2 dropdown, or an autocomplete/reference field.
  async select(target, option) {
    const loc = await this.locate(target, { prefer: [['select'], ['input']] });
    this.takeBlocked();
    const el = await describe(loc);
    if (el.tag === 'select') {
      await this.#choose(target, loc, el, option);
    } else {
      // Autocomplete or reference input: type, then pick from the list.
      await uiStep('type', () => loc.fill(option, { timeout: 10000 }));
      await this.#pickFromList(this.frame(target.frame ?? 0), option);
    }
    await this.#page.waitForLoadState('load').catch(() => {});
    await this.#afterInteraction();
    return describe(loc);
  }

  async #choose(target, loc, el, option) {
    const frame = this.frame(target.frame ?? 0);
    // Known options are checked up front: no waiting for one that is not there.
    const values = await loc.evaluate((e) => [...e.options].map((o) => o.value));
    if (el.options.length && !el.options.includes(option) && !values.includes(option)) {
      throw new SnowgateError(`"${option}" is not one of: ${el.options.join(', ')}.`, 'UI_ACTION_FAILED', { action: 'select', kind: 'option-not-found' });
    }
    // select2 (Service Portal) owns the value whenever its control exists; the
    // real <select> is only moved off-screen, and setting it directly is undone.
    const control = el.id ? frame.locator(`[id="s2id_${el.id}"]`).locator('a.select2-choice, .select2-choices').first() : null;
    if (control && (await control.count())) {
      await uiStep('open dropdown', () => control.click({ timeout: 10000 }));
      // After a previous choice select2 keeps focus on its own input and a
      // click may not reopen it; the keyboard (arrow down) always does.
      const open = frame.locator('.select2-drop-active .select2-result-label').first();
      if (!(await open.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false))) {
        const focusser = frame.locator(`[id="s2id_${el.id}"] .select2-focusser`).first();
        if (await focusser.count()) {
          await focusser.focus().catch(() => {});
          await focusser.press('ArrowDown').catch(() => {});
        }
      }
      await this.#pickFromList(frame, option);
    } else {
      await uiStep('select', () => loc.selectOption(el.options.includes(option) ? { label: option } : option, { timeout: 10000, force: el.hidden }));
    }
    // The page updates the field asynchronously (Angular in the portal).
    let now = await describe(loc);
    for (let i = 0; i < 20 && now.selected !== option && now.value !== option; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      now = await describe(loc);
    }
    if (now.selected !== option && now.value !== option) {
      throw new SnowgateError(`The dropdown shows "${now.selected ?? now.value}", not "${option}". Options: ${el.options.join(', ')}.`, 'UI_ACTION_FAILED', { action: 'select', kind: 'dropdown-not-changed' });
    }
  }

  async #pickFromList(frame, option) {
    const exact = new RegExp(`^\\s*${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
    const candidates = [
      frame.locator('.select2-drop-active .select2-result-label').filter({ hasText: exact }),
      frame.getByRole('option', { name: option, exact: true }),
      frame.locator('.ac_results li, .ui-menu-item, [role=listbox] li').filter({ hasText: exact }),
    ];
    // Whichever kind of list shows the option first, within a few seconds.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      for (const c of candidates) {
        if (await c.first().isVisible().catch(() => false)) {
          // select2 ignores a click that lands while its list is still opening:
          // let it settle and hover the option first, as a person would.
          await new Promise((r) => setTimeout(r, 300));
          await uiStep('choose option', async () => {
            await c.first().hover({ timeout: 5000 });
            await c.first().click({ timeout: 5000 });
          });
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new SnowgateError(`No visible option "${option}" appeared in the dropdown list. Check the exact text with ui_snapshot.`, 'UI_ACTION_FAILED', { action: 'select', kind: 'option-not-found' });
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
