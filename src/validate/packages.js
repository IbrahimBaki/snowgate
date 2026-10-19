import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { parse } from 'yaml';
import { findApproval, requireApproval } from '../approvals.js';
import { loadConfig } from '../config.js';
import { SnowgateError } from '../errors.js';
import { WORK_ID_PATTERN } from '../workspace.js';

// Change-package validator: a generic Node port of the origin project's
// validate_change_packages.py (PLAN §10, §15.4). Local file checks only — it
// never touches ServiceNow, the network, or a browser.
//
// Differences from the origin, by design:
//   - legacy packages come from .snowgate/config.yaml, not a hard-coded set;
//   - `task_id` is the YallaFlow work item that owns the package;
//   - the origin's tasks/ front-matter approval is replaced by snowgate's
//     user-held approval records (PLAN §15 A5): `plan` before update-set.xml
//     may exist, `upload` from `imported`, `commit` for `committed`.

export const LIFECYCLE_STATES = [
  'draft', 'planned', 'xml-generated', 'peer-reviewed', 'imported',
  'previewed', 'awaiting-human-approval', 'committed', 'verified',
  'rolled-back',
];

const at = (state) => LIFECYCLE_STATES.indexOf(state);
const REQUIRES_PLAN_FROM = at('planned');
const REQUIRES_DISCOVERY_FROM = at('planned');
const REQUIRES_XML_FROM = at('xml-generated');
const REQUIRES_VERIFICATION_FROM = at('imported');
const REQUIRES_UPLOAD_APPROVAL_FROM = at('imported');
const REQUIRES_EVIDENCE_FROM = at('previewed');

const REQUIRED_MANIFEST_KEYS = ['change_id', 'task_id', 'title', 'source_baseline', 'xml_artifact', 'lifecycle_state'];
const EVIDENCE_STATUSES = new Set(['verified', 'user-approved', 'assumed', 'unknown']);
const PLACEHOLDER_RE = /^\s*(_.*_|<.*>|tbd|n\/?a|-|)\s*$/i;

const VERIFIED_MAPPING_COLUMNS = [
  'expected component',
  'verified servicenow table or xml record',
  'references and dependencies',
  'evidence source',
  'evidence location or url',
];

const isBlank = (value) => PLACEHOLDER_RE.test(value ?? '');
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// First Markdown table after a heading (any level, case-insensitive), as
// [{lowercased-header: cell}]. null if the heading is absent, [] if no real
// table follows it.
export function tableUnderHeading(text, heading) {
  const m = new RegExp(`^#{1,6}\\s*${escapeRe(heading)}\\s*$`, 'im').exec(text);
  if (!m) return null;
  const lines = [];
  let started = false;
  for (const line of text.slice(m.index + m[0].length).split('\n')) {
    const s = line.trim();
    if (s.startsWith('#') && started) break;
    if (s.startsWith('|')) {
      started = true;
      lines.push(s);
    } else if (started && !s) {
      continue;
    } else if (started) {
      break;
    }
  }
  if (lines.length < 2) return [];
  const header = splitRow(lines[0]).map((h) => h.toLowerCase());
  return lines
    .slice(2)
    .map(splitRow)
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}

function checkTargetRules(name, manifest, isV2, errors) {
  const hasPdiTarget = Boolean(manifest.pdi_target);
  const target = manifest.target;
  const hasTargetBlock = target && typeof target === 'object' && 'instance' in target;

  if (isV2) {
    if (hasPdiTarget) errors.push(`${name}: process_version 2 packages must not use the legacy 'pdi_target' field — use the 'target:' block instead`);
    if (!hasTargetBlock) errors.push(`${name}: process_version 2 packages must declare a 'target:' block with at least an 'instance' key`);
    if (manifest.process_version !== 2) {
      errors.push(`${name}: process_version 2 packages must explicitly set 'process_version: 2' (found ${JSON.stringify(manifest.process_version ?? null)})`);
    }
  } else if (!hasPdiTarget && !hasTargetBlock) {
    errors.push(`${name}: manifest.yaml has neither a legacy 'pdi_target' nor a 'target:' block`);
  }

  // A candidate_instance never counts as an approved target, so it is never
  // consulted here.
  if (hasTargetBlock && ![null, undefined, '', 'null'].includes(target.instance)) {
    if (!target.confirmed_by || !target.confirmed_at) {
      errors.push(
        `${name}: manifest.yaml target.instance is set to ${JSON.stringify(target.instance)} but confirmed_by/confirmed_at are missing — no target instance may appear as an operational value until explicitly confirmed by the user`,
      );
    }
  }
}

function checkComponentInventoryKeys(name, manifest, isV2, errors) {
  const hasLegacy = asList(manifest.affected_components).length > 0;
  const hasExpected = 'expected_components' in manifest;
  const hasVerified = 'verified_components' in manifest;
  if (isV2) {
    if (!hasExpected || !hasVerified) {
      errors.push(`${name}: process_version 2 packages must declare both 'expected_components' and 'verified_components', not the legacy 'affected_components' alone`);
    }
  } else if (!hasLegacy && !(hasExpected || hasVerified)) {
    errors.push(`${name}: manifest.yaml has no component inventory ('affected_components' or 'expected_components')`);
  }
}

function checkEvidenceRegister(name, manifest, planText, errors) {
  let register = tableUnderHeading(planText, 'Evidence Register');
  if (!register?.length) {
    errors.push(`${name}: plan.md has no Evidence Register table with real rows — a heading alone is not enough`);
    register = [];
  }
  for (const row of register) {
    const raw = (row.status ?? '').trim();
    const norm = raw.toLowerCase();
    if (!EVIDENCE_STATUSES.has(norm)) {
      errors.push(`${name}: plan.md Evidence Register has an invalid Status '${raw}' (must be Verified / User-approved / Assumed / Unknown)`);
      continue;
    }
    if (norm === 'verified' || norm === 'user-approved') {
      const missing = [];
      if (isBlank(row['claim or component'])) missing.push('Claim or component');
      if (isBlank(row['evidence source'])) missing.push('Evidence source');
      if (isBlank(row['evidence location or url'])) missing.push('Evidence location or URL');
      if (missing.length) {
        errors.push(`${name}: plan.md Evidence Register row marked ${raw} has empty/placeholder cell(s) for: ${missing.join(', ')} — an assumption cannot be labeled as confirmed`);
      }
    }
  }

  const verified = asList(manifest.verified_components);
  if (verified.length) {
    const claims = register
      .filter((r) => ['verified', 'user-approved'].includes((r.status ?? '').trim().toLowerCase()) && !isBlank(r['claim or component']))
      .map((r) => r['claim or component'].toLowerCase());
    for (const comp of verified) {
      if (!claims.some((c) => c.includes(String(comp).toLowerCase()))) {
        errors.push(`${name}: manifest.yaml lists '${comp}' in verified_components but no Verified/User-approved row in plan.md's Evidence Register backs it up`);
      }
    }
  }
}

function checkXmlStrategy(name, manifest, planText, errors) {
  const strategy = manifest.xml_strategy;
  if (strategy !== 'capture-and-export' && strategy !== 'direct-generation') {
    errors.push(`${name}: process_version 2 packages must set xml_strategy to 'capture-and-export' (default) or 'direct-generation'`);
    return;
  }
  if (strategy !== 'direct-generation') return;

  const rows = tableUnderHeading(planText, 'Verified Mapping');
  if (!rows?.length) {
    errors.push(
      `${name}: xml_strategy is 'direct-generation' but plan.md has no Verified Mapping table with real rows (a prose paragraph or an empty/heading-only section is not enough) — direct generation requires verified mapping evidence for every affected record/reference/dependency/payload structure`,
    );
    return;
  }
  const mapped = new Set();
  for (const row of rows) {
    const comp = row['expected component'] ?? '';
    const blank = VERIFIED_MAPPING_COLUMNS.filter((col) => isBlank(row[col]));
    if (blank.length) {
      errors.push(`${name}: Verified Mapping row for '${comp || '?'}' has empty/placeholder cell(s): ${blank.join(', ')} — every cell needs a real, traceable value`);
    }
    if (comp && !isBlank(comp)) mapped.add(comp.trim().toLowerCase());
  }
  for (const comp of asList(manifest.expected_components)) {
    if (!mapped.has(String(comp).trim().toLowerCase())) {
      errors.push(`${name}: xml_strategy is 'direct-generation' but expected_components entry '${comp}' has no matching row in the Verified Mapping table — every expected component needs one`);
    }
  }
}

// Baseline traceability for every package with XML: task_id names an existing
// YallaFlow work item and plan.md references it.
function checkXmlTraceability(name, root, manifest, planText, errors) {
  const taskId = manifest.task_id;
  if (!taskId) {
    errors.push(`${name}: update-set.xml exists but manifest.yaml has no task_id`);
    return null;
  }
  const exists = WORK_ID_PATTERN.test(String(taskId)) && existsSync(path.join(root, '.yallaflow', 'work', String(taskId)));
  if (!exists) {
    errors.push(`${name}: update-set.xml exists but task_id '${taskId}' is not an existing YallaFlow work item — an XML artifact requires a real, traceable work item`);
  }
  if (!planText.includes(String(taskId))) {
    errors.push(`${name}: update-set.xml exists but plan.md does not reference its approving task_id ('${taskId}')`);
  }
  return exists ? String(taskId) : null;
}

function checkPlanApproval(name, root, workId, manifest, errors) {
  const changeId = String(manifest.change_id ?? '');
  const record = findApproval(root, workId, changeId, 'plan');
  if (!record) {
    errors.push(
      `${name}: work item '${workId}' has no plan approval naming change_id '${changeId}' — update-set.xml requires an actually approved package scope. A human must run: snowgate approve --work ${workId} --package ${changeId} --for plan`,
    );
    return;
  }
  const problems = [];
  if (!record.approved_by) problems.push('approved_by is empty');
  if (!record.approved_at) problems.push('approved_at is empty');
  if (problems.length) errors.push(`${name}: plan approval for '${changeId}' is not valid — ${problems.join('; ')}`);
}

function checkHashedApproval(name, root, workId, manifest, purpose, xmlPath, errors) {
  if (!workId) return; // traceability already reported
  try {
    requireApproval(root, workId, String(manifest.change_id ?? ''), purpose, xmlPath);
  } catch (e) {
    if (!(e instanceof SnowgateError)) throw e;
    errors.push(`${name}: lifecycle_state '${manifest.lifecycle_state}' requires a current ${purpose} approval — ${e.message}`);
  }
}

export function checkPackage(root, pkgDir, legacy, errors, notes) {
  const name = path.basename(pkgDir);
  const manifestPath = path.join(pkgDir, 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    errors.push(`${name}: missing manifest.yaml`);
    return;
  }
  let manifest;
  try {
    manifest = parse(readFileSync(manifestPath, 'utf8')) ?? {};
  } catch (e) {
    errors.push(`${name}: manifest.yaml failed to parse (${e.message})`);
    return;
  }
  if (typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push(`${name}: manifest.yaml must be a mapping`);
    return;
  }
  if ('process_version' in manifest && /^\d+$/.test(String(manifest.process_version))) {
    manifest.process_version = Number(manifest.process_version);
  }

  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (manifest[key] == null || manifest[key] === '') errors.push(`${name}: manifest.yaml missing required key '${key}'`);
  }

  // Only a package named in .snowgate/config.yaml is legacy. A missing or
  // self-declared process_version grants nothing.
  const isLegacy = legacy.has(name);
  const isV2 = !isLegacy;
  if (isLegacy) {
    notes.push(`${name}: legacy package (pre-process-v2), validated under the old rules only. Must be migrated to the v2 schema before advancing past 'planned'.`);
  }

  checkTargetRules(name, manifest, isV2, errors);
  checkComponentInventoryKeys(name, manifest, isV2, errors);

  const state = manifest.lifecycle_state;
  const idx = LIFECYCLE_STATES.indexOf(state);
  if (idx < 0) {
    errors.push(`${name}: lifecycle_state '${state}' is not one of ${LIFECYCLE_STATES.join(', ')}`);
    return;
  }
  if (isLegacy && idx > REQUIRES_PLAN_FROM) {
    errors.push(`${name}: legacy package cannot advance past 'planned' (currently '${state}') until migrated to the process-v2 schema (manifest + Evidence Register + discovery.md)`);
  }

  const planPath = path.join(pkgDir, 'plan.md');
  if (idx >= REQUIRES_PLAN_FROM && !existsSync(planPath)) errors.push(`${name}: lifecycle_state is '${state}' but plan.md is missing`);
  const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : '';

  if (isV2 && idx >= REQUIRES_DISCOVERY_FROM && !existsSync(path.join(pkgDir, 'discovery.md'))) {
    errors.push(`${name}: lifecycle_state is '${state}' but discovery.md is missing (process_version 2 packages must record discovery evidence)`);
  }
  if (isV2 && existsSync(planPath)) {
    checkEvidenceRegister(name, manifest, planText, errors);
    checkXmlStrategy(name, manifest, planText, errors);
  }

  const xmlPath = path.join(pkgDir, 'update-set.xml');
  const hasXml = existsSync(xmlPath);
  if (idx >= REQUIRES_XML_FROM && !hasXml) errors.push(`${name}: lifecycle_state is '${state}' but update-set.xml is missing`);
  let workId = null;
  if (hasXml) {
    const result = XMLValidator.validate(readFileSync(xmlPath, 'utf8'));
    if (result !== true) errors.push(`${name}: update-set.xml is not well-formed XML (${result.err.msg} at line ${result.err.line})`);
    if (manifest.xml_artifact === 'pending') errors.push(`${name}: update-set.xml exists on disk but manifest.yaml still says xml_artifact: pending`);
    workId = checkXmlTraceability(name, root, manifest, planText, errors);
    if (isV2 && workId) checkPlanApproval(name, root, workId, manifest, errors);
  } else if (![null, undefined, 'pending'].includes(manifest.xml_artifact)) {
    errors.push(`${name}: manifest.yaml points xml_artifact at a file that doesn't exist`);
  }

  const verificationPath = path.join(pkgDir, 'verification.md');
  if (idx >= REQUIRES_VERIFICATION_FROM && !existsSync(verificationPath)) {
    errors.push(`${name}: lifecycle_state is '${state}' but verification.md is missing`);
  }
  if (hasXml && idx >= REQUIRES_UPLOAD_APPROVAL_FROM && state !== 'rolled-back') {
    checkHashedApproval(name, root, workId, manifest, 'upload', xmlPath, errors);
  }

  const evidenceDir = path.join(pkgDir, 'evidence');
  if (idx >= REQUIRES_EVIDENCE_FROM) {
    const has = existsSync(evidenceDir) && statSync(evidenceDir).isDirectory() && readdirSync(evidenceDir).some((f) => f !== '.gitkeep');
    if (!has) errors.push(`${name}: lifecycle_state is '${state}' but evidence/ has no captured evidence`);
  }

  // Commit evidence is the user-held commit approval for this exact XML, not
  // agent-editable text in verification.md (PLAN §15 A5).
  if (state === 'committed' || state === 'verified') {
    if (hasXml) checkHashedApproval(name, root, workId, manifest, 'commit', xmlPath, errors);
  }
}

export function validatePackages(root) {
  const config = loadConfig(root);
  const changesDir = path.join(root, config.changes_dir);
  const legacy = new Set(config.legacy_packages);
  const errors = [];
  const notes = [];
  if (existsSync(changesDir) && statSync(changesDir).isDirectory()) {
    for (const entry of readdirSync(changesDir).sort()) {
      const dir = path.join(changesDir, entry);
      if (entry.startsWith('_') || !statSync(dir).isDirectory()) continue;
      checkPackage(root, dir, legacy, errors, notes);
    }
  } else {
    notes.push(`No ${config.changes_dir}/ directory found — nothing to validate there.`);
  }
  return { ok: errors.length === 0, errors, notes };
}

// Lifecycle state and paths of one package, for the gateway's gates.
export function readPackage(root, changeId) {
  const config = loadConfig(root);
  const changesDir = path.join(root, config.changes_dir);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(changeId ?? '')) {
    throw new SnowgateError(`"${changeId}" is not a valid change package id.`, 'PACKAGE_INVALID');
  }
  const dirs = existsSync(changesDir) ? readdirSync(changesDir) : [];
  for (const entry of dirs) {
    const dir = path.join(changesDir, entry);
    const manifestPath = path.join(dir, 'manifest.yaml');
    if (entry.startsWith('_') || !existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = parse(readFileSync(manifestPath, 'utf8')) ?? {};
    } catch {
      continue;
    }
    if (String(manifest.change_id) === changeId) {
      return { dir, name: entry, manifest, xmlPath: path.join(dir, 'update-set.xml') };
    }
  }
  throw new SnowgateError(`No change package with change_id ${changeId} under ${config.changes_dir}/.`, 'PACKAGE_MISSING');
}

export function stateAtLeast(state, minimum) {
  const i = LIFECYCLE_STATES.indexOf(state);
  return i >= 0 && state !== 'rolled-back' && i >= LIFECYCLE_STATES.indexOf(minimum);
}
