import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifyRequest } from '../src/gateway/guards.js';
import { createGateway } from '../src/gateway/server.js';
import { loadPack } from '../src/pack.js';
import { ReadOnlyClient } from '../src/rest/client.js';
import { confirmTarget, setCandidate } from '../src/work.js';
import { INSTANCE, ME, PASSWORD, USER, makeProject, startMockServiceNow } from './helpers.js';

// PF-0016: the task's update set, made current before any change.
const WORK = 'PF-0003';
const pack = loadPack();
const SET = 'e'.repeat(32);

async function project() {
  const root = makeProject(WORK);
  writeFileSync(path.join(root, '.yallaflow', 'work', WORK, 'meta.yaml'), 'id: PF-0003\ntitle: Fix register page title\n');
  setCandidate(root, WORK, INSTANCE, pack.instancePattern);
  await confirmTarget(root, WORK, { ask: async () => INSTANCE, who: 'alice' });
  return root;
}

// A stand-in instance: the "UI" step creates the set and the preference.
function instance() {
  const state = { sets: [], prefs: [] };
  const tables = {
    sys_user: [{ sys_id: ME, user_name: USER }],
    sys_update_set: (params) => {
      const q = params.get('sysparm_query') ?? '';
      const prefix = /nameSTARTSWITH([^^]+)/.exec(q)?.[1];
      return state.sets.filter((s) => (!prefix || s.name.startsWith(prefix)) && s.state === 'in progress');
    },
    sys_user_preference: (params) => state.prefs.filter((p) => (params.get('sysparm_query') ?? '').includes(`user=${p.user}`)),
  };
  return { state, tables };
}

function session(state, calls) {
  return {
    origin: `https://${INSTANCE}`,
    async withUnlocked(fn) {
      const page = {};
      calls.push('unlocked');
      // What the instance would do when the UI action runs.
      await fn({
        goto: async (url) => calls.push(`goto ${url.replace(/^https:\/\/[^/]+/, '')}`),
        locator: (sel) => ({ fill: async (v) => calls.push(`fill ${sel}=${v}`), first: () => ({ click: async () => { calls.push(`click ${sel}`); state.sets.push({ sys_id: SET, name: page.name ?? 'PF-0003 - Fix register page title', state: 'in progress' }); state.prefs = [{ user: ME, value: SET }]; } }) }),
        getByText: (t) => ({ first: () => ({ click: async () => { calls.push(`click ${t}`); state.prefs = [{ user: ME, value: SET }]; } }) }),
        waitForLoadState: async () => {},
        waitForURL: async () => {},
      });
    },
    async close() {},
  };
}

test('ui_use_update_set creates "<work-id> - <title>" with Submit and Make Current and verifies it is current', async () => {
  const root = await project();
  const inst = instance();
  const mock = await startMockServiceNow({ tables: inst.tables });
  const calls = [];
  const gw = createGateway({ root, workId: WORK, pack, env: { SN_USER: USER, SN_PASSWORD: PASSWORD }, clientFactory: (o) => new ReadOnlyClient({ ...o, fetchImpl: mock.fetchImpl }), sessionFactory: () => session(inst.state, calls) });
  try {
    const r = await gw.call('ui_use_update_set', {});
    assert.equal(r.isError, undefined, r.content[0].text);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.update_set, 'PF-0003 - Fix register page title');
    assert.equal(out.created, true);
    assert.equal(out.current, true);
    assert.ok(calls.includes('fill [id="sys_update_set.name"]=PF-0003 - Fix register page title'));
    assert.ok(calls.includes('click [id="sysverb_insert_and_make_current"]'));

    // A second call reuses the same set and only makes it current.
    inst.state.prefs = [{ user: ME, value: 'd'.repeat(32) }];
    calls.length = 0;
    const again = JSON.parse((await gw.call('ui_use_update_set', {})).content[0].text);
    assert.equal(again.created, false);
    assert.ok(calls.includes('click Make This My Current Set'));
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('ui_use_update_set refuses to report success when the set did not become current', async () => {
  const root = await project();
  const inst = instance();
  inst.state.sets.push({ sys_id: SET, name: 'PF-0003 - Fix register page title', state: 'in progress' });
  const mock = await startMockServiceNow({ tables: inst.tables });
  const stuck = { origin: `https://${INSTANCE}`, withUnlocked: async () => {}, close: async () => {} }; // the UI action did nothing
  const gw = createGateway({ root, workId: WORK, pack, env: { SN_USER: USER, SN_PASSWORD: PASSWORD }, clientFactory: (o) => new ReadOnlyClient({ ...o, fetchImpl: mock.fetchImpl }), sessionFactory: () => stuck });
  try {
    const r = await gw.call('ui_use_update_set', {});
    assert.match(r.content[0].text, /UPDATE_SET_NOT_CURRENT/);
  } finally {
    await gw.close();
    await mock.close();
  }
});

test('form saves are not blocked by their body; update-set AJAX processors still are', () => {
  const origin = `https://${INSTANCE}`;
  assert.equal(classifyRequest(`${origin}/sp_page.do`, { origin, body: 'sys_target=sp_page&sysparm_update_set_id=abc&title=x' }).allowed, true);
  assert.equal(classifyRequest(`${origin}/xmlhttp.do`, { origin, body: 'sysparm_processor=UpdateSetAjax&sysparm_name=changeUpdateSet' }).code, 'URL_LOCKED');
  assert.equal(classifyRequest(`${origin}/sys_update_set.do?sys_id=1`, { origin }).code, 'URL_LOCKED');
});
