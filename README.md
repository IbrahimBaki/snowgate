<div align="center">

# ❄️ snowgate

### Let AI agents work on ServiceNow, safely.

Ask Claude Code or Codex for a ServiceNow change in plain words.<br/>
snowgate lets the agent do it through a guarded gateway: on the right instance, in the task's own update set, and verified against what was actually saved.

[![npm](https://img.shields.io/npm/v/snowgate.svg)](https://www.npmjs.com/package/snowgate)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/IbrahimBaki/snowgate/blob/main/LICENSE)
![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)
![agents: Claude Code · Codex](https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex-8a63d2.svg)

[Get started](#-get-started-in-3-steps) · [How a task runs](#-how-a-task-runs) · [Who does what](#-who-does-what) · [Commands](#-commands) · [FAQ](#-faq)

</div>

---

## 🧭 snowgate at a glance

![snowgate mindmap: what you do once, what the agent does, what is always guarded, and how it learns from you](https://raw.githubusercontent.com/IbrahimBaki/snowgate/main/docs/images/mindmap.png)

| You get | Because snowgate… |
| --- | --- |
| ✅ **The right instance** | binds one approved instance to each task, and blocks every other host |
| ✅ **No changes in Default** | creates the task's update set, `<work-id> - <title>`, and makes it current before any change |
| ✅ **Real verification** | checks the values actually stored on the instance with `snowgate check` |
| ✅ **No secrets exposed** | never reads passwords, tokens, credentials or session data |
| ✅ **Nothing irreversible by surprise** | keeps update-set pages locked; upload and commit need your approval |
| ✅ **A full trail** | audits every call per task, with credentials removed |

snowgate runs inside a [YallaFlow](https://www.npmjs.com/package/yallaflow) project. YallaFlow owns the task: the work item, its stages and its evidence. snowgate owns the ServiceNow side.

> **Status: 0.1, early release.** Tested end to end with Claude Code on a ServiceNow developer instance. That covered form fields, checkboxes on form tabs, choice lists, Service Portal fields and related-list records. Your feedback shapes the next version, and snowgate collects it for you ([Feedback](#-feedback)).

---

## 🚀 Get started in 3 steps

**Before you start:**
- Node.js 22 or later
- [YallaFlow](https://www.npmjs.com/package/yallaflow): `npm install -g yallaflow`, then `yallaflow init` in your project
- Claude Code or Codex
- A ServiceNow instance, a developer instance (PDI) is ideal

### 1. Install

```bash
npm install -g snowgate
```

### 2. Set up your project (once, in a terminal)

```bash
cd my-servicenow-project
snowgate setup
```

It asks four short questions:

| # | Question | Example |
| --- | --- | --- |
| 1 | Which agent? | `claude` |
| 2 | Which instances may agents use here? | `dev12345.service-now.com` |
| 3 | May the agent see the credentials? | `y` for a dev instance only |
| 4 | ServiceNow user and password | the password stays hidden |

It then:
- installs the agent files and the git hook;
- saves the credentials;
- checks them against the instance;
- offers SSO sign-in when needed;
- installs the browser it uses (Playwright Chromium).

### 3. Ask your agent

Open Claude Code or Codex in the project folder and ask in plain words:

> *Add a choice "French" (value `french`) to the `preferred_language` variable of the "Register for EduPulse" catalog item.*

That's it. The agent opens the task, makes the change, verifies it and tells you what it did.

> 💡 **Claude Code, first time:** trust the folder and approve the `snowgate` MCP server when asked.

---

## 🔁 How a task runs

![The eight steps of a task: you ask, YallaFlow opens the task, bind the instance, read and discover, task update set, change in the browser, verify stored values, report and finish](https://raw.githubusercontent.com/IbrahimBaki/snowgate/main/docs/images/task-flow.png)

| Step | What happens | Tool or command |
| --- | --- | --- |
| ① ② | Your request becomes a YallaFlow work item | `yallaflow start` |
| ③ | The approved instance is bound to the task | `snowgate target set` |
| ④ | The agent reads what it needs | `sn_query`, `sn_get_record`, `snowgate discover` |
| ⑤ | The task's update set is created and made current; nothing changes before this | `ui_use_update_set` |
| ⑥ | The change is made through the browser, like a person would | `ui_navigate`, `ui_type`, `ui_select`, `ui_click` |
| ⑦ | The stored values are checked and saved as evidence | `yallaflow verify … -- snowgate check …` |
| ⑧ | The agent reports the update set and records; the set stays **In Progress** | `yallaflow finish` |

Completing, exporting or committing the update set happens only when you ask.

---

## 👥 Who does what

| 🧑 You (a human, in a terminal) | 🤖 The agent |
| --- | --- |
| `snowgate setup`: approve instances, save credentials | Opens the YallaFlow task |
| `snowgate login`: SSO sign-in for the gateway's browser | Binds an approved instance: `snowgate target set` |
| `snowgate target confirm`: allow an instance that isn't approved | Reads, discovers and maps the project |
| `snowgate approve`: approve a package upload or commit | Changes through the browser in the task's update set |
| `snowgate credentials set\|remove` | Verifies with `snowgate check` |
| `snowgate feedback send\|clear` | Reports gaps with `sn_report_gap` |

The left column is **human-only**. The agent hooks refuse those commands from an agent.

---

## 🛡️ How it stays safe

![Architecture: the agent reaches ServiceNow only through the snowgate gateway, whose REST side is read-only and whose browser is locked to the task's instance; direct access is blocked by hooks](https://raw.githubusercontent.com/IbrahimBaki/snowgate/main/docs/images/architecture.png)

| Layer | What it guarantees |
| --- | --- |
| **Gateway** | The only path to the instance: a fixed set of tools, one call at a time, all audited |
| **Host lock** | The browser aborts every request to another host, from every frame, and re-checks every redirect |
| **Update-set lock** | UI tools can't open update-set records, processors or `upload.do` |
| **Read-only REST** | GET only. No JavaScript, delete, back-out or REST writes |
| **Secret filter** | Password fields, token, credential and session tables, and attachment contents are always refused |
| **Approvals** | Upload and commit need a human approval bound to the exact file's SHA-256 |
| **Agent hooks** | Block raw browsers, writes to `.snowgate/`, and human-only commands. If snowgate can't be loaded, the hook blocks |
| **Git hook** | Refuses commits that carry credentials or invalid change packages |

<details>
<summary><b>More detail on the security model</b></summary>

<br/>

- **One instance per task.** The target is stored per work item.
  - Approved instances confirm automatically.
  - Any other instance needs a human to type its host back.
  - Removing an instance from `approved_instances` revokes its targets.
- **Update-set pages.** The lock covers the classic `gsft_main` frame and the Next Experience and `nav_to.do` wrappers. Only the dedicated update-set tools (`ui_use_update_set`, upload, preview, commit) lift it, for one call, after their gates pass.
- **Upload and commit.**
  - Upload needs a change package that is `peer-reviewed` and passes `validate`, plus an upload approval.
  - Commit needs a clean preview and a separate commit approval.
  - Editing `update-set.xml` invalidates both approvals.
- **Isolated browser.** The gateway uses its own Chromium profile per instance, outside the project, and never your personal browser. An SSO session is kept for 12 hours by default (`SNOWGATE_SESSION_HOURS`).
- **Audit.** Every gateway call and CLI read goes to `.snowgate/audit/<work-id>.jsonl`. Credentials, cookies and tokens are redacted everywhere.
- **Shell checks.** Shell commands are judged one command at a time, so read-only commands may read `.snowgate/`, but nothing may write there.

</details>

---

## ⌨️ Commands

```bash
# ── You, once per project ───────────────────────────────────────────
snowgate setup                       # agent, instances, credentials, sign-in, check
snowgate doctor [--work <id>]        # is everything ready?

# ── You, when needed (human-only) ───────────────────────────────────
snowgate login --work <id>                      # SSO sign-in for the gateway's browser
snowgate target confirm --work <id>             # allow an instance that isn't approved
snowgate credentials set|show|remove --work <id>
snowgate approve --work <id> --package <change_id> --for plan|upload|commit
snowgate feedback list|send|clear [--sent]

# ── The agent (you can run them too) ────────────────────────────────
snowgate target set <instance> --work <id>      # bind an instance to the task
snowgate target show --work <id>
snowgate discover --work <id> [--scope <scope>] # map the project on the instance
snowgate check <table> <sys_id> <field>=<value>... --work <id>   # verify stored values
snowgate validate [--secrets]                   # change packages in changes/
snowgate mcp [--work <id>]                      # the MCP gateway (started by the agent)
snowgate init --agent claude|codex              # regenerate the agent files
```

<details>
<summary><b>Examples</b></summary>

<br/>

```bash
# Verify a change and save the result as the task's evidence
yallaflow verify PF-0007 -- snowgate check item_option_new <sys_id> include_none=false show_help=true --work PF-0007

# Map what the project has changed on the instance
snowgate discover --work PF-0001
```

`snowgate check` compares **stored** values, not labels: `true`/`false` for booleans, the value of a choice, a sys_id for a reference. Quote values that contain spaces. It exits with `1` on any mismatch.

`discover` writes to `.snowgate/discovery/<work-id>/`:

| File | Contents |
| --- | --- |
| `report.md` | Hazards, and the project map grouped by update set |
| `project-map.json` | Every artifact the project's update sets changed, in every scope including global, marked `new`, `baseline-modified` or `deleted` |
| `evidence.json` | The query and URL behind every fact |
| `limitations.md` | What could not be read |

</details>

---

## 🧰 Gateway tools

The agent sees these tools, and nothing else.

<details>
<summary><b>Read: REST, GET only (7 tools)</b></summary>

<br/>

| Tool | What it does |
| --- | --- |
| `sn_instance_info` | Version, the signed-in user and roles (warns on admin) |
| `sn_query` | Query any table; the agent lists the fields; sensitive data is refused |
| `sn_get_record` | One record with its link as evidence, including code fields (widget scripts, business rules, UI pages) |
| `sn_update_sets` | Local update sets by state, and each user's current set |
| `sn_update_set_contents` | The customer updates in one update set |
| `sn_customizations` | Customer updates grouped by type, optionally for one scope |
| `sn_portal_page` | A whole Service Portal page in one call: containers → rows → columns → widgets, with options and CSS |

</details>

<details>
<summary><b>Browser: its own Chromium, locked to the instance (6 tools)</b></summary>

<br/>

| Tool | What it does |
| --- | --- |
| `ui_navigate` | Open a path or URL on the instance |
| `ui_snapshot` | Accessibility snapshot of every frame |
| `ui_type` | Set a field by its kind: text, dropdown (by visible text or value), checkbox (`true`/`false`) |
| `ui_select` | Pick an option in a native, Service Portal or reference dropdown, and verify it |
| `ui_click` | Click a button, link, tab or checkbox (by role + name, label or text; `nth` for duplicates) |
| `ui_screenshot` | Full-page screenshot saved as evidence |

They handle ServiceNow's quirks for the agent:
- fields on closed form tabs are opened first;
- checkbox labels and Service Portal pickers work;
- after a save, the agent is told that ServiceNow returned to the previous page.

</details>

<details>
<summary><b>Update sets: gated (4 tools)</b></summary>

<br/>

| Tool | What it does |
| --- | --- |
| `ui_use_update_set` | Create or reuse `<work-id> - <title>` and make it current. Called before any change |
| `ui_upload_update_set` | Upload a reviewed package's `update-set.xml` (needs your upload approval) |
| `ui_preview_update_set` | Preview the uploaded set and return its problems |
| `ui_commit_update_set` | Commit it (needs your commit approval for that exact file) |

</details>

<details>
<summary><b>Feedback (1 tool)</b></summary>

<br/>

| Tool | What it does |
| --- | --- |
| `sn_report_gap` | The agent reports something it needed but snowgate didn't allow; kept for `snowgate feedback` |

</details>

---

## ⚙️ Configuration

`snowgate setup` writes `.snowgate/config.yaml`. The defaults suit most projects, and agents can't change this file.

<details>
<summary><b>All settings</b></summary>

<br/>

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `approved_instances` | hosts, with who approved them | `[]` | Instances an agent may bind without asking you |
| `credentials` | `protected` · `project` | `protected` | Where credentials are kept (below) |
| `ui_auth` | `profile` · `password` | `profile` | Browser sign-in: SSO via `snowgate login`, or the stored credentials with automatic re-login |
| `rest_auth` | `auto` · `basic` · `session` | `auto` | REST sign-in. `auto` falls back to the browser session when the instance refuses Basic auth |
| `data` | `all` · `listed` · `none` | `all` | What REST may read: every table, configuration plus `data_tables`, or configuration only |
| `data_tables` | table names | `[]` | Data tables readable with `data: listed` |
| `changes_dir` | path | `changes` | Where change packages live, for `validate` |

**Credentials.** `SN_USER` / `SN_PASSWORD` in the environment always win. Otherwise:
- **`protected`:** an owner-only file outside the project (`~/.config/snowgate/credentials/<instance>.json`). Agents can't read it.
- **`project`:** `.snowgate.env` in the project, readable by the agent. Use it for dev instances only. It is git-ignored, and the commit hook refuses it.

**Always refused, whatever `data` says:**
- `password` / `password2` fields;
- names like password, secret, token, credential, API key or session;
- session, token and credential tables, and attachment contents;
- queries that filter on such fields or contain `javascript:`.

</details>

---

## 💬 Feedback

When snowgate blocks something the agent needed, it remembers:
- refused fields and tables;
- UI actions that failed;
- missing tools;
- gaps the agent reports itself.

Everything stays on your machine, with instance names, sys_ids, e-mails, URLs and paths removed, until you choose to send it:

```bash
snowgate feedback list     # what's waiting
snowgate feedback send     # shows the exact text, asks, then opens an issue
```

Reports go to the public [snowgate-feedback](https://github.com/IbrahimBaki/snowgate-feedback) repository. `send` uses `gh` if you're signed in, and otherwise opens a prefilled GitHub page.

---

## ❓ FAQ

<details>
<summary><b>Does the agent ever see my password?</b></summary>

<br/>

Not with the default `credentials: protected`. The password lives in an owner-only file outside the project, and the hooks stop the agent from reading it. With SSO (`snowgate login`), the agent never sees a password or a cookie. The agent-visible `.snowgate.env` exists only when you choose it in `setup`, for dev instances.
</details>

<details>
<summary><b>Can the agent commit an update set to production?</b></summary>

<br/>

No. Its browser tools can't open update-set pages at all. Moving an update set means upload, preview and commit. Each step has its own gated tool, and upload and commit each need your approval for that exact file.
</details>

<details>
<summary><b>What if the agent tries a different instance?</b></summary>

<br/>

The browser aborts every request to a host other than the task's instance. Binding an instance that isn't approved needs you to type its host back with `snowgate target confirm`.
</details>

<details>
<summary><b>Do I need YallaFlow?</b></summary>

<br/>

Yes. snowgate ties every instance action to a YallaFlow work item, which gives each change its own update set, verification and history. Install it with `npm install -g yallaflow`, and run `yallaflow init`.
</details>

<details>
<summary><b>Does it work with SSO?</b></summary>

<br/>

Yes. Run `snowgate login --work <id>` once to sign the gateway's own browser in. The session is kept for 12 hours by default. REST can use the same session (`rest_auth: auto` or `session`), so no separate integration account is needed.
</details>

---

## 🩺 Troubleshooting

Start with `snowgate doctor --work <id>`.

| Symptom | Fix |
| --- | --- |
| `No YallaFlow project found` | Run `yallaflow init` in the project folder |
| `SESSION_EXPIRED` | `snowgate login --work <id>` |
| REST says 401 with the right password | Keep `rest_auth: auto`; snowgate switches to the browser session |
| `Playwright Chromium is missing` | `npx playwright install chromium` |
| The agent can't bind an instance | Approve it in `snowgate setup`, or run `snowgate target confirm --work <id>` |
| Claude Code doesn't show the plugin | Trust the folder, approve the `snowgate` MCP server, then check `/plugin` |
| Agent files are outdated after an upgrade | `snowgate init --agent claude` (or `codex`) |

---

## ⚠️ Known limitations

- The Codex adapter follows the Codex docs and has seen less real use than Claude Code.
- Upload, preview and commit follow standard ServiceNow behaviour but haven't been observed on a real instance yet.
- The browser lock may also block ServiceNow's update-set picker. That's intended, since switching update sets isn't allowed, but it hasn't been tested on a real instance.
- The hooks protect snowgate's state, not the operating system. The gateway is the primary guard.
- `data: listed` / `none` apply to REST reads, not yet to the UI tools.
- `snowgate login` drives a visible browser without the gateway's locks, because SSO must reach your identity provider. That's why it's human-only. Delete the profile folder to sign out.

---

## 🛠️ Development

```bash
git clone https://github.com/IbrahimBaki/snowgate.git
cd snowgate
npm install
npx playwright install chromium
npm test
```

- **Tests:** they use a local mock Table API and local fixture sites in a real headless Chromium. No ServiceNow instance is needed.
- **Diagrams:** the sources are in `docs/diagrams/`. Regenerate the images with `npm install --no-save mermaid@11 && node docs/diagrams/render.mjs mindmap task-flow architecture`.
- **Design:** [docs/PLAN.md](https://github.com/IbrahimBaki/snowgate/blob/main/docs/PLAN.md).

---

<div align="center">

**MIT licensed** · made for people who'd rather review a change than click through it

</div>
