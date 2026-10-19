# PF-0001 — snowgate MVP

## Raw Request

snowgate MVP

## Routing

**Status:** pending

The coding agent must classify this request using the YallaFlow routing contract.

## Routing Decision

**Status:** routed
**Work type:** feature
**Scope:** architectural
**Confidence:** high
**Reason:** Explicitly classified by the user: `yallaflow feature --scope architectural`.
**Timestamp:** 2026-10-19T13:39:33.347Z
**Workflow:** feature
**Required capabilities:** discover, clarify, brainstorm, specify, plan, implement, verify, converge, review
**Behavior contract:** registry v8
**Skills:** context-discovery, requirement-clarification, design-exploration, specification, implementation-planning, implementation, verification, delivery-convergence, code-review
**Read-only:** no

## Intake

## Known Facts

## Open Questions

Structured material questions are authoritative in `questions.yaml`.

## Confirmed Decisions

## Discovery

Intent discovery on top of the approved baseline (17 facts, none stale). Full plan: `docs/PLAN.md`.

- **M1 exists and passes** (`npm test` 26/26): CLI, `pack.yaml` loader, read-only REST client, `target set|confirm|show`, gated `discover`.
- **Origin assets to port** (`SW-ZO-Sessions/.claude/hooks/`): `validate_change_packages.py` (manifest v2, 10 lifecycle states, Evidence Register, Verified Mapping, `tasks/` front-matter approval, hard-coded `LEGACY_PACKAGES`), its 18 regression cases, `check_secrets.py`, `git_commit_gate.py`.
- **`@playwright/mcp` 0.0.83**: `--isolated` and `--allowed-origins` exist, but its own help says `--allowed-origins` *does not serve as a security boundary*. PLAN §5 defense layer 2 is therefore not a guard; the gateway is the only origin/URL lock.
- **ServiceNow UI shape**: classic UI renders records inside the `gsft_main` iframe; Next Experience wraps the real page in an encoded path (`/now/nav/ui/classic/params/target/<encoded>`). A lock that reads only the top-level URL can be bypassed.
- No MCP SDK is installed; `@modelcontextprotocol/sdk` 1.32.1 is on npm.
- Limitations: no instance contacted (DL-001); Playwright MCP behaviour known from `--help` only (DL-002).

## Architecture / Technical Decisions

Classify only relevant decisions as confirmed, proposed, unresolved, or not applicable.

| # | Decision | Status |
|---|---|---|
| D1 | **UI lock architecture.** (a) Proxy `@playwright/mcp` over an MCP client and filter its tools; or (b) the gateway drives the `playwright` library itself and implements the `ui_*` tools. **Recommendation: (b).** Only (b) can block requests at the network level for every frame (`context.route`), read every frame's URL, and decode Next Experience paths. (a) sees only what Playwright MCP returns (top-level page URL), which DL-002 could not establish covers iframes. Cost of (b): snapshots use Playwright's public `ariaSnapshot()` and actions target role/name or text locators instead of Playwright MCP's refs. | proposed — user decides at the plan gate |
| D2 | **Locked surfaces (A2).** Requests whose path matches `sys_remote_update_set*`, `sys_update_set*`, `sys_update_preview*`, `sys_update_xml*`, or the commit / back-out / preview processors are aborted for generic `ui_*` tools in every frame and through decoded Next Experience targets. Only `ui_upload_update_set`, `ui_preview_update_set`, `ui_commit_update_set` lift the lock, for one call. Exact processor paths are hypotheses until observed on a confirmed instance. | confirmed (A2 approved); paths unresolved |
| D3 | **Allowlist exposure.** The gateway exposes only the named tools of PLAN §7.2. No tabs, back/forward, key press, evaluate, run_code, generic file upload, or dialog acceptance. After every action the gateway re-reads the frame URLs and refuses to continue on an off-target or locked page. | confirmed |
| D4 | **Approval record (A5).** `snowgate approve --work <id> --package <change_id> --for upload|commit` runs only in a TTY, needs the change_id typed back, and appends `{change_id, for, sha256(update-set.xml), approved_by, approved_at}` to `.snowgate/approvals/<work-id>.jsonl`. A gate passes only if the latest matching record's hash equals the current file hash. The record is agent-writable like A7; mitigation is the M3 hook. | confirmed (A5 approved) |
| D5 | **Active work item for the gateway.** `snowgate mcp --work <id>` (or `SNOWGATE_WORK`), else YallaFlow's active work item; refuse instance-touching tools when none or when the target is unconfirmed. | proposed |
| D6 | **Validator (Node port).** `src/validate/`, generic rules; per-repo `.snowgate/config.yaml` `{changes_dir: changes, legacy_packages: []}`; the origin's `tasks/` front-matter approval becomes the D4 record; the 18 Python cases become node:test parity fixtures. XML well-formedness via a small dependency (`fast-xml-parser` XMLValidator). | Node confirmed; dependency proposed |
| D7 | **New dependencies:** `@modelcontextprotocol/sdk` (stdio server), `playwright` (if D1=b), `fast-xml-parser`. Pinned in `package.json`; not added before the plan gate. | proposed |
| D8 | **Delivery split.** PF-0001 is decomposed into children M2 (gateway, guards, audit, approvals, validator) and M3 (claude + yallaflow adapters, init, doctor; codex only after its docs are verified). M1 is already implemented and is judged by PF-0001's own criteria. | proposed |
| — | REST writes, OAuth, custom domains | not applicable to the MVP (PLAN §4, §15.2) |

## Design

```
agent ──MCP stdio──► snowgate mcp (gateway)
                       ├─ context: work id → .snowgate/work/<id>.yaml (confirmed target)
                       ├─ REST tools  → ReadOnlyClient (M1, GET-only)
                       ├─ UI tools    → Playwright browser (isolated context)
                       │                 context.route: abort off-target hosts + locked paths
                       ├─ gates       → approvals/<id>.jsonl + sha256(update-set.xml) + validator
                       └─ audit       → audit/<id>.jsonl (every call, credentials redacted)
```

- `src/gateway/` server + tool registry; `src/gateway/guards.js` (host lock, locked-path matcher incl. Next Experience decoding, per-call unlock); `src/approvals.js`; `src/validate/`; `src/playwright/` browser session.
- Every tool call: resolve work → require confirmed target → guard → act → post-check frame URLs → audit → result with evidence (query + URL).
- Tests stay local: mock Table API (existing), a local HTTP fixture site standing in for the instance (via an injectable host/pattern for tests only), and validator fixtures. No real instance.

## Specification

Authoritative design source: `docs/PLAN.md` (§4, §7, §8, §9, §15). This section fixes the testable MVP behaviour.

### Goal and Scope

An npm CLI `snowgate` that lets any MCP-capable agent work on a ServiceNow instance inside a YallaFlow project, with guards enforced by snowgate rather than by the agent. In scope: M1 (done), M2 (MCP gateway, guards, audit, approval record, Node validator), M3 (claude and yallaflow adapters, `init`, `doctor`; codex only after its support is verified). Out of scope: REST writes, OAuth, custom domains, the YallaFlow Pack API.

### Actors and Permissions

- **Human (developer):** the only actor who can confirm a target (`target confirm`) or approve a package (`approve`); both require an interactive TTY and a typed-back value.
- **Agent:** may set a candidate, run discovery against a confirmed target, call gateway tools, run `validate`. It can never confirm or approve.

### Functional Requirements and Business Rules

1. Instances are per work item; nothing touches an instance without a confirmed target for that work item (M1, retained).
2. REST is structurally GET-only, allow-listed tables, mandatory allow-listed fields (M1, retained).
3. `snowgate mcp` exposes exactly the PLAN §7.2 tools; nothing else.
4. Generic UI tools cannot reach locked update-set surfaces in any frame (A2).
5. Upload requires a package at `peer-reviewed` or later that passes `validate`, plus a current upload approval whose hash matches `update-set.xml` (A5).
6. Commit requires a current commit approval for that exact change_id and hash (A5).
7. Every gateway call is appended to `.snowgate/audit/<work-id>.jsonl` with credentials redacted.
8. `snowgate validate` reproduces the origin validator's rules generically, with legacy packages from `.snowgate/config.yaml`.
9. `doctor` warns when a raw Playwright MCP is configured beside the gateway (A6).

### Workflows and Lifecycle

Change-package states (unchanged from origin): draft → planned → xml-generated → peer-reviewed → imported → previewed → awaiting-human-approval → committed → verified, plus rolled-back.

### Data and Integrations

- `.snowgate/work/<id>.yaml` (target, change_packages), `.snowgate/audit/<id>.jsonl`, `.snowgate/approvals/<id>.jsonl`, `.snowgate/config.yaml`, `changes/<ID>/{manifest.yaml, plan.md, discovery.md, update-set.xml, verification.md, evidence/}`.
- ServiceNow Table API (GET) and the instance UI through the gateway's browser.

### Validation and Error Behavior

Refusals are `SnowgateError` codes surfaced as MCP tool errors with the next human action (e.g. `TARGET_UNCONFIRMED`, `URL_LOCKED`, `APPROVAL_MISSING`, `APPROVAL_STALE`). `validate` exits 1 with all problems listed; 0 otherwise.

### Security and Privacy

Credentials only from env; never in audit, evidence or results. No JS evaluation tools. Isolated browser profile. Known limitation until M3: `.snowgate/**` records are agent-writable (A7); the claude-adapter hook denies agent writes there.

### UI / Screens

Not applicable (CLI and MCP only).

### Acceptance Criteria

Recorded as REQ/AC in `requirements.yaml`; summarised: M1 behaviours stay green; gateway tool list equals the allowlist; locked paths aborted in a child frame and via a Next Experience URL in a local fixture; upload/commit refuse without, with stale, and accept with a current approval; audit entries carry no credentials; validator passes all 18 parity cases; `doctor` flags a raw Playwright MCP.

### Unresolved Items

- Q-001 (D1 UI architecture) and Q-002 (dependencies, M2/M3 split) — awaiting the user.
- Exact ServiceNow processor paths for commit/back-out/preview — verify on a confirmed instance.
- Codex skill/hook/MCP support — verify from Codex docs before writing its adapter.

## Implementation Plan

M2 (after the plan gate), each step with tests first against local fixtures:

1. `src/approvals.js` + `snowgate approve` (TTY, typed change_id, sha256).
2. `src/validate/` Node port + `snowgate validate`; 18 parity fixtures; `.snowgate/config.yaml`.
3. `src/gateway/` MCP stdio server with REST tools over `ReadOnlyClient`, work resolution, audit with redaction.
4. `src/gateway/guards.js`: host lock, locked-path matcher (frames + Next Experience decoding).
5. `src/playwright/` session (per D1) and the `ui_*` tools; upload/preview/commit gates.
6. Secret scan (port of `check_secrets.py`) as `snowgate validate --secrets` for the git hook.

M3: claude adapter (`${CLAUDE_PLUGIN_ROOT}` hooks incl. `.snowgate/**` write deny, PreToolUse deny of raw Playwright), yallaflow adapter (`verify --script`), `init`, `doctor`; codex after verification.

## Verification Evidence

## Decisions / Rulings

## Knowledge Updates

## Result
