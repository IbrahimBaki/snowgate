# snowgate — Plan & Handoff

> **Status:** design agreed in discussion, **nothing implemented yet**. No repo created, no ServiceNow instance touched.
> **Date:** 2026-10-19
> **Origin:** discussion in the `SW-ZO-Sessions` repo. This file lives here temporarily and moves into the new `snowgate` repo as its first commit.
> **Read this first** if you are a new session/agent picking this up.

---

## 1. What snowgate is

`snowgate` is a **generic, agent-agnostic ServiceNow platform pack**. Any project that uses **YallaFlow** as its workflow controller can install it to work on ServiceNow safely.

It bundles:

- **Skills.** Procedures written in plain Markdown that any agent can read.
- **Guards.** Safety rules such as the instance lock, the commit-approval gate, and the upload gate.
- **MCP.** A gateway that sits in front of Playwright and the ServiceNow REST API.
- **Validators.** Checks on change packages, run locally and in git hooks.
- **A CLI** that ties everything together.

It must **not** carry any project-specific name, such as EduPulse.

---

## 2. Key findings that shaped the design

1. **YallaFlow 1.0.0 has no plugin API.**
   - `docs/roadmap.md` lists "Stable plugin API" under *Future directions*.
   - `docs/limitations.md` says YallaFlow writes no hooks, plugins, or settings files.
2. **YallaFlow skills are package-owned.** They are pinned by SHA-256, and `yallaflow doctor` fails if anyone edits them in place. So snowgate must **not** inject skills into YallaFlow's registry.
3. **Consequence:**
   - YallaFlow stays the **orchestrator**: work items, stages, approvals, knowledge, checkpoints.
   - snowgate is a **platform pack** that talks to YallaFlow through its existing CLI: `guide`, `verify --script`, `checkpoint`, `knowledge propose`, `question add`, `baseline draft`.
4. **The user can contact YallaFlow's maker.** After snowgate is implemented, we write a **Pack API spec** for them (see §12).
5. **Agents differ in their hook support.** Claude Code has rich hooks. Codex hook support is **unverified**. So enforcement must not depend on agent hooks. That is why the **MCP gateway** is the primary enforcement point (see §7).

---

## 3. User decisions (2026-10-19)

| # | Decision |
|---|---|
| 1 | snowgate lives in its **own separate repository**, like the earlier Zoho split. |
| 2 | **YallaFlow is the single source of truth** for workflow state. A project's own `tasks/` or `BOARD.md` is not authoritative. |
| 3 | The MVP includes **both Playwright and REST**. REST is read-only and is essential for discovery. |
| 4 | **Codex support is wanted**, alongside Claude Code. |
| 5 | Building snowgate itself is tracked as a **YallaFlow work item** in the new repo: discovery → plan → user approval → implement. |
| 6 | The name is **`snowgate`**: generic, with no project-specific branding. It was originally `snpack`, which was renamed because that npm name was taken (see §15 A1). |
| 7 | **`snowgate discover`** must be a strong, easy entry point for reading an existing ServiceNow project. |
| 8 | The YallaFlow Pack API spec is written **after** snowgate is implemented. |

---

## 4. Non-negotiable rules carried into snowgate

These rules come from the originating repo's CLAUDE.md and are generalised here.

- **The instance is per-task, never a global default.** A command writes it as `candidate_instance`. It becomes the operational `target.instance` only after the user explicitly confirms it, and `confirmed_by` and `confirmed_at` are recorded.
- **Discovery is read-only.** The REST client has no write verbs at all.
- **No Commit without explicit, current approval** that names the exact change package.
- **Credentials only come from env or the OS keychain.** They never go into git, XML, screenshots, plans, or reports.
- **Configuration only.** No transactional data or PII is read or exported.
- **Never fabricate** sys_ids, table metadata, or XML structure. Anything not verified on the target is recorded as an *Unknown* or a *limitation*.

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ YallaFlow  (work items · stages · approvals · knowledge)  │
└───────────────▲──────────────────────────────────────────┘
                │ guide / verify / checkpoint / knowledge propose / baseline draft
┌───────────────┴──────────────────────────────────────────┐
│ snowgate  (npm package, Node — same ecosystem as YallaFlow) │
│   pack.yaml  ── single source of truth                    │
│   skills/*.md                                             │
│   adapters/  claude · codex · yallaflow                   │
│   cli: init · doctor · discover · target · validate · mcp │
└───────────────┬──────────────────────────────────────────┘
                │ any MCP-capable agent (Claude, Codex, ...)
                ▼
        snowgate MCP gateway  ← guards enforced HERE
           │            │
           ▼            ▼
   Playwright (UI)   ServiceNow REST (read-only)
           │            │
           └──── confirmed target instance only ────┘
```

### Defense layers (from strongest to weakest)

1. **The MCP gateway.** It enforces guards for every agent.
2. **Browser isolation.** ~~Playwright's own `--allowed-origins` and `--isolated` flags.~~ *Amended 2026-10-19:* `@playwright/mcp`'s own help says `--allowed-origins` **does not serve as a security boundary**, so it is not a guard. The gateway now drives its own isolated Chromium (decision D1 = b) and is the only origin and URL lock; an in-memory context with downloads and service workers blocked is the isolation layer.
3. **Git pre-commit hook.** Runs the validator and a secret scan, and works regardless of agent.
4. **Agent-native hooks.** Claude Code `hooks.json`, and Codex hooks if they exist.
5. **Skill instructions.** These are advisory only.

---

## 6. `pack.yaml` (draft)

```yaml
name: servicenow
version: 0.1.0

config:
  instance:
    scope: per-task            # never a standing default
    pattern: "^[a-z0-9-]+\\.service-now\\.com$"
  credentials:
    source: env                # SN_USER / SN_PASSWORD (MVP); OAuth/keychain later

skills:
  - { id: sn-target-onboarding, file: skills/target-onboarding.md, stage: discovery }
  - { id: sn-discovery,         file: skills/discovery.md,         stage: discovery }
  - { id: sn-change-package,    file: skills/change-package.md,    stage: plan }
  - { id: sn-capture-change,    file: skills/capture-change.md,    stage: implementation }
  - { id: sn-export-xml,        file: skills/export-xml.md,        stage: implementation }
  - { id: sn-import-preview,    file: skills/import-preview.md,    stage: implementation }
  - { id: sn-commit-gate,       file: skills/commit-gate.md,       stage: approval }
  - { id: sn-portal-verify,     file: skills/portal-verify.md,     stage: verification }
  - { id: sn-rollback,          file: skills/rollback.md,          stage: close }
  - { id: sn-instance-audit,    file: skills/instance-audit.md,    stage: any }

guards:
  - { id: instance-lock,         on: browser.navigate,      rule: "host == target.instance" }
  - { id: no-arbitrary-code,     on: [browser.run_code, browser.evaluate], rule: deny }
  - { id: upload-reviewed-only,  on: browser.file_upload,   rule: "file is update-set.xml of a package >= peer-reviewed" }
  - { id: commit-needs-approval, on: commit_update_set,     rule: "approval evidence present for this exact package" }

validators:
  - { id: change-package, run: "snowgate validate" }

mcp:
  gateway: { command: "snowgate mcp" }
```

### Adapters generate the agent-specific files from `pack.yaml`

- **claude:**
  - `.claude-plugin/plugin.json`
  - `hooks/hooks.json`, using `${CLAUDE_PLUGIN_ROOT}` paths
  - `.mcp.json`
  - `skills/`
  - It can also be published as a Claude Code plugin marketplace.
- **codex:**
  - an `AGENTS.md` section
  - `config.toml` `[mcp_servers]`
  - skills
  - Codex skill and hook support **must be verified** first.
- **yallaflow:**
  - Today it wires `snowgate validate` as `yallaflow verify --script`.
  - Discovery output goes through `baseline draft` / `knowledge propose`.
  - It swaps to the native Pack API once one exists.

---

## 7. `snowgate mcp` — the gateway

A single MCP server that agents connect to **instead of** connecting to Playwright directly. It has three jobs.

### 7.1 Context: it knows the active target

On every call, it reads the active YallaFlow work item and that item's change package:

- `target.instance` (confirmed only)
- `lifecycle_state`
- approval evidence

If no confirmed target exists, every instance-touching tool refuses with a clear message such as "run `snowgate target set` and confirm".

### 7.2 Tools exposed (MVP)

**Read-only REST tools** (no write verbs exist in the client):

| Tool | Purpose |
|---|---|
| `sn_instance_info` | Version and family, the authenticated user, and that user's roles. Warns if the user is admin. |
| `sn_query` | Read-only Table API query. Only allow-listed configuration tables are permitted. `fields` is mandatory, so no `SELECT *` and no PII. |
| `sn_get_record` | One configuration record, plus its link as evidence. |
| `sn_update_sets` | List update sets by state, including In Progress ones and which one is current per user. |
| `sn_update_set_contents` | The `sys_update_xml` entries of one update set. |
| `sn_customizations` | Customer updates, grouped by type. |

**UI tools** (proxied to Playwright, with guards applied):

| Tool | Purpose |
|---|---|
| `ui_navigate`, `ui_snapshot`, `ui_click`, `ui_type`, `ui_screenshot` | Passed through to Playwright **only** when the target is the confirmed instance. |
| `ui_upload_update_set` | Upload only a `changes/<ID>/update-set.xml` whose package is at least `peer-reviewed`. |
| `ui_preview_update_set` | Run Preview and return the conflicts in a structured form, ready to write into `verification.md`. |
| `ui_commit_update_set` | **Guarded.** It requires recorded approval evidence that names this exact package. Otherwise it refuses. This is a *real* gate, not a heuristic match on button text. |

**Deliberately absent:**

- arbitrary JS (`run_code` / `evaluate`)
- any REST write
- delete, back out, or switching the current update set without a dedicated, separately-approved tool

### 7.3 Evidence: an audit trail

- Every call is appended to `.snowgate/audit/<work-id>.jsonl`. Each entry records the tool, the arguments with credentials redacted, the target, the result summary, and a timestamp.
- Screenshots and query results are saved under the change package's `evidence/` folder, together with record links. These are ready to be cited in the Evidence Register.
- Each REST result carries its query and URL, so a discovery fact always has a real source.

### 7.4 Why a gateway rather than raw Playwright plus hooks

- **It works for every agent.** Guards live in the server, not in Claude-only hooks.
- **The Commit gate becomes a real check.** It checks package state and approval evidence, rather than matching the text "Commit" on a click.
- **One place for credentials, redaction, the audit trail, and the instance lock.**

---

## 8. `snowgate discover` — the entry point

```bash
snowgate discover <instance> [--scope x_myapp]
```

The command reads the instance **read-only** and runs in five steps.

1. **Preflight.**
   - Checks that auth works.
   - Reads the version and family.
   - Reads the user's roles. If the user is admin, it warns and recommends a read-only integration user. The `snc_read_only` role is the candidate, but it **must be verified on the instance**.
2. **Inventory** (configuration only):
   - scoped apps and global customizations
   - all update sets with their state, flagging In Progress ones and the per-user current one
   - customer updates, grouped by type
   - custom tables and fields
   - business rules, script includes, client scripts, UI policies, ACLs
   - portals, pages, and custom widgets
   - catalog items and variables
   - flows, scheduled jobs, and REST messages
3. **Hazards:**
   - abandoned In Progress update sets
   - changes captured in the "Default" update set
   - unscoped customizations
4. **Output** under `.snowgate/discovery/<instance>/<timestamp>/`:
   - `inventory.json` — raw data
   - `report.md` — human-readable summary
   - `evidence.json` — the query and record link for every fact
   - `limitations.md` — what could not be read, and why
5. **YallaFlow handoff.** Findings enter as **candidates** through `baseline draft` / `knowledge propose`. They are never auto-confirmed, and the user reviews and approves them.

**Rules:**

- no writes
- no transactional or PII tables
- `fields` is always explicit
- any table that is missing or forbidden goes to `limitations.md`, never guessed
- all table names count as hypotheses until the preflight confirms they exist on that instance

---

## 9. CLI (MVP)

```
snowgate init --agent claude|codex        # generate agent files + install git hooks
snowgate doctor                           # config, credentials, connectivity, adapter integrity
snowgate discover <instance> [--scope X]  # §8
snowgate target set <instance> --work PF-xxxx   # writes candidate; user confirms → target
snowgate target confirm --work PF-xxxx    # records confirmed_by / confirmed_at
snowgate validate                         # change-package validator (manifest v2, evidence register, etc.)
snowgate mcp                              # §7 gateway (stdio MCP server)
```

### Installation and usage

```bash
npm install -g snowgate
cd my-servicenow-project
snowgate init --agent claude
snowgate discover dev12345.service-now.com
```

Claude Code can also install it as a marketplace plugin, because that is simply the output of the claude adapter.

---

## 10. Hooks (claude adapter; codex if supported)

| Event | Matcher | Action |
|---|---|---|
| PreToolUse | direct `mcp__playwright__*` | Deny, and say "use the snowgate gateway tools". This prevents bypassing the gateway. |
| PreToolUse | Bash `git commit` | Run the validator and the secret scan on staged files. |
| PostToolUse | Write/Edit on `changes/**` | Run `snowgate validate` immediately. |
| SessionStart | — | Show the active YallaFlow work item, the confirmed target, the lifecycle state, and any hazards. |
| Stop | — | Remind the agent to run `yallaflow checkpoint` if new evidence was not recorded. |

**Notes:**

- A project's `settings.local.json` may pre-allow Playwright tools. We **must verify** that a PreToolUse deny still fires for tools on the allowlist.
- **Existing assets to port** from `SW-ZO-Sessions/.claude/hooks/`:
  - `validate_change_packages.py`
  - `check_secrets.py`
  - `git_commit_gate.py`
  - `test_validate_change_packages.py`
- The validator has a **hard-coded legacy allowlist and repo-specific paths**. It must be split into generic rules, which ship in snowgate, and per-repo config in `.snowgate/config.yaml`. It will likely be ported to Node so snowgate has a single runtime. That decision is open.
- The procedure source to port into the skills is `SW-ZO-Sessions/skills/servicenow-update-set/SKILL.md`.

---

## 11. Repository layout (proposed)

```
snowgate/
  package.json            # bin: snowgate
  pack.yaml
  skills/*.md
  src/
    cli/                  # init, doctor, discover, target, validate, mcp
    gateway/              # MCP server, guards, audit
    rest/                 # read-only ServiceNow client (no write verbs)
    playwright/           # proxy to @playwright/mcp (isolated, allowed-origins)
    validate/             # change-package rules
    adapters/{claude,codex,yallaflow}/
  templates/              # manifest.yaml v2, plan.md, discovery.md, verification.md
  test/
  docs/
```

---

## 12. Later: YallaFlow Pack API spec (to send to YallaFlow's maker)

This is written **after** the snowgate MVP ships. The request will cover four points:

1. `yallaflow pack add <npm-package>` reads `pack.yaml`.
2. Pack skills register under a namespace, for example `servicenow/sn-discovery`, and are version- and SHA-pinned like built-in skills. `doctor` must not treat them as tampering.
3. **Stage gates.** A pack can block `advance` until a pack validator passes.
4. **A target on the work item.** A work item carries `target` (instance, confirmed_by, confirmed_at) so every agent reads it from one place.

Once this API exists, only the yallaflow adapter changes. `pack.yaml` stays the same.

---

## 13. Open items to verify (do NOT assume)

- [ ] What Codex currently supports for skills and hooks, plus the exact `config.toml` MCP syntax.
- [ ] Whether the Claude Code plugin `userConfig` feature exists for prompting values and storing secrets in the keychain.
- [ ] Whether a PreToolUse deny overrides a permissions allowlist entry.
- [ ] Whether the `snc_read_only` role exists and what it does on the target instance.
- [ ] Which exact table names the discovery inventory uses. Each must be confirmed by the preflight per instance.
- [ ] Validator runtime: keep Python, or port to Node.
- [ ] REST auth: Basic for the MVP, then OAuth.

---

## 14. Next steps (in order)

1. Create the repo at `/home/ibrahim/Desktop/deployment-configuration/www/snowgate`, then run `git init` and `yallaflow init`. **Awaiting user go-ahead.**
2. Move this file into the new repo as `docs/PLAN.md`.
3. `yallaflow feature "snowgate MVP" --scope architectural`. Then run discovery: read the YallaFlow CLI, the existing hooks and skill, and the Playwright MCP flags. Then write the plan and get user approval.
4. Implement in this order:
   1. CLI skeleton and `pack.yaml` loader
   2. read-only REST client and `discover`
   3. MCP gateway with guards and audit
   4. validator port
   5. claude adapter
   6. codex adapter
   7. yallaflow adapter
5. Test against an instance **only after** the user names and confirms one for that task.
6. Write the YallaFlow Pack API spec (§12).

---

## 15. Review amendments (2026-10-19) — pending user approval

Review done before implementation. Step 1 of §14 is complete: the repo exists at `www/snowgate` with `git init` and `yallaflow init --type greenfield --mode adaptive`, and this file is copied in (the original in SW-ZO-Sessions is left untouched).

### 15.1 Blocking findings (fix in the design before coding)

| # | Finding | Proposed fix |
|---|---|---|
| A1 | **The original npm name `snpack` was taken** by an unrelated package (`snpack@1.0.0`, repo `smteamwork/snpack`, last modified in 2022). | **Resolved (2026-10-19, user decision): renamed to `snowgate`.** It was confirmed free on the npm registry (404) on that date. The package, CLI binary, repo, and `.snowgate/` state folder all use this name. |
| A2 | **The commit gate can be bypassed.** Generic `ui_navigate`/`ui_click`/`ui_type` can reach the Retrieved Update Set page and press Commit, Back Out or Delete directly, which makes `ui_commit_update_set` decorative. | The gateway denies generic UI tools on update-set record and processor URLs (`sys_remote_update_set*`, `sys_update_set*`, `sys_update_preview*`, the commit/back-out processors). Those pages are reachable only through the dedicated tools. A URL-based lock, not button-text matching. |
| A3 | **`snowgate discover <instance>` breaks the per-task target rule.** It would touch an instance that no one has confirmed. | `discover` requires `--work <id>` whose target is **confirmed**. The only alternative is an interactive TTY confirmation (typed instance name) that is recorded in the audit log. It is never silent. |
| A4 | **Nothing stores the work item → change package → target mapping.** YallaFlow 1.0 can't hold it (that is §12's request). | snowgate owns `.snowgate/work/<work-id>.yaml`: `target{instance, candidate_instance, confirmed_by, confirmed_at}`, `change_packages: [...]`. The active work item comes from YallaFlow state (to verify: `yallaflow status`/`guide` machine-readable output, or `.yallaflow/state/current.yaml`). |
| A5 | **The guards trust files the agent can write.** `lifecycle_state` in `manifest.yaml` and the approval text in `verification.md` are editable by the agent being guarded. | The upload and commit gates also require a **user-created approval record**: a `yallaflow approve` entry for the work item, or `snowgate approve` run in a TTY, which records the hash of the exact `update-set.xml` being approved. If the file changes after approval, the approval is invalid. |
| A6 | **Gateway exclusivity is unproven.** This repo's origin session itself has a raw `playwright` MCP registered and pre-allowed. | Test early and locally with a dummy PreToolUse hook to see whether a deny overrides an allowlist entry. `snowgate doctor` warns when a raw Playwright MCP is configured alongside the gateway. |

| A7 | *(Found while writing M1.)* **The target confirmation is a file the agent can write.** `.snowgate/work/<id>.yaml` holds `confirmed_by`/`confirmed_at`, and `requireConfirmedTarget` trusts it. The TTY check only blocks piped input to `target confirm`. | M3: a claude-adapter hook denies agent Write/Edit on `.snowgate/**`. Later: a user-held confirmation record of the same kind as A5. Documented as a known limitation in the README until then. |

### 15.2 Non-blocking notes

- The instance regex `^[a-z0-9-]+\.service-now\.com$` excludes custom domains. Keep it for the MVP and add a config `allowed_host_patterns` later.
- **Hook paths must be absolute or plugin-root based.** Observed in practice: SW-ZO-Sessions' relative `python3 .claude/hooks/...` hooks break every Bash call once the session cwd moves to another folder. snowgate's adapters must use `${CLAUDE_PLUGIN_ROOT}` or absolute paths.
- Don't write the Codex adapter until Codex skill, hook and MCP config support is verified from its docs (§13).

### 15.3 Proposed MVP milestone split

- **M1 (first deliverable):**
  - CLI skeleton and `pack.yaml` loader.
  - A read-only REST client, structurally GET-only, with a table allowlist and mandatory `fields`.
  - `target set` and `target confirm`.
  - `discover`, gated per A3.
  - Tests run against a **local mock Table API** (`node:http`), with no real instance.
- **M2:**
  - The MCP gateway, with guards A2/A5, the audit trail, and the Playwright proxy (`--isolated --allowed-origins`).
  - The validator port.
- **M3:**
  - The claude adapter and `init`/`doctor`.
  - The yallaflow adapter.
  - The codex adapter, after verification.

### 15.4 Decisions requested from the user

1. ~~The npm package name (A1)~~ — decided: `snowgate`.
2. The validator runtime. **Recommendation:** port to Node for a single runtime, reusing `test_validate_change_packages.py` cases as parity fixtures.
3. ~~Approve amendments A2–A6 and the M1 scope.~~

**User approval (2026-10-19, in the agent session):** "موافق على A2–A6 وعلى Node للـ validator، ابدأ M1". Translation: approves A2–A6, approves Node for the validator, and says to start M1.

---

## 16. Status / handoff (2026-10-19)

**Update (M2 done, later on 2026-10-19):**

- The baseline PF-0002 was approved by the user and is now project memory.
- PF-0001 "snowgate MVP" went through discovery, clarification, design (D1–D8), specification (REQ-001..007 / AC-001..007) and the plan gate. The user approved: D1 = (b), the gateway drives Playwright directly; the new dependencies (`@modelcontextprotocol/sdk`, `playwright`, `fast-xml-parser`); and splitting the work. Approval note: "موافق على (ب) وعلى الاعتماديات والتقسيم، ابدأ M2".
- PF-0001 was decomposed into **PF-0003 (M2)** and **PF-0004 (M3, depends on M2)**. M1 (REQ-001/AC-001) is assessed at the parent.
- **PF-0003 (M2) is done:** approvals (`snowgate approve`), the Node validator (`snowgate validate [--secrets]`), and the MCP gateway (`snowgate mcp`) with its own Chromium, a route-level lock, a redacted audit trail, and gated upload/preview/commit. `npm test`: **83/83**. The design and rulings are in `.yallaflow/work/PF-0001/work.md` and PF-0003's progress ledger.
- **Open hypotheses (verify on a confirmed instance only):**
  - the `upload.do` form;
  - the *Preview Update Set* and *Commit Update Set* button names, and any in-page confirm modal;
  - the `sys_remote_update_set` state values (`loaded`, `previewed`, `committed`);
  - the `sys_update_preview_problem.status` values (empty = unresolved);
  - update-set processor names;
  - whether aborting the update-set picker degrades any page.
- **PF-0005 (SSO, user decision "بنستخدم SSO، موافق على الملف المخصّص لـ snowgate"):** amends D1.
  - The browser uses a dedicated per-instance snowgate profile, signed in by a human through SSO with `snowgate login`. The user's personal Chrome session is not used.
  - `ui_auth: password` stays as an opt-in.
  - It also fixed an M2 lock gap: redirects were not re-checked. Now every redirect target is checked before it is followed.
  - Open: how REST authenticates on SSO instances. Basic auth with an integration account is assumed; OAuth is the follow-up.
- **PF-0004 (M3) is done:**
  - `snowgate init --agent claude|codex` generates the claude project plugin (`.claude/skills/snowgate`, `${CLAUDE_PLUGIN_ROOT}` shims that fail closed), the codex config and AGENTS.md block, the yallaflow verify script, and the git pre-commit hook.
  - `snowgate doctor` checks configuration, credentials, the target, the profile, the adapters and any raw Playwright MCP.
  - `snowgate hook` is one agent-agnostic hook entry point.
  - §13 resolved from the vendor docs: Claude `userConfig` exists; an exit-2 PreToolUse hook blocks before allow rules (A6); Codex supports MCP, hooks, skills and AGENTS.md.
  - The Stop-hook reminder was dropped (loop risk).
- **Trial on dev446072 (2026-10-19), with follow-ups:**
  - PF-0007: session cookies were lost after login; snowgate now keeps them.
  - PF-0008: two credential stores, protected or agent-visible `.snowgate.env`, with automatic re-login.
  - PF-0009: `snowgate setup` with project-approved instances. It amends §4 per the user: an approved instance confirms automatically per work item.
  - Confirmed on the real instance:
    - the gateway opens pages with the saved session;
    - `URL_LOCKED` holds directly and through the Next Experience wrapper;
    - `HOST_LOCKED` holds.
- **Still open:**
  - the `skills/*.md` procedures;
  - how REST authenticates on SSO instances;
  - a first run in a live Claude and Codex session;
  - the instance-side hypotheses above;
  - the YallaFlow Pack API spec (§12).


**Update (later on 2026-10-19):**

- Steps 1–2 below are done. The folder is `www/snowgate`, YallaFlow was re-initialised as `snowgate`, and `npm install` ran.
- `npm test` passes: **26/26**.
- YallaFlow state:
  - **PF-0001** "snowgate MVP" (feature, architectural) is at INTAKE. The pre-work-item ruling is recorded.
  - **PF-0002** is the Repository Baseline. Its draft is recorded (17 facts, 3 limitations).
- **Waiting on:** the user's explicit approval of the baseline (`yallaflow baseline show PF-0002`). After the approval:
  1. Record it: `yallaflow baseline approve PF-0002 --note "Approved by <user> in the agent session: <their words>"`.
  2. Continue PF-0001 through `yallaflow guide PF-0001`: requirements and acceptance criteria, the specification from this plan, the planning gate, then M2.
- The user wants all chat replies in **Arabic**. Code, commands and paths stay as-is.

**Original note:** M1 code was written before it could be run. The session shell was blocked by the origin repo's relative-path hooks, so the code was written with file tools only.

Files:

- `package.json` (name `snowgate`, bin `snowgate`, dep `yaml`, `npm test`)
- `pack.yaml`
- `bin/snowgate.js`
- `src/`
  - `errors.js`, `instance.js`, `pack.js`, `workspace.js`
  - `work.js` — the `.snowgate/work/<id>.yaml` target per A4
  - `audit.js`
  - `rest/tables.js`, `rest/client.js`
  - `discover.js`
  - `cli/main.js`
- `test/`: `helpers.js` (mock Table API), `rest-client`, `target`, `discover`, `pack`, and `cli` tests
- `README.md`, `.gitignore`

Next steps, in order:

1. Rename the folder `www/snpack` → `www/snowgate`. Re-run `yallaflow init --name snowgate --type greenfield --mode adaptive`; the first init used the old name.
2. Run `npm install && npm test` and fix failures.
3. YallaFlow:
   - Run `yallaflow feature "snowgate MVP" --scope architectural`, then `guide`.
   - Record a ruling that the M1 code was written before the work item existed, because the shell was blocked.
   - Walk the stages `guide` requires, including REQ/AC. Record the user approval above at the gate `guide` names.
4. Commit only when the user asks.
5. M2: the MCP gateway (A2/A5/A6) and the Node validator port, with the Python tests as parity fixtures.
