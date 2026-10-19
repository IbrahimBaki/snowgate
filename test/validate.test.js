import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recordApproval } from '../src/approvals.js';
import { validatePackages } from '../src/validate/packages.js';
import { makeProject } from './helpers.js';

// Parity fixtures: the 18 cases of the origin's test_validate_change_packages.py,
// with `TASK-900` mapped to a YallaFlow work item and the tasks/ front-matter
// approval mapped to snowgate's `plan` approval record (PLAN §15 A5).
const WORK = 'PF-0900';
const strip = (s) => s.replace(/^\n/, '').replace(/^ {4}/gm, '');

function write(root, rel, content) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const GOOD_EVIDENCE_REGISTER = `
## Evidence Register

| Claim or component | Status | Evidence source | Evidence location or URL | Required preflight action |
|---|---|---|---|---|
| sc_cat_item mechanism | Assumed | General ServiceNow docs | https://docs.servicenow.com/ | Confirm during discovery |
`;

function baseManifest(overrides = {}) {
  const fields = {
    change_id: 'TEST-001',
    task_id: WORK,
    process_version: 2,
    title: '"Test package"',
    source_baseline: '"none"',
    xml_strategy: 'capture-and-export',
    xml_artifact: 'pending',
    lifecycle_state: 'planned',
    ...overrides,
  };
  const special = ['target', 'expected_components', 'verified_components'];
  const lines = Object.entries(fields).filter(([k]) => !special.includes(k)).map(([k, v]) => `${k}: ${v}`);
  lines.push(overrides.target ?? 'target: {instance: null, confirmed_by: null, confirmed_at: null}');
  lines.push(overrides.expected_components ?? 'expected_components: [sc_cat_item]');
  lines.push(overrides.verified_components ?? 'verified_components: []');
  return `${lines.join('\n')}\n`;
}

function minimalV2(root, pkg, overrides) {
  write(root, `changes/${pkg}/manifest.yaml`, baseManifest(overrides));
  write(root, `changes/${pkg}/plan.md`, `task_id: ${WORK}\n${GOOD_EVIDENCE_REGISTER}`);
  write(root, `changes/${pkg}/discovery.md`, 'placeholder discovery notes');
}

function planWith(extra) {
  return `task_id: ${WORK}\n${GOOD_EVIDENCE_REGISTER.trim()}\n\n${strip(extra).trim()}\n`;
}

async function approve(root, changeId, purpose, xmlPath) {
  return recordApproval(root, WORK, { changeId, purpose, xmlPath, ask: async () => changeId, who: 'alice' });
}

function check(name, build, expectPass, expectSubstring) {
  test(`parity: ${name}`, async () => {
    const root = makeProject(WORK);
    await build(root);
    const { ok, errors } = validatePackages(root);
    assert.equal(ok, expectPass, errors.join('\n'));
    if (expectSubstring) assert.ok(errors.some((e) => e.includes(expectSubstring)), `expected "${expectSubstring}" in:\n${errors.join('\n')}`);
  });
}

// --- Fix 1: target / process_version ---------------------------------------
check('Fix1: v2 package with only pdi_target is rejected', (root) => {
  write(root, 'changes/T1A-pkg/manifest.yaml', strip(`
    change_id: T1A
    task_id: ${WORK}
    process_version: 2
    title: "x"
    pdi_target: "dev123.service-now.com"
    source_baseline: "none"
    xml_strategy: capture-and-export
    expected_components: [sc_cat_item]
    verified_components: []
    xml_artifact: pending
    lifecycle_state: planned
  `));
  write(root, 'changes/T1A-pkg/plan.md', `task_id: ${WORK}\n${GOOD_EVIDENCE_REGISTER}`);
  write(root, 'changes/T1A-pkg/discovery.md', 'notes');
}, false, "must not use the legacy 'pdi_target'");

check('Fix1: v2 package with real target but missing confirmation is rejected', (root) => minimalV2(root, 'T1B-pkg', {
  target: 'target: {instance: "dev123.service-now.com", confirmed_by: null, confirmed_at: null}',
}), false, 'confirmed_by/confirmed_at are missing');

check('Fix1: v2 package with target.instance: null passes', (root) => minimalV2(root, 'T1C-pkg'), true);

check('Fix1: v2 package with a validly confirmed target passes', (root) => minimalV2(root, 'T1D-pkg', {
  target: 'target: {instance: "dev123.service-now.com", confirmed_by: "alice", confirmed_at: "2026-10-18"}',
}), true);

check('Fix1: non-legacy package without process_version: 2 is rejected', (root) => {
  write(root, 'changes/T1E-pkg/manifest.yaml', strip(`
    change_id: T1E
    task_id: ${WORK}
    title: "x"
    target: {instance: null, confirmed_by: null, confirmed_at: null}
    source_baseline: "none"
    xml_strategy: capture-and-export
    expected_components: [sc_cat_item]
    verified_components: []
    xml_artifact: pending
    lifecycle_state: planned
  `));
  write(root, 'changes/T1E-pkg/plan.md', `task_id: ${WORK}\n${GOOD_EVIDENCE_REGISTER}`);
  write(root, 'changes/T1E-pkg/discovery.md', 'notes');
}, false, "must explicitly set 'process_version: 2'");

check('Fix1: candidate_instance alone (instance still null) passes, is not treated as approved', (root) => minimalV2(root, 'T1F-pkg', {
  target: 'target: {instance: null, confirmed_by: null, confirmed_at: null, candidate_instance: "dev123.service-now.com"}',
}), true);

// --- Fix 2: Evidence Register rigor ----------------------------------------
const register = (row) => `task_id: ${WORK}\n## Evidence Register\n\n| Claim or component | Status | Evidence source | Evidence location or URL | Required preflight action |\n|---|---|---|---|---|\n${row}\n`;
function fix2(pkg, changeId, row) {
  return (root) => {
    write(root, `changes/${pkg}/manifest.yaml`, baseManifest({ change_id: changeId }));
    write(root, `changes/${pkg}/plan.md`, register(row));
    write(root, `changes/${pkg}/discovery.md`, 'notes');
  };
}
check('Fix2: Verified row with blank Evidence source fails', fix2('T2A-pkg', 'T2A', '| sc_cat_item exists | Verified |  | https://example.com/export.xml | none |'), false, 'Evidence source');
check('Fix2: User-approved row with blank Evidence location fails', fix2('T2B-pkg', 'T2B', '| sc_cat_item exists | User-approved | User decision |  | none |'), false, 'Evidence location or URL');
check('Fix2: Verified row with blank Claim or component fails', fix2('T2C-pkg', 'T2C', '|  | Verified | Real export | https://example.com/export.xml | none |'), false, 'Claim or component');

// --- Fix 3: XML requires an approved package scope -------------------------
function fix3(pkg, changeId, approvals) {
  return async (root) => {
    write(root, `changes/${pkg}/manifest.yaml`, baseManifest({
      change_id: changeId, lifecycle_state: 'xml-generated', xml_artifact: `"changes/${pkg}/update-set.xml"`,
    }));
    write(root, `changes/${pkg}/plan.md`, `task_id: ${WORK}\n${GOOD_EVIDENCE_REGISTER}`);
    write(root, `changes/${pkg}/discovery.md`, 'notes');
    write(root, `changes/${pkg}/update-set.xml`, '<unload></unload>');
    await approvals(root, path.join(root, 'changes', pkg, 'update-set.xml'));
  };
}
// origin: "approval is pending" -> only a non-plan approval exists
check('Fix3: only a non-plan approval exists -> XML rejected', fix3('T3A-pkg', 'T3A', (root, xml) => approve(root, 'T3A', 'upload', xml)), false, 'no plan approval');
// origin: "no approval block" -> no approval record at all
check('Fix3: no approval record at all -> XML rejected', fix3('T3B-pkg', 'T3B', async () => {}), false, 'no plan approval');
// origin: "scope doesn't name the change_id" -> plan approval for another package
check('Fix3: plan approval names another change_id -> XML rejected', fix3('T3C-pkg', 'T3C', (root) => approve(root, 'SOME-OTHER-PACKAGE', 'plan')), false, "naming change_id 'T3C'");
check('Fix3: correctly approved package scope -> XML accepted', fix3('T3D-pkg', 'T3D', (root) => approve(root, 'T3D', 'plan')), true);

// --- Fix 4: measurable Verified Mapping table ------------------------------
const MAPPING_HEADER = '| Expected component | Verified ServiceNow table or XML record | References and dependencies | Evidence source | Evidence location or URL |\n|---|---|---|---|---|';
function fix4(pkg, changeId, mapping, overrides = {}) {
  return (root) => {
    write(root, `changes/${pkg}/manifest.yaml`, baseManifest({ change_id: changeId, xml_strategy: 'direct-generation', source_baseline: '"a prior export"', ...overrides }));
    write(root, `changes/${pkg}/plan.md`, planWith(mapping));
    write(root, `changes/${pkg}/discovery.md`, 'notes');
  };
}
check('Fix4: prose paragraph instead of a mapping table fails', fix4('T4A-pkg', 'T4A', '## Verified Mapping\n\nThis is just a prose paragraph explaining the mapping informally, with no table at all.'), false, 'no Verified Mapping table with real rows');
check('Fix4: mapping table missing one expected_components entry fails', fix4('T4B-pkg', 'T4B', `## Verified Mapping\n\n${MAPPING_HEADER}\n| sc_cat_item | sc_cat_item | sc_category | real export | https://example.com/export.xml |`, {
  expected_components: 'expected_components: [sc_cat_item, sc_category]',
}), false, 'has no matching row in the Verified Mapping table');
check('Fix4: blank evidence cells in mapping table fail', fix4('T4C-pkg', 'T4C', `## Verified Mapping\n\n${MAPPING_HEADER}\n| sc_cat_item | sc_cat_item | none |  |  |`), false, 'empty/placeholder');
check('Fix4: valid complete mapping table passes', fix4('T4D-pkg', 'T4D', `## Verified Mapping\n\n${MAPPING_HEADER}\n| sc_cat_item | sc_cat_item | sc_category | real prior export | https://example.com/export.xml |`), true);

// --- Loophole regression ---------------------------------------------------
check('Loophole guard: copying an old-schema manifest under a new name is still rejected', (root) => {
  write(root, 'changes/NOTLEGACY-001-copy/manifest.yaml', strip(`
    change_id: NOTLEGACY-001
    task_id: ${WORK}
    title: "Copied from an old-schema package"
    pdi_target: "dev446072.service-now.com"
    source_baseline: "none"
    affected_components: [sc_cat_item]
    xml_artifact: pending
    lifecycle_state: planned
  `));
  write(root, 'changes/NOTLEGACY-001-copy/plan.md', `task_id: ${WORK}\n${GOOD_EVIDENCE_REGISTER}`);
}, false);

// --- snowgate-specific rules ------------------------------------------------
check('legacy packages come from .snowgate/config.yaml', (root) => {
  write(root, '.snowgate/config.yaml', 'validate:\n  legacy_packages: [OLD-001-pkg]\n');
  write(root, 'changes/OLD-001-pkg/manifest.yaml', strip(`
    change_id: OLD-001
    task_id: ${WORK}
    title: "legacy"
    pdi_target: "dev446072.service-now.com"
    source_baseline: "none"
    affected_components: [sc_cat_item]
    xml_artifact: pending
    lifecycle_state: planned
  `));
  write(root, 'changes/OLD-001-pkg/plan.md', 'legacy plan');
}, true);

check('task_id must be an existing YallaFlow work item once XML exists', async (root) => {
  await fix3('T5A-pkg', 'T5A', (r) => approve(r, 'T5A', 'plan'))(root);
  write(root, 'changes/T5A-pkg/manifest.yaml', baseManifest({ change_id: 'T5A', task_id: 'PF-0999', lifecycle_state: 'xml-generated', xml_artifact: '"x"' }));
  write(root, 'changes/T5A-pkg/plan.md', `task_id: PF-0999\n${GOOD_EVIDENCE_REGISTER}`);
}, false, 'is not an existing YallaFlow work item');

check('malformed update-set.xml is rejected', async (root) => {
  await fix3('T5B-pkg', 'T5B', (r) => approve(r, 'T5B', 'plan'))(root);
  write(root, 'changes/T5B-pkg/update-set.xml', '<unload><open></unload>');
}, false, 'not well-formed XML');

function imported(pkg, changeId, state = 'imported') {
  return async (root) => {
    await fix3(pkg, changeId, (r) => approve(r, changeId, 'plan'))(root);
    write(root, `changes/${pkg}/manifest.yaml`, baseManifest({ change_id: changeId, lifecycle_state: state, xml_artifact: `"changes/${pkg}/update-set.xml"` }));
    write(root, `changes/${pkg}/verification.md`, '# Verification\n');
    write(root, `changes/${pkg}/evidence/preview.png`, 'png');
    return path.join(root, 'changes', pkg, 'update-set.xml');
  };
}

check('imported requires a current upload approval', async (root) => {
  await imported('T6A-pkg', 'T6A')(root);
}, false, 'requires a current upload approval');

check('imported with a current upload approval passes', async (root) => {
  const xml = await imported('T6B-pkg', 'T6B')(root);
  await approve(root, 'T6B', 'upload', xml);
}, true);

check('editing update-set.xml after upload approval invalidates it', async (root) => {
  const xml = await imported('T6C-pkg', 'T6C')(root);
  await approve(root, 'T6C', 'upload', xml);
  writeFileSync(xml, '<unload><changed/></unload>');
}, false, 'different update-set.xml');

check('committed requires a commit approval, not verification.md text', async (root) => {
  const xml = await imported('T6D-pkg', 'T6D', 'committed')(root);
  await approve(root, 'T6D', 'upload', xml);
  write(root, 'changes/T6D-pkg/verification.md', '## Human approval\n- Approved by: someone\n');
}, false, 'requires a current commit approval');

check('committed with current upload and commit approvals passes', async (root) => {
  const xml = await imported('T6E-pkg', 'T6E', 'committed')(root);
  await approve(root, 'T6E', 'upload', xml);
  await approve(root, 'T6E', 'commit', xml);
}, true);
