import test from 'node:test';
import assert from 'node:assert/strict';
import {classify, blockedUnknown, watchUnknownBuilds, deepseekSelfTest, stalledDeliveries, WATCH_POLICY} from '../../src/compat/update-watch.mjs';

const build = h => ({runningBuild: {hashes: {asarSha256: h}}});
const apps = (codex, claude) => ({codex, claude});

function harness({certify, activate, appsValue} = {}) {
  const log = {notes: [], saves: 0, imported: [], activated: [], certified: []};
  let clock = 1_000_000;
  const deps = {
    doctor: async () => ({apps: appsValue ?? apps(build('c'), {...build('n'), code: 'BUILD_UNSUPPORTED'})}),
    certify: async app => { log.certified.push(app); if (certify) return certify(app); return {packages: {claude: {folder: 'F-claude', profileId: 'claude-new'}, codex: {folder: 'F-codex', profileId: 'codex-old'}}}; },
    importPackage: async folder => { log.imported.push(folder); },
    activate: async (app, id) => { log.activated.push([app, id]); if (activate) return activate(app, id); return {phase: 'waitingIdle'}; },
    notify: (title, body) => log.notes.push(title + ' | ' + body),
    save: () => { log.saves++; },
    now: () => clock,
  };
  return {deps, log, advance: ms => { clock += ms; }};
}

test('classify separates layout changes from things a person can clear', () => {
  assert.equal(classify('Manual analysis required: found 0 matches for manager').kind, 'structural');
  assert.equal(classify('codex native callback timed out: no Node-API callback').kind, 'user');
  assert.equal(classify('Claude test chat unavailable or archived').kind, 'user');
  assert.equal(classify('something odd').kind, 'unknown');
});

test('a passing run imports and activates only the unknown desktop', async () => {
  const {deps, log} = harness();
  const prefs = {enabled: true, attempts: {}};
  const result = await watchUnknownBuilds(prefs, deps);
  assert.equal(result.action, 'activated');
  assert.deepEqual(log.certified, ['claude']);
  assert.deepEqual(log.imported, ['F-claude']);
  assert.deepEqual(log.activated, [['claude', 'claude-new']]);
  assert.equal(result.attempt.done, true);
  assert.match(log.notes[0], /Codex/);
  // Already handled: nothing runs again for the same pair.
  assert.equal((await watchUnknownBuilds(prefs, deps)).action, 'skip');
  assert.equal(log.certified.length, 1);
});

test('a missed Codex click is retried after the backoff and then gives up', async () => {
  const {deps, log, advance} = harness({certify: () => { throw Error('codex native callback timed out: no Node-API callback'); }});
  const prefs = {enabled: true, attempts: {}};
  assert.equal((await watchUnknownBuilds(prefs, deps)).action, 'failed');
  assert.match(log.notes.at(-1), /点允许/);
  assert.equal((await watchUnknownBuilds(prefs, deps)).action, 'skip');
  for (let i = 1; i < WATCH_POLICY.maxAttempts; i++) { advance(WATCH_POLICY.retryAfterMs); assert.equal((await watchUnknownBuilds(prefs, deps)).action, 'failed'); }
  advance(WATCH_POLICY.retryAfterMs);
  assert.equal((await watchUnknownBuilds(prefs, deps)).action, 'skip');
  assert.equal(log.certified.length, WATCH_POLICY.maxAttempts);
});

test('a structural failure is never retried; activation failure stops without recovery', async () => {
  const s = harness({certify: () => { throw Error('Manual analysis required: found 0 matches for manager'); }});
  const prefs = {attempts: {}};
  await watchUnknownBuilds(prefs, s.deps);
  s.advance(WATCH_POLICY.retryAfterMs * 10);
  assert.equal((await watchUnknownBuilds(prefs, s.deps)).action, 'skip');
  assert.match(s.log.notes.at(-1), /修改适配代码/);

  const a = harness({activate: () => { throw Error('ATTACHMENT_ERROR'); }});
  const p2 = {attempts: {}};
  assert.equal((await watchUnknownBuilds(p2, a.deps)).action, 'activation-failed');
  a.advance(WATCH_POLICY.retryAfterMs * 10);
  assert.equal((await watchUnknownBuilds(p2, a.deps)).action, 'skip');
});

test('records written before classification are left alone', async () => {
  const {deps, log} = harness();
  const prefs = {attempts: {}};
  const key = 'asarSha256=c|asarSha256=n';
  prefs.attempts[key] = {at: 'old', status: '需要检查', error: 'x'};
  assert.equal((await watchUnknownBuilds(prefs, deps)).action, 'skip');
  assert.equal(log.certified.length, 0);
});

test('an unsupported desktop blocked by its partner is reported once', async () => {
  const blockedApps = apps({...build('c'), code: 'APP_NOT_RUNNING'}, {...build('n'), code: 'BUILD_UNSUPPORTED'});
  assert.match(blockedUnknown(blockedApps).reason, /codex 当前状态 APP_NOT_RUNNING/);
  const {deps, log} = harness({appsValue: blockedApps});
  const prefs = {attempts: {}};
  await watchUnknownBuilds(prefs, deps);
  await watchUnknownBuilds(prefs, deps);
  assert.equal(log.notes.length, 1);
  assert.equal(log.certified.length, 0);
});

test('DeepSeek self-test runs read-only methods once per plugin activation', async () => {
  const calls = [], notes = [];
  let imported = {pid: 1, time: 't1', source: 'a'};
  let broken = true;
  const deps = {
    imported: () => imported, now: () => 0, notify: t => notes.push(t),
    rpc: async (method, args) => {
      calls.push(method);
      if (method === 'list') return {items: [{sessionId: 's1', blank: false}]};
      if (method === 'inspect') { assert.deepEqual(args, {sessionId: 's1'}); if (broken) throw Error('ctx.sessionController.inspect is not a function'); return {events: []}; }
      return {};
    },
  };
  const state = {};
  assert.equal((await deepseekSelfTest(state, deps)).action, 'failed');
  assert.deepEqual(calls, ['list', 'inspect', 'models', 'workspaces']);
  assert.equal(notes.length, 1);
  assert.equal((await deepseekSelfTest(state, deps)).action, 'skip');
  broken = false; imported = {pid: 1, time: 't2', source: 'b'};
  assert.equal((await deepseekSelfTest(state, deps)).action, 'passed');
  assert.equal(notes.length, 1);
});

test('DeepSeek self-test waits while the plugin is unreachable', async () => {
  const state = {};
  const result = await deepseekSelfTest(state, {imported: () => ({pid: 1, time: 't', source: 's'}), now: () => 0, notify: () => assert.fail('no alert'), rpc: async () => { throw Error('fetch failed'); }});
  assert.equal(result.action, 'pending');
  assert.equal(state.done, undefined);
});

test('stalled deliveries alert once per route and error, ignore expected waits, and clear', () => {
  const notes = [], alerts = {};
  const now = Date.parse('2026-11-24T08:00:00Z');
  const row = (id, extra) => ({id, from: {app: 'deepseek'}, to: {app: 'codex'}, jobStatus: 'queued', reason: 'ctx.sessionController.inspect is not a function', faultSince: '2026-11-24T07:49:32Z', ...extra});
  const deps = {notify: t => notes.push(t), now: () => now};
  const rows = [row('a'), row('b'), row('c', {faultSince: '2026-11-24T07:58:00Z'}),
    row('d', {reason: 'Callback continuation waits for the current turn'}), row('e', {faultCode: 'CODEX_WINDOW_CLOSED', reason: 'closed'})];
  const first = stalledDeliveries(rows, alerts, deps);
  assert.equal(first.stalled.length, 1);
  assert.deepEqual(first.stalled[0].ids, ['a', 'b']);
  assert.equal(notes.length, 1);
  assert.equal(stalledDeliveries(rows, alerts, deps).changed, false);
  assert.equal(stalledDeliveries([], alerts, deps).changed, true);
  assert.match(notes.at(-1), /已恢复/);
  assert.deepEqual(alerts, {});
});
