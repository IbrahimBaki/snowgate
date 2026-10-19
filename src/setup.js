import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { ensureGitignore, installClaude, installCodex, installGitHook, installYallaflow } from './adapters/install.js';
import { loadConfig, updateConfig } from './config.js';
import { resolveCredentials, writeCredentials } from './credentials.js';
import { doctor } from './doctor.js';
import { normalizeInstance } from './instance.js';

// `snowgate setup` (PF-0009): one interactive, human-only run from install to
// a ready project. It never asks for a YallaFlow work item — agents get those
// from YallaFlow and bind an approved instance with `snowgate target set`.
// Prompt and side-effect functions are injected so the flow is testable.
export async function setup({
  root,
  pack,
  env = process.env,
  who,
  now = new Date(),
  ask,
  askHidden,
  out,
  chromiumInstalled = () => existsSync(chromium.executablePath()),
  installChromium,
  login,
  home,
}) {
  const yes = async (question, byDefault) => {
    const a = (await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : byDefault;
  };
  const current = loadConfig(root);

  // 1. Agent adapters.
  let agent;
  while (!['claude', 'codex'].includes(agent)) agent = ((await ask('Agent (claude/codex) [claude]: ')).trim().toLowerCase() || 'claude');
  const installers = { claude: installClaude, codex: installCodex };
  const files = [installers[agent](root, { home }), installYallaflow(root, { home }), installGitHook(root, { home }), ensureGitignore(root)]
    .flatMap((r) => r.written);
  out(`Agent files ready (${files.length} written).`);

  if (!chromiumInstalled()) {
    if (await yes('The gateway needs Playwright Chromium. Install it now?', true)) await installChromium();
    else out('Later run: npx playwright install chromium');
  }

  // 2. Instances approved once for this project.
  const known = current.approved_instances.map((a) => a.instance);
  let instances = [];
  while (!instances.length) {
    const answer = (await ask(`ServiceNow instance(s) agents may use in this project, comma separated${known.length ? ` [${known.join(', ')}]` : ''}: `)).trim();
    try {
      instances = (answer || known.join(',')).split(',').map((s) => s.trim()).filter(Boolean).map((s) => normalizeInstance(s.includes('.') ? s : `${s}.service-now.com`, pack.instancePattern));
    } catch (e) {
      out(e.message);
      instances = [];
    }
  }
  const approved = [...new Set(instances)].map((instance) => current.approved_instances.find((a) => a.instance === instance)
    ?? { instance, approved_by: who, approved_at: now.toISOString() });

  // 3. Credential store and sign-in method.
  const dev = await yes('Dev instance(s): may the agent see the credentials (stored in .snowgate.env)?', current.credentials === 'project');
  const sso = dev ? false : await yes('Do you sign in to the instance UI with SSO?', current.ui_auth === 'profile');
  updateConfig(root, { approved_instances: approved, credentials: dev ? 'project' : 'protected', ui_auth: sso ? 'profile' : 'password' });

  // 4. Credentials (hidden password). Dev mode keeps one set in .snowgate.env.
  const targets = dev ? [approved[0].instance] : approved.map((a) => a.instance);
  for (const instance of targets) {
    // The stored values, not environment overrides, are the defaults here.
    const existing = resolveCredentials(root, instance, { pack, env: { ...env, [pack.config.credentials.env?.user ?? 'SN_USER']: undefined } });
    const label = dev ? 'the dev instance(s)' : instance;
    const optional = sso ? ' (REST only; empty to skip)' : '';
    const user = (await ask(`ServiceNow user for ${label}${optional}${existing.user ? ` [${existing.user}]` : ''}: `)).trim() || existing.user;
    if (!user) continue;
    const password = (await askHidden(`Password for ${user}${existing.password ? ' (empty keeps the saved one)' : ''}: `)) || existing.password;
    if (!password) continue;
    writeCredentials(root, instance, { user, password, pack, env });
    out(dev ? `Saved ${user} to .snowgate.env (agent-visible, never committed).` : `Saved ${user} for ${instance} (outside the project; agents cannot read it).`);
  }

  // 5. SSO sign-in for the browser.
  if (sso) {
    for (const { instance } of approved) {
      if (await yes(`Sign in to ${instance} with SSO now?`, true)) await login(instance);
    }
  }

  const report = await doctor(root, { env, home });
  // The agent gets its work item from YallaFlow later, so that warning is noise here.
  for (const c of report.checks.filter((c) => (c.level === 'error' || c.level === 'warn') && !/^No work item/.test(c.message))) out(`${c.level}: ${c.message}`);
  out('');
  out(`Ready. Open ${agent === 'claude' ? 'Claude Code' : 'Codex'} in this folder and ask, for example: "Run snowgate discover on ${approved[0].instance}".`);
  return { agent, approved, credentials: dev ? 'project' : 'protected', ui_auth: sso ? 'profile' : 'password', ok: report.ok };
}
