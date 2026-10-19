import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { recordApproval } from '../approvals.js';
import { appendAudit } from '../audit.js';
import { discover } from '../discover.js';
import { installClaude, installCodex, installGitHook, installYallaflow } from '../adapters/install.js';
import { doctor } from '../doctor.js';
import { interactiveLogin } from '../login.js';
import { SnowgateError } from '../errors.js';
import { PACK_ROOT, loadPack } from '../pack.js';
import { ReadOnlyClient } from '../rest/client.js';
import { validatePackages, readPackage } from '../validate/packages.js';
import { scanFiles, stagedFiles } from '../validate/secrets.js';
import { confirmTarget, readWork, requireConfirmedTarget, setCandidate, workFile } from '../work.js';
import { findProjectRoot } from '../workspace.js';

const USAGE = `snowgate — ServiceNow platform pack for YallaFlow projects

Usage:
  snowgate target set <instance> --work <PF-id>     record a candidate instance (non-binding)
  snowgate target confirm --work <PF-id>            confirm the candidate (interactive, human only)
  snowgate target show --work <PF-id>               show the work item's target
  snowgate discover [instance] --work <PF-id> [--scope <scope>]
                                                    read-only discovery of the confirmed target
  snowgate approve --work <PF-id> --package <change_id> --for plan|upload|commit
                                                    record a human approval (interactive, human only)
  snowgate login --work <PF-id>                     sign the snowgate browser profile into the target via SSO (human only)
  snowgate validate [--secrets]                     validate change packages (+ scan staged files)
  snowgate mcp [--work <PF-id>]                     stdio MCP gateway (guards, audit)
  snowgate init --agent claude|codex                generate agent files, the yallaflow verify script and the git hook
  snowgate doctor [--work <PF-id>]                  check configuration, adapters and gateway exclusivity
  snowgate hook <event>                             agent hook entry point (used by the generated adapter files)
  snowgate --version | --help

REST credentials come from SN_USER / SN_PASSWORD in the environment. The gateway's
browser uses the SSO session from \`snowgate login\` (or, with ui_auth: password in
.snowgate/config.yaml, the same env credentials).`;

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

    if (command === 'init') {
      const installers = { claude: installClaude, codex: installCodex };
      if (!installers[values.agent]) {
        err('Usage: snowgate init --agent claude|codex');
        return 2;
      }
      const results = [installers[values.agent](root), installYallaflow(root), installGitHook(root)];
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
        appendAudit(root, workId, { tool: 'target.set', candidate_instance: work.target.candidate_instance });
        out(`Candidate instance for ${workId}: ${work.target.candidate_instance} (not yet authorised).`);
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

    if (command === 'discover') {
      const target = requireConfirmedTarget(root, workId);
      const client = new ReadOnlyClient({
        instance: target,
        user: env[pack.config.credentials.env?.user ?? 'SN_USER'],
        password: env[pack.config.credentials.env?.password ?? 'SN_PASSWORD'],
        pattern: pack.instancePattern,
      });
      const summary = await discover({ root, workId, instance: sub, scope: values.scope, client, pattern: pack.instancePattern });
      for (const w of summary.warnings) err(`warning: ${w}`);
      out(`Discovery of ${target} complete (read-only).`);
      out(`  tables read: ${summary.tables_read}, unreadable: ${summary.tables_unreadable}, hazards: ${summary.hazards}, limitations: ${summary.limitations}`);
      out(`  output: ${path.relative(cwd, summary.dir) || summary.dir}`);
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

function identity(cwd) {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim();
    if (name) return name;
  } catch {
    // fall through to the OS user
  }
  return userInfo().username;
}
