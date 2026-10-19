import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { recordApproval } from '../approvals.js';
import { appendAudit } from '../audit.js';
import { PROJECT_ENV_FILE, missingCredentialsHint, removeCredentials, resolveCredentials, writeCredentials } from '../credentials.js';
import { discover } from '../discover.js';
import { ensureGitignore, installClaude, installCodex, installGitHook, installYallaflow } from '../adapters/install.js';
import { doctor } from '../doctor.js';
import { interactiveLogin } from '../login.js';
import { setup } from '../setup.js';
import { loadConfig } from '../config.js';
import { profileDir } from '../browser-profile.js';
import { BrowserSession } from '../playwright/session.js';
import { SnowgateError } from '../errors.js';
import { PACK_ROOT, loadPack } from '../pack.js';
import { ReadOnlyClient } from '../rest/client.js';
import { validatePackages, readPackage } from '../validate/packages.js';
import { scanFiles, stagedFiles } from '../validate/secrets.js';
import { confirmTarget, readWork, requireConfirmedTarget, setCandidate, workFile } from '../work.js';
import { findProjectRoot } from '../workspace.js';

const USAGE = `snowgate — ServiceNow platform pack for YallaFlow projects

Start here (once per project, a human in a terminal):
  snowgate setup                                    agent files, approved instances, credentials, sign-in, check

Usage:
  snowgate target set <instance> --work <PF-id>     record a candidate instance (non-binding)
  snowgate target confirm --work <PF-id>            confirm the candidate (interactive, human only)
  snowgate target show --work <PF-id>               show the work item's target
  snowgate discover [instance] --work <PF-id> [--scope <scope>]
                                                    read-only discovery of the confirmed target
  snowgate approve --work <PF-id> --package <change_id> --for plan|upload|commit
                                                    record a human approval (interactive, human only)
  snowgate login --work <PF-id>                     sign the snowgate browser profile into the target via SSO (human only)
  snowgate credentials set|show|remove --work <PF-id>
                                                    store ServiceNow credentials (set/remove: human only)
  snowgate validate [--secrets]                     validate change packages (+ scan staged files)
  snowgate mcp [--work <PF-id>]                     stdio MCP gateway (guards, audit)
  snowgate init --agent claude|codex                generate agent files, the yallaflow verify script and the git hook
  snowgate doctor [--work <PF-id>]                  check configuration, adapters and gateway exclusivity
  snowgate hook <event>                             agent hook entry point (used by the generated adapter files)
  snowgate --version | --help

Credentials: SN_USER / SN_PASSWORD in the environment win; otherwise the store set by
\`credentials:\` in .snowgate/config.yaml — protected (default, outside the project,
agents cannot read it) or project (.snowgate.env, agent-visible, for dev instances).
The gateway's browser uses the SSO session from \`snowgate login\`, or the same
credentials with ui_auth: password.`;

const PLANNED = {};

export async function main(argv, { cwd = process.cwd(), env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        work: { type: 'string' },
        scope: { type: 'string' },
        package: { type: 'string' },
        for: { type: 'string' },
        agent: { type: 'string' },
        secrets: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    });
  } catch (e) {
    err(e.message);
    err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, sub, ...rest] = positionals;

  if (values.version) {
    out(JSON.parse(readFileSync(path.join(PACK_ROOT, 'package.json'), 'utf8')).version);
    return 0;
  }
  if (values.help || !command) {
    out(USAGE);
    return command || values.help ? 0 : 2;
  }
  if (PLANNED[command]) {
    err(`snowgate ${command} is planned for milestone ${PLANNED[command]} and is not implemented yet.`);
    return 2;
  }

  if (command === 'hook') {
    const { runHook } = await import('../adapters/run-hook.js');
    return runHook(sub, { stdin, stdout, stderr, env });
  }

  try {
    const pack = loadPack();
    const root = findProjectRoot(cwd);

    if (command === 'setup') {
      if (!stdin.isTTY) {
        err('setup must be run by a human in an interactive terminal; refusing non-interactive input.');
        return 1;
      }
      const ask = async (q) => {
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          return await rl.question(q);
        } finally {
          rl.close();
        }
      };
      const result = await setup({
        root,
        pack,
        env,
        who: identity(cwd),
        ask,
        askHidden: (q) => askHidden(stdin, stdout, q),
        out,
        installChromium: () => new Promise((resolve) => {
          execFile('npx', ['playwright', 'install', 'chromium'], { cwd: PACK_ROOT }, (e) => {
            out(e ? `Chromium install failed (${e.message}); run: npx playwright install chromium` : 'Chromium installed.');
            resolve();
          });
        }),
        login: async (instance) => {
          const { kept } = await interactiveLogin({ instance, env, waitForHuman: ask });
          out(`Signed in to ${instance} (${kept} session cookie(s) kept).`);
        },
      });
      for (const a of result.approved) appendAudit(root, '_project', { tool: 'setup.approve-instance', instance: a.instance, approved_by: a.approved_by });
      return result.ok ? 0 : 1;
    }

    if (command === 'init') {
      const installers = { claude: installClaude, codex: installCodex };
      if (!installers[values.agent]) {
        err('Usage: snowgate init --agent claude|codex');
        return 2;
      }
      const results = [installers[values.agent](root), installYallaflow(root), installGitHook(root), ensureGitignore(root)];
      for (const r of results) {
        for (const f of r.written) out(`wrote ${path.relative(root, f)}`);
        for (const s of r.skipped) err(`skipped ${path.relative(root, s.file) || s.file}: ${s.reason}`);
      }
      if (values.agent === 'claude') {
        out('Claude Code loads .claude/skills/snowgate as a project plugin after you trust this folder; approve its snowgate MCP server when asked.');
      } else {
        out('Codex loads .codex/config.toml hooks after you trust this project in Codex.');
      }
      out('Then run: snowgate doctor');
      return 0;
    }

    if (command === 'doctor') {
      const report = await doctor(root, { env, workId: values.work });
      for (const c of report.checks) out(`${{ ok: 'ok   ', warn: 'warn ', error: 'ERROR', info: 'info ' }[c.level]} ${c.message}`);
      return report.ok ? 0 : 1;
    }

    if (command === 'validate') {
      const result = validatePackages(root);
      for (const n of result.notes) out(`NOTE: ${n}`);
      const problems = result.errors.map((e) => `  - ${e}`);
      if (values.secrets) {
        const found = scanFiles(root, stagedFiles(root));
        if (found.length) {
          err('Secret scan found possible credentials in staged files:');
          for (const f of found) err(`  - ${f}`);
          err('If this is a false positive, rephrase or redact it; never commit real credentials, tokens, or session values.');
        } else {
          out('Secret scan passed.');
        }
        if (found.length && !problems.length) return 1;
      }
      if (problems.length) {
        err('Change package validation failed:');
        for (const p of problems) err(p);
        return 1;
      }
      out('Change package validation passed.');
      return 0;
    }

    if (command === 'mcp') {
      const { runStdioGateway } = await import('../gateway/stdio.js');
      await runStdioGateway({ root, workId: values.work ?? env.SNOWGATE_WORK, pack, env });
      return 0;
    }

    const workId = values.work;
    if (!workId) {
      err('--work <PF-id> is required: every instance-touching action belongs to a YallaFlow work item.');
      return 2;
    }

    if (command === 'target') {
      if (sub === 'set') {
        if (!rest[0]) {
          err('Usage: snowgate target set <instance> --work <PF-id>');
          return 2;
        }
        const work = setCandidate(root, workId, rest[0], pack.instancePattern);
        if (work.target.confirmation?.via === 'approved_instances' && work.target.instance === work.target.candidate_instance) {
          appendAudit(root, workId, { tool: 'target.set', target: work.target.instance, confirmed_by: work.target.confirmed_by, via: 'approved_instances' });
          out(`Target for ${workId}: ${work.target.instance} (confirmed: approved for this project by ${work.target.confirmed_by} on ${work.target.confirmation.approved_at}).`);
          return 0;
        }
        appendAudit(root, workId, { tool: 'target.set', candidate_instance: work.target.candidate_instance });
        out(`Candidate instance for ${workId}: ${work.target.candidate_instance} (not yet authorised; it is not in this project's approved instances).`);
        out(`A human must now run: snowgate target confirm --work ${workId}`);
        return 0;
      }
      if (sub === 'confirm') {
        // Confirmation is a human act: it requires an interactive terminal.
        if (!stdin.isTTY) {
          err('target confirm must be run by a human in an interactive terminal; refusing non-interactive input.');
          return 1;
        }
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          const work = await confirmTarget(root, workId, { ask: (q) => rl.question(q), who: identity(cwd) });
          appendAudit(root, workId, { tool: 'target.confirm', target: work.target.instance, confirmed_by: work.target.confirmed_by });
          out(`Confirmed target for ${workId}: ${work.target.instance} (by ${work.target.confirmed_by} at ${work.target.confirmed_at}).`);
        } finally {
          rl.close();
        }
        return 0;
      }
      if (sub === 'show') {
        const { target } = readWork(root, workId);
        out(JSON.stringify(target, null, 2));
        out(`(${path.relative(cwd, workFile(root, workId))})`);
        return 0;
      }
      err('Usage: snowgate target set|confirm|show ...');
      return 2;
    }

    if (command === 'login') {
      // Signing in is a human act: it requires an interactive terminal.
      if (!stdin.isTTY) {
        err('login must be run by a human in an interactive terminal; refusing non-interactive input.');
        return 1;
      }
      const target = requireConfirmedTarget(root, workId);
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const { dir, kept } = await interactiveLogin({ instance: target, env, waitForHuman: (q) => rl.question(q) });
        appendAudit(root, workId, { tool: 'login', target, signed_in_by: identity(cwd) });
        out(`Signed in to ${target}. The snowgate browser profile is at ${dir} (owner-only; it holds the SSO session).`);
        out(`Kept ${kept} session cookie(s) for up to ${env.SNOWGATE_SESSION_HOURS ?? 12}h; the instance's own session timeout still applies.`);
      } finally {
        rl.close();
      }
      return 0;
    }

    if (command === 'approve') {
      // Approval is a human act: it requires an interactive terminal.
      if (!stdin.isTTY) {
        err('approve must be run by a human in an interactive terminal; refusing non-interactive input.');
        return 1;
      }
      if (!values.package || !values.for) {
        err('Usage: snowgate approve --work <PF-id> --package <change_id> --for plan|upload|commit');
        return 2;
      }
      const pkg = readPackage(root, values.package);
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const record = await recordApproval(root, workId, {
          changeId: values.package,
          purpose: values.for,
          xmlPath: pkg.xmlPath,
          ask: (q) => rl.question(q),
          who: identity(cwd),
        });
        appendAudit(root, workId, { tool: 'approve', change_id: record.change_id, for: record.for, sha256: record.sha256, approved_by: record.approved_by });
        out(`Approved ${record.change_id} for ${record.for} under ${workId} (by ${record.approved_by} at ${record.approved_at}).`);
      } finally {
        rl.close();
      }
      return 0;
    }

    if (command === 'credentials') {
      const target = requireConfirmedTarget(root, workId);
      if (sub === 'show') {
        const c = resolveCredentials(root, target, { pack, env });
        out(c.user ? `${target}: user ${c.user} from ${c.source} (password not shown).` : missingCredentialsHint(root, target, workId, pack));
        return 0;
      }
      if (sub !== 'set' && sub !== 'remove') {
        err('Usage: snowgate credentials set|show|remove --work <PF-id>');
        return 2;
      }
      // Storing or removing credentials is a human act.
      if (!stdin.isTTY) {
        err(`credentials ${sub} must be run by a human in an interactive terminal; refusing non-interactive input.`);
        return 1;
      }
      if (sub === 'remove') {
        const r = removeCredentials(root, target, { pack, env });
        appendAudit(root, workId, { tool: 'credentials.remove', target, store: r.mode });
        out(r.existed ? `Removed the ${target} credentials from ${r.file}.` : `No stored credentials at ${r.file}.`);
        return 0;
      }
      const rl = createInterface({ input: stdin, output: stdout });
      let user;
      try {
        user = (await rl.question(`ServiceNow user for ${target}: `)).trim();
      } finally {
        rl.close();
      }
      const password = await askHidden(stdin, stdout, 'Password (hidden): ');
      const r = writeCredentials(root, target, { user, password, pack, env });
      appendAudit(root, workId, { tool: 'credentials.set', target, store: r.mode, user });
      out(r.mode === 'project'
        ? `Saved to ${PROJECT_ENV_FILE} (agent-visible mode; it stays out of git and commits).`
        : `Saved to ${r.file} (owner-only, outside the project; agents cannot read it).`);
      return 0;
    }

    if (command === 'discover') {
      const target = requireConfirmedTarget(root, workId);
      const creds = resolveCredentials(root, target, { pack, env });
      const config = loadConfig(root);
      if (config.rest_auth === 'basic' && (!creds.user || !creds.password)) {
        err(`snowgate: ${missingCredentialsHint(root, target, workId, pack)}`);
        return 1;
      }
      let session = null;
      const sessionFetch = (url, init) => (session ??= new BrowserSession({
        origin: `https://${target}`,
        auth: config.ui_auth,
        profileDir: profileDir(target, env),
        user: creds.user,
        password: creds.password,
        missingHint: missingCredentialsHint(root, target, workId, pack),
      })).restFetch(url, init);
      const client = new ReadOnlyClient({ instance: target, user: creds.user, password: creds.password, mode: config.rest_auth, sessionFetch, pattern: pack.instancePattern });
      let summary;
      try {
        summary = await discover({ root, workId, instance: sub, scope: values.scope, client, pattern: pack.instancePattern });
      } finally {
        await session?.close();
      }
      if (client.authMode === 'session') out('REST used the browser session (this instance refuses Basic auth).');
      for (const w of summary.warnings) err(`warning: ${w}`);
      out(`Discovery of ${target} complete (read-only).`);
      out(`  tables read: ${summary.tables_read}, unreadable: ${summary.tables_unreadable}, hazards: ${summary.hazards}, limitations: ${summary.limitations}`);
      out(`  project map: ${summary.artifacts} artifact(s) across ${summary.update_sets} update set(s) (${summary.update_sets_local} local, ${summary.update_sets_retrieved} retrieved)`);
      const rel = path.relative(cwd, summary.dir) || summary.dir;
      out(`  output: ${rel}`);
      out(`Read ${rel}/report.md (hazards, project map by update set) and ${rel}/project-map.json with your file-reading tool before deciding.`);
      return 0;
    }

    err(`Unknown command: ${command}`);
    err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof SnowgateError) {
      err(`snowgate: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

// Reads a line from a TTY in raw mode without echoing it.
function askHidden(stdin, stdout, prompt) {
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new SnowgateError('Cancelled.', 'CANCELLED'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function identity(cwd) {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim();
    if (name) return name;
  } catch {
    // fall through to the OS user
  }
  return userInfo().username;
}
