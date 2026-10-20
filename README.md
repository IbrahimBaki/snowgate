# snowgate

Agent-agnostic ServiceNow platform pack for projects governed by [YallaFlow](https://www.npmjs.com/package/yallaflow). See [docs/PLAN.md](docs/PLAN.md) for the agreed design.

**Status: M3.** Implemented: `pack.yaml` loader, read-only REST client, per-work-item target (`target set|confirm|show`), `discover`, the MCP gateway (`mcp`), SSO sign-in (`login`), human approval records (`approve`), the change-package validator (`validate`), and the agent adapters (`init`, `doctor`, `hook`). The `skills/*.md` procedures named in `pack.yaml` are not written yet.

## Quick start

```bash
npm install -g git+ssh://git@github.com/IbrahimBaki/snowgate.git
cd my-servicenow-project          # a YallaFlow project
snowgate setup                    # once: agent, approved instances, credentials, sign-in
```

`snowgate setup` asks four questions:
1. Which agent: Claude or Codex.
2. Which instances agents may use in this project.
3. Whether the agent may see the credentials (dev instances only).
4. The user name and password (hidden).

It installs the agent files and writes `.snowgate/config.yaml`. It creates or updates `.snowgate.env` in dev mode, and otherwise the protected credentials file. It offers SSO sign-in when needed, and ends with `doctor`.

**Changing the instance:** the agent first calls `ui_use_update_set`, which creates or reuses the update set `<work-id> - <title>` for the YallaFlow work item and makes it current, so changes are not captured in Default. It then edits through the browser tools, verifies the result, and records what it changed in the work item. It leaves the update set In Progress; completing it, exporting and committing are yours to ask for. The procedure is in the session context and in the plugin skill `servicenow-changes`.

Then open the agent in that folder and ask for a task, for example "Run snowgate discover on dev12345". YallaFlow creates the work item. The agent binds the approved instance to it with `snowgate target set`, which confirms automatically for approved instances, and runs the task. Instances that are not approved, package uploads, and commits still need a human.

## Commands

```bash
snowgate target set dev12345.service-now.com --work PF-0001   # approved instance: confirmed at once; otherwise a candidate
snowgate target confirm --work PF-0001                         # a human types the host back
SN_USER=... SN_PASSWORD=... snowgate discover --work PF-0001 [--scope x_acme_app]
snowgate check <table> <sys_id> <field>=<value>... --work <id>  # verify stored values on the target (read-only)
snowgate validate [--secrets]                                  # change packages (+ staged-file secret scan)
snowgate approve --work PF-0001 --package CHG-1 --for plan|upload|commit   # a human types the change_id back
snowgate login --work PF-0001                                  # a human signs the snowgate browser profile in via SSO
snowgate credentials set|show|remove --work PF-0001            # store ServiceNow credentials once (set/remove: a human)
SN_USER=... SN_PASSWORD=... snowgate mcp --work PF-0001        # stdio MCP gateway for any agent
snowgate init --agent claude|codex                             # adapter files, yallaflow verify script, git pre-commit hook
snowgate doctor [--work PF-0001]                               # configuration, adapters, raw-Playwright check
```

`snowgate init` generates:

- **claude:** a project plugin in `.claude/skills/snowgate/`. Its hooks and its MCP server run `${CLAUDE_PLUGIN_ROOT}` shims. Claude Code loads it after you trust the folder, and asks you to approve its MCP server.
- **codex:** `.codex/config.toml` (`[mcp_servers.snowgate]` and a PreToolUse hook), plus a snowgate block in `AGENTS.md`. Codex loads the hooks after you trust the project.
- **yallaflow:** `.snowgate/bin/verify-change-packages`, for `yallaflow verify <id> --script .snowgate/bin/verify-change-packages`.
- **git:** `.git/hooks/pre-commit`, which runs `snowgate validate --secrets`.

It never overwrites a file it did not generate.

Safety properties enforced in code:

- The target is per work item. An instance approved for the project in `.snowgate/config.yaml` (`approved_instances`, written by `snowgate setup` with the approver's name) confirms automatically when an agent runs `target set`. Removing it from the list revokes those targets. Any other instance needs `target confirm`, which refuses non-interactive input and requires the host to be typed back.
- The REST client has no write path; it sends GET only, and every request lists its fields.
- **What can be read**, set by `data:` in `.snowgate/config.yaml`:
  - `all` (default): any table and field on the target.
  - `listed`: configuration tables, meaning everything that inherits from `sys_metadata`, plus the tables named in `data_tables`.
  - `none`: configuration tables only.

  `setup` does not ask about this; change it in the file when a project needs it. The instance's own `sys_db_object` and `sys_dictionary` decide what exists and how tables inherit.
- **Always refused, whatever the setting:**
  - fields of type `password` or `password2`;
  - field names like password, secret, token, credential, private or API key, and session;
  - session, token and credential tables, and attachment contents;
  - encoded queries that filter on such fields or contain `javascript:`.

  These refusals are recorded as feedback, so a rule that blocks something harmless can be fixed. Today `listed` and `none` are enforced on REST reads, not yet in the UI tools.
- Anything unreadable goes to `limitations.md`. Every fact cites its query and URL in `evidence.json`.
- `discover` builds a **project map** from the update sets' contents (`sys_update_xml`), in every scope including global. It is grouped by update set, local and retrieved, so each task's changes are visible. Known artifact records (pages, widgets and their instances, catalog items and variables, UI policies, business rules, ACLs, UI pages and actions, notifications, flows, and more) are read by `sys_id` and marked `new` or `baseline-modified`, inferred from the record's creator, or `deleted`. Other updates are listed by their own names. The full map is in `project-map.json`. Changes made outside update-set tracking are not visible there. The map carries metadata only. An agent reads an artifact's code with `sn_get_record`, for example `sp_widget` `template`/`client_script`/`script`, `sys_script` `script`, or `sys_ui_page` `html`. The code fields were checked against a real instance's dictionary. Agents may read `.snowgate/discovery/` with ordinary read-only shell tools (`find`, `sed -n`, `awk`, `jq`, `tree`...); writing under `.snowgate/` stays blocked.
- Credentials (REST Basic auth, and the browser with `ui_auth: password`) come from `SN_USER` / `SN_PASSWORD` in the environment when set. Otherwise they come from the store chosen by `credentials:` in `.snowgate/config.yaml`:
  - `protected` (default): a per-instance owner-only file outside the project, under `~/.config/snowgate/credentials/`. A human writes it with `snowgate credentials set`, which prompts for the password without echoing it. Agents cannot read it, and cannot run `credentials set` or `credentials remove`.
  - `project`: `.snowgate.env` in the project root, for dev instances where the agent may see the credentials. With `ui_auth: password`, the gateway also signs in again by itself when the instance ends the session. `snowgate init` adds the file to `.gitignore`, and `validate --secrets` and the commit hook refuse to commit it.

  REST authentication follows `rest_auth` in `.snowgate/config.yaml`:
  - `auto` (default): tries Basic auth. If the instance answers 401, which some instances do even for a valid password, it switches to the browser session, using the cookies plus the `X-UserToken` that the ServiceNow UI itself sends.
  - `basic`: Basic auth only.
  - `session`: the browser session only. With SSO this needs no separate integration account.

  The session path is GET-only and reaches the confirmed target only. `snowgate setup` checks the credentials right away: it asks again if the password is rejected, and says so when REST will use the session.

  The mode lives in `.snowgate/config.yaml`, which agents cannot write, so only a human can switch to the agent-visible store. Credentials never appear in output, evidence, or the audit trail (`.snowgate/audit/<work>.jsonl`).
- The gateway's browser uses a dedicated snowgate profile per instance (`$XDG_STATE_HOME/snowgate/profiles/<instance>`, default `~/.local/state/...`, owner-only, outside the project). A human signs it in once through SSO with `snowgate login`; the agent never sees a password or cookie, and it never uses your personal browser. ServiceNow's session cookies have no expiry, so `snowgate login` saves the instance's session cookies with an explicit lifetime (default 12h, `SNOWGATE_SESSION_HOURS`) for the gateway to reuse; the instance's own session timeout still applies. An expired session is reported as `SESSION_EXPIRED`. For instances without SSO, set `ui_auth: password` in `.snowgate/config.yaml` to log in with the env credentials instead.
- `sn_portal_page` (read-only) returns a whole Service Portal page in one call. The layout comes as a tree (containers → rows → columns → widget instances, with nested rows), and each widget instance carries its options (`widget_parameters`, such as the HTML of content widgets) and its CSS.
- The gateway exposes only the tools of PLAN §7.2, plus `sn_portal_page`: no JavaScript evaluation, tabs, history, key presses, generic file upload, REST writes, delete, back out, or switching the current update set.
- The gateway drives its own isolated Chromium. Every request from every frame is checked: any host other than the confirmed target is aborted, and update-set surfaces (`sys_remote_update_set*`, `sys_update_set*`, `sys_update_preview*`, `sys_update_xml*`, update-set processors, `upload.do`, including inside the `gsft_main` iframe and Next Experience / `nav_to.do` wrappers) are aborted for generic UI tools. Redirects are checked too: requests are fetched without following redirects, and a redirect is only followed when its target passes the same checks. Only `ui_upload_update_set`, `ui_preview_update_set` and `ui_commit_update_set` lift that lock, for one call, after their gates pass.
- Agent hooks (Claude Code and Codex) block raw Playwright MCP tools and any other browser tool aimed at a `service-now.com` host. They block agent writes to `.snowgate/**`, the generated adapter files, `.claude/settings*.json` and `.codex/`. Shell commands are judged one command at a time (split at `;`, `&`, `|` and newlines outside quotes; a quoted script or a heredoc stays with the command that runs it), so a read-only command may read `.snowgate/`. They block any access to the SSO profiles. They block agents from running the human-only commands (`approve`, `login`, `target confirm`), because their TTY check can be faked with a pseudo-terminal. They block `git commit` when `validate` or the secret scan fails. A hook exiting 2 blocks even calls that an allow rule permits. If snowgate cannot be loaded, the hook fails closed.
- Upload needs a package at `peer-reviewed` or later that passes `validate` and a current `upload` approval. Commit needs `awaiting-human-approval`, a previewed update set with no unresolved problems, and a current `commit` approval. Upload and commit approvals bind the SHA-256 of the exact `update-set.xml`; editing the file afterwards invalidates them.

## Feedback

snowgate records what it could not let an agent see or do, so it can improve:
- **Automatically:** fields or tables refused by the allowlist, tables discover could not read, and tools that do not exist.
- **From the agent:** gaps it reports itself with the `sn_report_gap` tool.

The gaps are kept in `.snowgate/feedback/gaps.json`, one entry per fingerprint with a count. Instance names, sys_ids, e-mail addresses, URLs and paths are removed. Nothing leaves the machine until you run:

```bash
snowgate feedback list     # what is waiting
snowgate feedback send     # preview, confirm, send
```

`send` shows the exact text first and saves a Markdown copy. After you confirm, it does one of two things:
- **With `gh` signed in:** it creates an issue, or comments on an open one with the same fingerprint.
- **Otherwise:** it opens GitHub's prefilled new-issue page, and you press *Submit*.

Issues go to the public repository `IbrahimBaki/snowgate-feedback`, which needs no access to the snowgate code. Override it with `SNOWGATE_FEEDBACK_REPO=owner/name`. Agents may list feedback but not send it.

Known limitations:

- `snowgate login` drives a visible browser without the gateway's locks (SSO must reach the identity provider), so it is a human-only command. The saved SSO session is a credential: protect the profile folder, and delete it to sign out.
- The target confirmation (`.snowgate/work/<id>.yaml`), the approval records (`.snowgate/approvals/<id>.jsonl`) and the SSO profile are protected from agents by the hooks, not by the operating system. The shell checks are heuristic, and an installed Claude Code mod can override a non-managed hook. The gateway remains the primary guard.
- The Codex adapter is checked against the Codex docs only. Codex's own browser tools may not be covered by the `service-now.com` rule.
- The ServiceNow-specific steps of the dedicated update-set tools (`upload.do`, the *Preview Update Set* / *Commit Update Set* buttons, the `sys_remote_update_set` states) and the processor names in the URL lock follow standard ServiceNow behaviour but have not yet been observed on a real instance.
- The browser lock may also abort ServiceNow's update-set picker requests; that is intended (switching the current update set is not allowed) but untested on a real instance.

Tests run against a local mock Table API, a local fixture site in a real headless Chromium, and validator fixtures; they need no real instance:

```bash
npm install && npx playwright install chromium && npm test
```
