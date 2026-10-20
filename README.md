# snowgate

**Let AI coding agents carry out ServiceNow tasks safely.**

[![npm](https://img.shields.io/npm/v/snowgate.svg)](https://www.npmjs.com/package/snowgate)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

snowgate connects Claude Code or Codex to a ServiceNow instance through a guarded gateway. The agent can read the instance, change it through a real browser the way a person would, and verify the result. It works only on the instance approved for the task, and every change lands in the task's own update set, never in Default.

It runs inside a [YallaFlow](https://www.npmjs.com/package/yallaflow) project. YallaFlow owns the task: it holds the work item, its stages and its evidence. snowgate owns the instance side.

> **Status: 0.1, early release.** Tested end to end on a ServiceNow developer instance with Claude Code. That covered form fields, checkboxes on form tabs, choice lists, Service Portal fields and related-list records. Feedback is welcome, and snowgate collects it for you (see [Feedback](#feedback)).

---

## Contents

- [Why snowgate](#why-snowgate)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [How a task runs](#how-a-task-runs)
- [Commands](#commands)
- [Gateway tools](#gateway-tools)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Feedback](#feedback)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License](#license)

---

## Why snowgate

An agent given a browser and an admin password on ServiceNow can do a lot of damage quickly. It can work on the wrong instance, save changes into Default, commit someone else's update set, or read passwords and tokens. snowgate keeps the speed and removes those risks:

| Without guards | With snowgate |
| --- | --- |
| Any instance the browser can reach | Only the instance confirmed for this work item |
| Changes land in whatever update set is current, often Default | The task's own update set, `<work-id> - <title>`, is created and made current first |
| The agent can open update-set pages and commit | Update-set pages are locked; preview and commit sit behind human approvals |
| REST writes, deletes, arbitrary JavaScript | REST is GET-only; no JavaScript evaluation, no delete, no back-out |
| Secrets readable like any field | Password fields, tokens, credentials and session tables are always refused |
| "Done" based on what the page looked like | Results verified against stored values with `snowgate check` |
| No record of what happened | Every call audited per work item, credentials redacted |

---

## How it works

```
  You ──▶ Agent (Claude Code / Codex)
            │  task = a YallaFlow work item (PF-0007 …)
            │
            ├─ hooks: block raw Playwright, other browsers on service-now.com,
            │         writes to .snowgate/, human-only commands
            ▼
       snowgate MCP gateway  (one call at a time, audited)
            │
            ├─ REST (read-only) ── sn_query, sn_get_record, sn_portal_page …
            │     GET only · confirmed target only · sensitive data refused
            │
            └─ Browser (its own Chromium) ── ui_navigate, ui_type, ui_click …
                  every request checked: target host only,
                  update-set pages locked, redirects re-checked
            ▼
       ServiceNow instance  (the one confirmed for this work item)
```

Three layers protect the instance:

1. **The gateway** is the only path to the instance. It exposes a fixed set of tools and enforces the host lock, the update-set lock and the read policy in code.
2. **Agent hooks** stop the agent from going around the gateway or touching snowgate's state.
3. **A git pre-commit hook** refuses commits that carry credentials or invalid change packages.

---

## Requirements

- **Node.js 22** or later.
- **A YallaFlow project.** Install YallaFlow (`npm install -g yallaflow`) and run `yallaflow init` in the project folder.
- **Claude Code or Codex** as the agent.
- **A ServiceNow instance** (`*.service-now.com`) and an account on it. A developer instance (PDI) is the best place to start.
- **Playwright Chromium.** `snowgate setup` offers to install it.

---

## Install

```bash
npm install -g snowgate
```

Check it:

```bash
snowgate --version
```

---

## Quick start

Run this once per project, in a terminal, as a human:

```bash
cd my-servicenow-project
snowgate setup
```

`setup` asks four questions:

1. **Which agent:** Claude or Codex.
2. **Which instances** agents may use in this project, for example `dev12345.service-now.com`.
3. **Whether the agent may see the credentials.** Answer yes only for dev instances.
4. **The ServiceNow user and password.** The password is hidden while you type.

It then:

- installs the agent files and the git hook;
- writes `.snowgate/config.yaml`;
- saves the credentials;
- checks them against the instance right away;
- offers SSO sign-in when needed;
- ends with `snowgate doctor`.

Then open your agent in the project folder and ask for a task in plain words:

> Add a choice "French" (value `french`) to the `preferred_language` variable of the "Register for EduPulse" catalog item.

That is all. YallaFlow creates the work item, and the agent binds the approved instance to it, makes the change, verifies it and reports back.

> **Claude Code:** the first time, trust the folder and approve the `snowgate` MCP server when asked. The plugin appears under `/plugin`.

---

## How a task runs

What the agent does for a change request. The skill `servicenow-changes` and the generated agent files hold this procedure.

```
1  YallaFlow work item     yallaflow start / change …     (the agent does this)
2  Bind the instance       snowgate target set <instance> --work PF-0007
3  Discover                sn_query / sn_get_record / snowgate discover
4  Select the update set   ui_use_update_set  →  "PF-0007 - <title>", current: true
5  Change through the UI   ui_navigate → ui_type / ui_select / ui_click → Update
6  Verify                  yallaflow verify PF-0007 -- snowgate check <table> <sys_id> field=value …
7  Record and finish       update set name + records in the work item, yallaflow finish
```

- **Step 2:** an instance approved in `setup` confirms automatically. Any other instance needs a human to run `snowgate target confirm`.
- **Step 4:** nothing is changed until the gateway reports that the task's update set is current.
- **Step 6:** `snowgate check` reads the stored values from the instance and fails on any difference. The result becomes the work item's verification evidence.
- **After step 7:** the update set **stays In Progress**. Completing, exporting or committing it happens only when you ask.

What stays with a human:

| Action | Command |
| --- | --- |
| Approve instances for a project | `snowgate setup` |
| Confirm an instance that is not approved | `snowgate target confirm --work <id>` |
| Store or remove credentials | `snowgate credentials set\|remove --work <id>` |
| SSO sign-in for the gateway's browser | `snowgate login --work <id>` |
| Approve a change package for upload or commit | `snowgate approve --work <id> --package <change_id> --for upload\|commit` |
| Send collected feedback, or clear it | `snowgate feedback send\|clear` |

The agent hooks refuse these commands from an agent. A terminal check alone can be faked with a pseudo-terminal.

---

## Commands

### For you

```bash
snowgate setup                                    # once per project: agent, instances, credentials, sign-in, check
snowgate doctor [--work <id>]                     # configuration, adapters, credentials, Chromium, gateway exclusivity
snowgate login --work <id>                        # SSO sign-in of the gateway's browser profile (human only)
snowgate credentials set|show|remove --work <id>  # stored credentials (set/remove: human only)
snowgate target confirm --work <id>               # confirm a non-approved instance by typing its host (human only)
snowgate approve --work <id> --package <change_id> --for plan|upload|commit   # human approval record
snowgate feedback list|send|clear [--sent]        # collected gaps (send/clear: human only)
snowgate init --agent claude|codex                # (re)generate the agent files, verify script and git hook
```

### Used by the agent (you can run them too)

```bash
snowgate target set <instance> --work <id>        # bind an instance to the work item (approved: confirmed at once)
snowgate target show --work <id>                  # the work item's target
snowgate discover [instance] --work <id> [--scope <scope>]
                                                  # read-only discovery: hazards, project map by update set, evidence
snowgate check <table> <sys_id> <field>=<value>... --work <id>
                                                  # verify stored values (read-only); exit 1 on any mismatch
snowgate validate [--secrets]                     # validate change packages in changes/ (+ scan staged files)
snowgate mcp [--work <id>]                        # the stdio MCP gateway (started by the agent)
snowgate --version | --help
```

Examples:

```bash
# verify a change and record it as YallaFlow evidence
yallaflow verify PF-0007 -- snowgate check item_option_new 0184efd9…d665 include_none=false show_help=true --work PF-0007

# map what a project has changed on the instance
snowgate discover --work PF-0001
```

`snowgate check` compares stored values, not labels. Booleans are `true`/`false`, a choice is its value, and a reference is a sys_id. Quote values that contain spaces.

`discover` writes to `.snowgate/discovery/<work-id>/`:

- `report.md`: hazards, and the project map grouped by update set;
- `project-map.json`: every artifact the project's update sets changed, in every scope including global, marked `new`, `baseline-modified` or `deleted`;
- `evidence.json`: the query and URL behind every fact;
- `limitations.md`: what could not be read.

---

## Gateway tools

The MCP server `snowgate` exposes these tools and nothing else.

**Read (REST, GET only)**

| Tool | What it does |
| --- | --- |
| `sn_instance_info` | Version, the signed-in user and roles (warns on admin) |
| `sn_query` | Query any table: you list the fields; sensitive data is refused |
| `sn_get_record` | One record with its link as evidence, including code fields (widget scripts, business rules, UI pages) |
| `sn_update_sets` | Local update sets by state, and each user's current set |
| `sn_update_set_contents` | The customer updates in one update set |
| `sn_customizations` | Customer updates grouped by type, optionally for one scope |
| `sn_portal_page` | A whole Service Portal page in one call: containers → rows → columns → widget instances with options and CSS |

**Browser (its own Chromium, locked to the target)**

| Tool | What it does |
| --- | --- |
| `ui_navigate` | Open a path or URL on the target |
| `ui_snapshot` | Accessibility snapshot of every frame |
| `ui_type` | Set a field by its kind: text, dropdown (by visible text or value), checkbox (`true`/`false`) |
| `ui_select` | Pick an option in a native, Service Portal (select2) or reference/autocomplete dropdown, and verify it |
| `ui_click` | Click a button, link, tab or checkbox (by role + name, label or text; `nth` for duplicates) |
| `ui_screenshot` | Full-page screenshot saved as evidence |

**Update sets (gated)**

| Tool | What it does |
| --- | --- |
| `ui_use_update_set` | Create or reuse `<work-id> - <title>` and make it current. Call before any change |
| `ui_upload_update_set` | Upload a reviewed change package's `update-set.xml` (needs a human upload approval) |
| `ui_preview_update_set` | Preview the uploaded set and return its problems |
| `ui_commit_update_set` | Commit it (needs a human commit approval for that exact file) |

**Other**

| Tool | What it does |
| --- | --- |
| `sn_report_gap` | The agent reports something snowgate did not let it do; kept for `snowgate feedback` |

Several things help the agent finish a task in fewer calls:

- Fields on closed form tabs are opened automatically.
- ServiceNow's checkbox labels and Service Portal pickers are handled.
- Argument mistakes come back with the expected parameters.
- After a save, the agent is told when ServiceNow returned to the previous page.

---

## Configuration

`.snowgate/config.yaml` is written by `setup`. Agents cannot change it.

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `approved_instances` | list of hosts with approver | `[]` | Instances an agent may bind without a human confirmation |
| `credentials` | `protected`, `project` | `protected` | Where credentials live (see below) |
| `ui_auth` | `profile`, `password` | `profile` | Browser sign-in: the SSO profile from `snowgate login`, or the stored credentials with automatic re-login |
| `rest_auth` | `auto`, `basic`, `session` | `auto` | REST sign-in. `auto` tries Basic auth and falls back to the browser session when the instance refuses it |
| `data` | `all`, `listed`, `none` | `all` | What REST may read: every table, configuration plus `data_tables`, or configuration only |
| `data_tables` | list of tables | `[]` | Data tables readable with `data: listed` |
| `changes_dir` | path | `changes` | Where change packages live, for `validate` |

**Credentials.** `SN_USER` / `SN_PASSWORD` in the environment always win. Otherwise:

- `protected`: an owner-only file outside the project (`~/.config/snowgate/credentials/<instance>.json`). Agents cannot read it.
- `project`: `.snowgate.env` in the project root, readable by the agent. For dev instances only. It is added to `.gitignore`, and the commit hook refuses to commit it.

**Read policy.** With any `data` setting, these are always refused:

- `password` / `password2` fields;
- names like password, secret, token, credential, API key or session;
- session, token and credential tables, and attachment contents;
- queries that filter on such fields or contain `javascript:`.

The instance's own dictionary (`sys_db_object`, `sys_dictionary`) decides what exists.

---

## Security model

- **One instance per task.** The target is stored per work item. Approved instances confirm automatically. Any other instance needs a human to type its host back, and removing an instance from `approved_instances` revokes those targets.
- **Host lock.** The gateway's browser aborts every request to any other host, from every frame. It fetches redirects without following them, and follows one only when its target passes the same checks.
- **Update-set lock.**
  - The UI tools can never reach update-set records, update-set processors or `upload.do`. That includes pages inside the classic `gsft_main` frame and the Next Experience and `nav_to.do` wrappers.
  - Only the dedicated update-set tools lift this lock, for one call, after their gates pass.
- **Upload and commit gates.**
  - Upload needs a change package that is `peer-reviewed` and passes `validate`, plus a human approval bound to the SHA-256 of the exact `update-set.xml`.
  - Commit needs a clean preview and a separate human approval. Editing the file invalidates both approvals.
- **No write path over REST.** No JavaScript evaluation, delete, back-out or tab control.
- **Audit.** Every gateway call and CLI read is appended to `.snowgate/audit/<work-id>.jsonl`. Credentials, cookies and tokens are redacted everywhere: in output, evidence, audit and feedback.
- **Isolated browser.** The gateway uses its own Chromium profile per instance, outside the project, and never your personal browser. With SSO, a human signs it in once (`snowgate login`). The session is kept for 12 hours by default (`SNOWGATE_SESSION_HOURS`).
- **Agent hooks.** The hooks refuse:
  - raw Playwright tools, and other browser tools aimed at `service-now.com`;
  - writes to `.snowgate/`, the adapter files and the agent settings;
  - any access to the SSO profiles and the protected credential store;
  - the human-only commands.

  Shell commands are judged one command at a time, so read-only commands may still read `.snowgate/`. If snowgate cannot be loaded, the hook fails closed.

---

## Feedback

snowgate records what it could not let the agent see or do:

- refused fields and tables;
- UI actions that failed;
- tools that do not exist;
- gaps the agent reports with `sn_report_gap`.

Gaps are stored in `.snowgate/feedback/gaps.json`, one entry per kind with a count. Instance names, sys_ids, e-mail addresses, URLs and paths are removed. Nothing leaves your machine until you send it:

```bash
snowgate feedback list           # what is waiting
snowgate feedback send           # shows the exact text, asks, then sends
snowgate feedback clear [--sent] # remove all gaps, or only those already sent
```

`send` creates an issue in the public [snowgate-feedback](https://github.com/IbrahimBaki/snowgate-feedback) repository. It uses `gh` when you are signed in, and otherwise opens GitHub's prefilled new-issue page. Set `SNOWGATE_FEEDBACK_REPO=owner/name` to send elsewhere.

---

## Troubleshooting

Start with:

```bash
snowgate doctor --work <id>
```

| Symptom | Fix |
| --- | --- |
| `No YallaFlow project found` | Run `yallaflow init` in the project folder first |
| `SESSION_EXPIRED` | Sign the gateway's browser in again: `snowgate login --work <id>` |
| REST answers 401 with a correct password | Keep `rest_auth: auto`; snowgate falls back to the browser session (some instances refuse Basic auth) |
| `Playwright Chromium is missing` | `npx playwright install chromium` |
| The agent cannot bind an instance | Add it with `snowgate setup`, or confirm it once: `snowgate target confirm --work <id>` |
| The plugin is not listed in Claude Code | Trust the folder, approve the `snowgate` MCP server, then check `/plugin` |
| Agent files are outdated after an upgrade | `snowgate init --agent claude` (or `codex`) |

---

## Known limitations

- The Codex adapter follows the Codex documentation and has seen less real use than Claude Code. Codex's own browser tools may not be covered by the `service-now.com` rule.
- The upload, preview and commit steps follow standard ServiceNow behaviour, but have not yet been observed on a real instance.
- The hooks protect snowgate's state, not the operating system. Their shell checks are heuristic. The gateway is the primary guard.
- `data: listed` and `data: none` apply to REST reads, not yet to the UI tools.
- The lock may also abort ServiceNow's update-set picker requests. That is intended, since switching the current update set is not allowed, but it is untested on a real instance.
- `snowgate login` drives a visible browser without the gateway's locks, because SSO must reach the identity provider. That is why it is human-only. The saved session is a credential: delete the profile folder to sign out.

---

## Development

```bash
git clone https://github.com/IbrahimBaki/snowgate.git
cd snowgate
npm install
npx playwright install chromium
npm test
```

The tests use a local mock Table API, local fixture sites in a real headless Chromium, and validator fixtures. They need no ServiceNow instance. The design is in [docs/PLAN.md](https://github.com/IbrahimBaki/snowgate/blob/main/docs/PLAN.md).

---

## License

[MIT](LICENSE)
