import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { SnowgateError } from '../errors.js';

// ServiceNow-specific steps of the dedicated update-set tools. They run only
// inside BrowserSession.withUnlocked, after the gateway's approval gates pass.
//
// The page paths, button names and REST state values below follow standard
// ServiceNow behaviour but are HYPOTHESES until observed on a confirmed
// instance (PF-0001 DL-001); failures surface as errors, never as guesses.

export function updateSetName(xmlPath) {
  const doc = new XMLParser().parse(readFileSync(xmlPath, 'utf8'));
  const remote = doc?.unload?.sys_remote_update_set;
  const name = (Array.isArray(remote) ? remote[0] : remote)?.name;
  if (!name) throw new SnowgateError('update-set.xml has no unload/sys_remote_update_set/name; cannot identify the retrieved update set.', 'XML_NAME_MISSING');
  return String(name);
}

const quote = (s) => String(s).replace(/\^/g, '');

export async function findRemoteUpdateSet(client, name) {
  const { records, evidence } = await client.query('sys_remote_update_set', {
    fields: ['sys_id', 'name', 'state', 'sys_created_on'],
    query: `name=${quote(name)}^ORDERBYDESCsys_created_on`,
    limit: 1,
  });
  return { record: records[0] ?? null, evidence };
}

export async function previewProblems(client, remoteSysId) {
  const { records, evidence } = await client.query('sys_update_preview_problem', {
    fields: ['sys_id', 'type', 'status', 'description', 'remote_update_set'],
    query: `remote_update_set=${remoteSysId}`,
  });
  return { problems: records, evidence };
}

async function waitForState(client, name, wanted, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { record } = await findRemoteUpdateSet(client, name);
    if (record && wanted.includes(record.state)) return record;
    if (Date.now() > deadline) {
      throw new SnowgateError(`Timed out waiting for update set "${name}" to reach state ${wanted.join('/')} (last: ${record?.state ?? 'not found'}).`, 'UPDATE_SET_TIMEOUT');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function uploadUpdateSet(page, origin, xmlPath) {
  await page.goto(`${origin}/upload.do?sysparm_referring_url=sys_remote_update_set_list.do&sysparm_target=sys_remote_update_set`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="file"]').setInputFiles(xmlPath);
  await Promise.all([page.waitForLoadState('load'), page.locator('input[type="submit"], button[type="submit"]').first().click()]);
}

export async function previewUpdateSet(page, origin, client, remote) {
  await page.goto(`${origin}/sys_remote_update_set.do?sys_id=${remote.sys_id}`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Preview Update Set' }).first().click();
  const record = await waitForState(client, remote.name, ['previewed']);
  return record;
}

export async function commitUpdateSet(page, origin, client, remote) {
  await page.goto(`${origin}/sys_remote_update_set.do?sys_id=${remote.sys_id}`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Commit Update Set' }).first().click();
  return waitForState(client, remote.name, ['committed']);
}

// ui_use_update_set (PF-0016): create the task's update set with the form's
// own "Submit and Make Current" action, or make an existing one current with
// "Make This My Current Set". Runs only inside withUnlocked; the result is
// verified through REST by the caller.
export async function createAndMakeCurrent(page, origin, name) {
  await page.goto(`${origin}/sys_update_set.do?sys_id=-1`, { waitUntil: 'load' });
  await page.locator('[id="sys_update_set.name"]').fill(name);
  await page.locator('[id="sysverb_insert_and_make_current"]').first().click();
  // Wait for the submit itself, not the page that is already loaded.
  await page.waitForURL((url) => !/sys_id=-1/.test(String(url)), { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
}

export async function makeCurrent(page, origin, sysId) {
  await page.goto(`${origin}/sys_update_set.do?sys_id=${sysId}`, { waitUntil: 'load' });
  await Promise.all([
    page.waitForLoadState('load').catch(() => {}),
    page.getByText('Make This My Current Set', { exact: true }).first().click(),
  ]);
}
