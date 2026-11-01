import test from 'node:test';
import assert from 'node:assert/strict';
import {HealthMonitor} from '../../src/mcp/health-monitor.mjs';

function fixture({initial = {}, request, policy = {}} = {}) {
  let now = Date.parse('2026-11-01T00:00:00Z'), failed = false;
  const calls = [], transitions = [];
  const monitor = new HealthMonitor({initial, now: () => now, policy,
    request: request ?? (async (app, route, ...args) => {
      calls.push({app, route, options: args.at(-1)});
      if (failed) throw new Error('The operation was aborted due to timeout');
      return {ok: true, transport: app};
    }),
    onResult: (row, transition) => { if (transition) transitions.push({app: row.app, transition}); },
  });
  return {monitor, calls, transitions, advance(ms = 30000) { now += ms; }, fail(value = true) { failed = value; }};
}

test('isolated failure is degraded, preserves confirmed health, and recovery produces no alert pair', async () => {
  const f = fixture(); try {
    await f.monitor.probe('codex'); f.advance(); f.fail(); await f.monitor.probe('codex');
    const row = f.monitor.rows.codex;
    assert.equal(row.ok, false); assert.equal(row.confirmedOk, true); assert.equal(row.status, 'degraded');
    assert.equal(row.failedStep, 'service_http'); assert.equal(row.steps[0].timeoutMs, 10000);
    assert.equal(row.errorCode, 'HEALTH_PROBE_TIMEOUT'); assert.ok(row.elapsedMs >= 0);
    f.advance(); f.fail(false); await f.monitor.probe('codex');
    assert.deepEqual(f.transitions, []); assert.equal(f.monitor.rows.codex.consecutiveFailures, 0);
  } finally { f.monitor.close(); }
});

test('persistent failure alerts once after three spaced attempts and recovers once, including across restart', async () => {
  const f = fixture(); let restored; try {
    await f.monitor.probe('codex'); f.fail();
    for (let i = 0; i < 4; i++) { f.advance(); await f.monitor.probe('codex'); }
    assert.deepEqual(f.transitions, [{app: 'codex', transition: 'failure'}]);
    assert.equal(f.monitor.rows.codex.confirmedOk, false);
    restored = fixture({initial: JSON.parse(JSON.stringify(f.monitor.rows))});
    await restored.monitor.probe('codex'); await restored.monitor.probe('codex');
    assert.deepEqual(restored.transitions, [{app: 'codex', transition: 'recovery'}]);
    assert.equal(restored.monitor.rows.codex.recoveredFailures, 4);
  } finally { f.monitor.close(); restored?.monitor.close(); }
});

test('startup failures do not become confirmed by falling back from a null baseline to the last failed sample', async () => {
  const f = fixture(); try {
    f.fail(); await f.monitor.probe('claude'); f.advance(); await f.monitor.probe('claude');
    assert.equal(f.monitor.rows.claude.confirmedOk, null); assert.equal(f.transitions.length, 0);
    f.advance(); await f.monitor.probe('claude');
    assert.deepEqual(f.transitions, [{app: 'claude', transition: 'failure'}]);
  } finally { f.monitor.close(); }
});

test('rapid explicit checks cannot inflate failure counts or emit a false outage', async () => {
  const f = fixture(); try {
    await f.monitor.probe('codex'); f.advance(); f.fail();
    await Promise.all(Array.from({length: 12}, () => f.monitor.check(['codex'])));
    assert.equal(f.monitor.rows.codex.consecutiveFailures, 1); assert.equal(f.calls.length, 3);
    assert.equal(f.transitions.length, 0);
  } finally { f.monitor.close(); }
});

test('slow app is single-flight, healthy peers update immediately, and health HTTP wait stays bounded', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; }), calls = [];
  const f = fixture({policy: {responseWaitMs: 20}, request: async (app, route) => {
    calls.push({app, route});
    if (app === 'codex' && route.startsWith('/v1')) await pending;
    return {ok: true};
  }});
  try {
    const [a, b] = await Promise.all([f.monitor.check(['codex', 'claude', 'deepseek']), f.monitor.check(['codex'])]);
    assert.equal(a.checking, true); assert.equal(b.checking, true);
    assert.equal(f.monitor.rows.claude.ok, true); assert.equal(f.monitor.rows.deepseek.ok, true);
    assert.equal(calls.filter(row => row.app === 'codex').length, 2);
    finish(); await f.monitor.probe('codex');
    assert.equal(f.monitor.rows.codex.ok, true);
  } finally { finish(); f.monitor.close(); }
});

test('native timeout reports its own route, measured duration and budget, and ignores a late completion', async () => {
  let finish, signal;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({policy: {nativeTimeoutMs: 25}, request: async (app, route, method, body, key, options) => {
    if (route === '/health') return {ok: true};
    signal = options.signal;
    return pending;
  }});
  try {
    const row = await f.monitor.probe('codex');
    assert.equal(row.failedStep, 'native_threads'); assert.equal(row.steps.length, 2);
    assert.equal(row.steps[1].timeoutMs, 25); assert.equal(row.errorCode, 'HEALTH_PROBE_TIMEOUT');
    assert.ok(row.steps[1].elapsedMs >= 15); assert.equal(signal.aborted, true);
    finish({ok: true}); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.monitor.rows.codex.ok, false);
  } finally { finish({ok: true}); f.monitor.close(); }
});

test('closing cancels a probe without saving a false failure or leaking a long timeout', async () => {
  const f = fixture({request: () => new Promise(() => {})});
  const pending = f.monitor.probe('codex'); f.monitor.close();
  await pending;
  assert.equal(f.monitor.rows.codex, undefined); assert.deepEqual(f.transitions, []);
});
