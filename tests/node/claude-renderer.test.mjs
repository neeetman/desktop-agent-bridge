import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../../src/adapters/claude/claude-renderer.mjs';

async function scenario({ expiresAt, inflight = null }) {
  const files = new Map([['request.json', { id: 'r', token: 'test-token', method: 'sendMessage', args: ['t', 'prompt'], expiresAt }], ['response.json', null], ['inflight.json', inflight]]);
  const calls = []; let hydrated = false;
  globalThis.window = { 'claude.web': { LocalSessions: {
    async getSessionList() { hydrated = true; return { sessions: [] }; },
    async getSession() { return { sessionId: 'controller' }; },
    async readFileAtCwd(_root, file) { return { contents: JSON.stringify(files.get(file.split('/').at(-1))) }; },
    async writeSessionFile(_id, file, text) { files.set(file.split('/').at(-1), JSON.parse(text)); },
    onSessionDirectoryChanged() { return () => {}; },
    async watchSessionDirectories() { assert.equal(hydrated, true); },
    async sendMessage(...args) { calls.push(args); return { ok: true }; },
  } } };
  try {
    await bootstrap('root', 'runtime', 'test-token', ['sendMessage'], 'controller');
    window.__claudeGuiRelay.stop();
    return { calls, response: files.get('response.json') };
  } finally { delete globalThis.window; }
}
test('reconnect hydrates LocalSessions before watching, and refuses expired mutations', async () => {
  const result = await scenario({ expiresAt: Date.now() - 1 });
  assert.equal(result.calls.length, 0);
  assert.match(result.response.error, /expired/);
});
test('reconnect never replays an operation whose earlier outcome is unknown', async () => {
  const result = await scenario({ expiresAt: Date.now() + 60000, inflight: { id: 'r' } });
  assert.equal(result.calls.length, 0);
  assert.match(result.response.error, /refusing automatic replay/);
});
test('live request executes once and records its native response', async () => {
  const result = await scenario({ expiresAt: Date.now() + 60000 });
  assert.deepEqual(result.calls, [['t', 'prompt']]);
  assert.deepEqual(result.response, { id: 'r', result: { ok: true } });
});
