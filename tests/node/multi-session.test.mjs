import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerRouter } from '../../src/mcp/peer-router.mjs';
import { queryThreads } from '../../src/core/contracts.mjs';

test('separate destinations progress concurrently, one destination stays ordered, replies stay with their source', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-multi-'));
  const sent = [], tasks = new Map(), pending = [];
  const backendRequest = async (app, route, method, body) => {
    if (route.endsWith('/settings')) return { settings: {} };
    if (method === 'POST') {
      const id = `task-${sent.length}`;
      sent.push({ app, route, body }); tasks.set(id, { status: 'running' });
      if (route.includes('/claude-a/')) await new Promise(resolve => pending.push(resolve));
      return { id, status: 'running' };
    }
    if (route.startsWith('/v1/tasks/')) return tasks.get(route.split('/').at(-1));
    return { thread: { status: { type: 'idle' } } };
  };
  const router = new PeerRouter({ directory, backendRequest, pollMs: 1e9 });
  const turnByThread=new Map();router.currentTurn=async who=>turnByThread.get(who.threadId)??null;
  const tick = router.tick.bind(router); router.tick = async () => {};
  const sourceA = { app: 'codex', threadId: 'source-a' }, sourceB = { app: 'codex', threadId: 'source-b' };
  try {
    const a = await router.send({ from: sourceA, to: { app: 'claude', threadId: 'claude-a' }, text: 'first', messageId: 'same-client-key' });
    const b = await router.send({ from: sourceB, to: a.to, text: 'second', messageId: 'same-client-key' });
    const c = await router.send({ from: sourceB, to: { app: 'claude', threadId: 'claude-b' }, text: 'parallel', messageId: 'third' });
    const running = tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent.map(row => row.route), ['/v1/threads/claude-a/messages', '/v1/threads/claude-b/messages']);
    assert.equal(router.state.jobs[b.id].status, 'queued');
    assert.equal(router.state.jobs[c.id].status, 'delivered');
    pending.shift()(); await running;
    turnByThread.set(a.to.threadId,'turn-A');turnByThread.set(c.to.threadId,'turn-C');await router.acknowledge({from:a.to,messageId:a.id});await router.acknowledge({from:c.to,messageId:c.id});
    tasks.set('task-0', { status: 'completed', result: 'ACK_A',turnId:'turn-A' });
    tasks.set('task-1', { status: 'completed', result: 'ACK_C',turnId:'turn-C' });
    await tick();
    assert.deepEqual(router.receive(sourceA).messages.map(row => [row.replyTo, row.text]), [[a.id, 'ACK_A']]);
    assert.deepEqual(router.receive(sourceB).messages.map(row => [row.replyTo, row.text]), [[c.id, 'ACK_C']]);
    const second = tick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(row => row.route === '/v1/threads/claude-a/messages').length, 2);
    const secondTask = `task-${sent.findIndex(row => row.body.prompt.includes('\nsecond\n'))}`;
    pending.shift()(); await second;
    turnByThread.set(b.to.threadId,'turn-B');await router.acknowledge({from:b.to,messageId:b.id});tasks.set(secondTask, { status: 'completed', result: 'ACK_B',turnId:'turn-B' }); await tick();
    assert.deepEqual(router.receive(sourceB).messages.map(row => [row.replyTo, row.text]), [[c.id, 'ACK_C'], [b.id, 'ACK_B']]);
    assert.equal(router.receive(sourceA).messages.length, 1);
  } finally {
    pending.splice(0).forEach(resolve => resolve()); router.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('title search returns every visible duplicate rather than selecting an arbitrary recipient', () => {
  const raw = { threads: [
    { id: 'a', kind: 'codex', title: '桥接测试', projectId: 'p1' },
    { id: 'b', kind: 'codex', title: '桥接测试', projectId: 'p2' },
    { id: 'c', kind: 'codex', title: '别的任务', projectId: 'p1' },
  ] };
  assert.deepEqual(queryThreads(raw, new URLSearchParams({ q: '桥接测试' })).threads.map(row => row.id), ['a', 'b']);
  assert.deepEqual(queryThreads(raw, new URLSearchParams({ q: '桥接测试', projectId: 'p2' })).threads.map(row => row.id), ['b']);
});
