import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { FrameReader, frame, unwrapTool, PipeRpc } from '../../src/adapters/codex/native.mjs';
import { startBridge } from '../../src/core/bridge.mjs';
import { normalizeExecution } from '../../src/core/contracts.mjs';

function removeTestDirectory(directory) {
  const resolved = path.resolve(directory);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(resolved).startsWith('codex-bridge-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
test('reconnect discovers a new desktop pipe; a disconnected mutation is never replayed', async () => {
  const makePath=()=>process.platform==='win32'?`\\\\.\\pipe\\codex-bridge-test-${crypto.randomUUID()}`:path.join(os.tmpdir(),`codex-bridge-${crypto.randomUUID()}.sock`);
  const firstPath=makePath(),secondPath=makePath(),sockets=new Set();let calls=0;
  const serve=()=>net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const reader=new FrameReader();
    socket.on('data',chunk=>{for(const message of reader.push(chunk)){calls++;if(message.method==='mutation')socket.destroy();else socket.write(frame({id:message.id,result:'ok'}));}});
  });
  const first=serve(),second=serve();await new Promise(resolve=>first.listen(firstPath,resolve));await new Promise(resolve=>second.listen(secondPath,resolve));
  let current=firstPath,discoveries=0;const rpc=new PipeRpc(null);rpc.resolvePath=async()=>{discoveries++;return current;};rpc.on('transportError',()=>{});
  try{
    assert.equal(await rpc.request('read'),'ok');current=secondPath;
    const disconnected=once(rpc,'disconnect');for(const socket of sockets)socket.destroy();await disconnected;
    assert.equal(await rpc.request('read'),'ok');assert.equal(discoveries,2);
    await assert.rejects(rpc.request('mutation'),/outcome may be unknown/);assert.equal(calls,3);
    assert.equal(await rpc.request('read'),'ok');assert.equal(calls,4);
  }finally{rpc.close();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>first.close(resolve)),new Promise(resolve=>second.close(resolve))]);}
});

test('framing handles fragmented UTF-8 and multiple native messages', () => {
  const messages = [{ text: '双向通信 📨' }, { value: 2 }];
  const bytes = Buffer.concat(messages.map(frame));
  const decoder = new FrameReader(); let received = [];
  for (const byte of bytes) received.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(received, messages);
  assert.throws(() => decoder.push(Buffer.from([255, 255, 255, 255])), /Invalid frame/);
});

test('native tool errors returned as plain text cannot masquerade as success', () => {
  assert.throws(() => unwrapTool({ contentItems: [{ type: 'inputText', text: 'create_thread received invalid arguments.' }] }), /invalid arguments/);
});

test('HTTP dispatch, durable idempotency, callbacks, message events and restart', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'));
  let created = 0;
  let turns = [];
  const tools = {
    callerThread: 'controller-test', close() {},
    async call(name) {
      if (name === 'create_thread') { created++; return { threadId: 'test-thread', hostId: 'local' }; }
      if (name === 'read_thread') return { thread: { status: { type: 'idle' } }, turns };
      throw new Error(`Unexpected tool: ${name}`);
    },
  };
  let bridge;
  async function start() { bridge = await startBridge({ tools, stateDir, port: 0, pollMs: 25, enableIpc: false }); }
  await start();
  const request = async (route, method = 'GET', data, headers = {}) => {
    const response = await fetch(`${bridge.baseUrl}${route}`, { method, headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { code: response.status, data: await response.json() };
  };
  try {
    assert.equal((await fetch(`${bridge.baseUrl}/health`)).status, 401);
    assert.equal((await request('/health', 'GET', undefined, { Origin: 'https://example.com' })).code, 403);
    const input = { prompt: 'Test only', title: 'Test' };
    const first = await request('/v1/tasks', 'POST', input, { 'Idempotency-Key': 'one' });
    assert.equal(first.code, 202); assert.equal(first.data.status, 'running');
    const duplicate = await request('/v1/tasks', 'POST', input, { 'Idempotency-Key': 'one' });
    assert.equal(duplicate.data.id, first.data.id); assert.equal(created, 1);
    const reordered = await request('/v1/tasks', 'POST', { title: input.title, prompt: input.prompt }, { 'Idempotency-Key': 'one' });
    assert.equal(reordered.data.id, first.data.id); assert.equal(created, 1);
    assert.equal((await request('/v1/tasks', 'POST', { prompt: 'different' }, { 'Idempotency-Key': 'one' })).code, 409);
    assert.equal((await request('/v1/tasks', 'POST', { prompt: 'next', threadId: 'test-thread' })).code, 409);
    assert.equal(first.data.callback.token,undefined);assert.equal(first.data.taskCallback.token,undefined);
    const cb = JSON.parse(fs.readFileSync(first.data.callback.credentialsFile,'utf8'));
    const outbound = { threadId: 'test-thread', messageId: 'message-one', text: 'From Codex' };
    assert.equal((await request('/v1/inbox', 'POST', outbound, { Authorization: 'Bearer wrong' })).code, 401);
    const accepted = await request('/v1/inbox', 'POST', outbound, { Authorization: `Bearer ${cb.token}` });
    assert.equal(accepted.code, 202);
    const repeated = await request('/v1/inbox', 'POST', outbound, { Authorization: `Bearer ${cb.token}` });
    assert.equal(repeated.data.eventId, accepted.data.eventId);
    assert.equal((await request('/v1/inbox', 'POST', { ...outbound, threadId: 'other' }, { Authorization: `Bearer ${cb.token}` })).code, 401);
    turns = [{ id: 'turn-one', status: 'completed', items: [{ type: 'agentMessage', id: 'msg-one', text: 'ACK', phase: 'final_answer' }] }];
    for (let i = 0; i < 50; i++) {
      if (bridge.state.tasks[first.data.id].status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(bridge.state.tasks[first.data.id].result, 'ACK');
    const events = await request('/v1/events');
    assert.equal(events.data.events.filter(x => x.type === 'session.outbound').length, 1);
    assert.equal(events.data.events.filter(x => x.type === 'session.message').length, 1);
    const sse = await fetch(`${bridge.baseUrl}/v1/events/stream`, { headers: { Authorization: `Bearer ${bridge.token}`, 'Last-Event-ID': String(accepted.data.eventId) } });
    const reader = sse.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /session.message/); await reader.cancel();
    const cursor = events.data.cursor;
    await bridge.close(); await start();
    const replayed = await request('/v1/tasks', 'POST', input, { 'Idempotency-Key': 'one' });
    assert.equal(replayed.data.id, first.data.id); assert.equal(created, 1);
    assert.equal((await request(`/v1/events?after=${cursor}`)).data.events.length, 0);
  } finally { await bridge?.close(); removeTestDirectory(stateDir); }
});

test('uncertain native dispatch is persisted and never retried automatically', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-unknown-'));
  let calls = 0;
  const tools = { callerThread: 'test', close() {}, async call() { calls++; throw new Error('Native request timeout; outcome unknown'); } };
  const bridge = await startBridge({ tools, stateDir, port: 0, enableIpc: false });
  try {
    const send = () => fetch(`${bridge.baseUrl}/v1/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Idempotency-Key': 'uncertain' }, body: JSON.stringify({ prompt: 'Test' }) });
    const first = await send(); assert.equal(first.status, 502); assert.equal((await first.json()).status, 'unknown');
    const repeated=await send();assert.equal(repeated.status,409);const replay=await repeated.json();assert.equal(replay.code,'CACHED_TASK_OUTCOME_UNKNOWN');assert.equal(replay.cachedResult,true);assert.equal(replay.retrySafe,false);assert.match(replay.error,/not executed again/);assert.equal(calls, 1);
  } finally { await bridge.close(); removeTestDirectory(stateDir); }
});

test('attachment preflight failures do not reserve a task or poison an idempotency key',async()=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-bridge-preflight-fail-'));let ready=false,creates=0;
  const native=new (await import('../../src/adapters/codex/native.mjs')).DesktopTools('test','caller',{executionRuntime:{ensureExecution:async()=>{if(!ready)throw Error('Unsupported desktop build; execution attachment refused');return {ready:true};}}});
  const tools={callerThread:'test',close(){native.close();},async prepareExecution(execution){await native.checkExecutionReady();return execution;},async call(name){if(name==='create_thread'){creates++;return {threadId:'created'};}return {thread:{status:{type:'idle'}},turns:[]};}};
  const bridge=await startBridge({tools,stateDir,port:0,enableIpc:false});
  const send=()=>fetch(bridge.baseUrl+'/v1/tasks',{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Idempotency-Key':'recoverable'},body:JSON.stringify({prompt:'test'})});
  try{
    const rejected=await send();assert.equal(rejected.status,503);assert.equal((await rejected.json()).code,'EXECUTION_PREFLIGHT_FAILED');assert.equal(creates,0);assert.equal(Object.keys(bridge.state.tasks).length,0);assert.equal(Object.keys(bridge.state.idempotency).length,0);
    ready=true;const accepted=await send();assert.equal(accepted.status,202);const first=await accepted.json();assert.equal(creates,1);
    assert.equal((await (await send()).json()).id,first.id);assert.equal(creates,1);
  }finally{await bridge.close();removeTestDirectory(stateDir);}
});

test('compatibility loss after reservation is a known pre-dispatch failure, not an uncertain native creation',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-bridge-preflight-race-'));let nativeCreates=0;
 const native=new (await import('../../src/adapters/codex/native.mjs')).DesktopTools('test','caller',{executionRuntime:{ensureExecution:async()=>{throw Error('Desktop compatibility changed');},executionRpc:async()=>{nativeCreates++;}}});
 const tools={callerThread:'test',close(){native.close();},prepareExecution:async e=>({...e,executionPolicy:{sandboxMode:'workspace-write',writableRoots:[],approvalPolicy:'on-request'}}),call:(name,args)=>native.call(name,args)};
 const bridge=await startBridge({tools,stateDir,port:0,enableIpc:false});
 const send=()=>fetch(bridge.baseUrl+'/v1/tasks',{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Idempotency-Key':'race'},body:JSON.stringify({prompt:'test'})});
 try{const r=await send(),task=await r.json();assert.equal(r.status,503);assert.equal(task.status,'failed');assert.equal(task.dispatchOutcome,'not-started');assert.equal(nativeCreates,0);const replay=await (await send()).json();assert.equal(replay.code,'CACHED_TASK_FAILURE');assert.equal(replay.retrySafe,true);assert.equal(nativeCreates,0);}
 finally{await bridge.close();removeTestDirectory(stateDir);}
});
test('asynchronous model/cwd preflight cannot duplicate a concurrent idempotent creation',async()=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-bridge-preflight-'));let creates=0,release;
  const gate=new Promise(resolve=>release=resolve),tools={callerThread:'test',close(){},async prepareExecution(input){await gate;return input;},async call(name){if(name==='create_thread'){creates++;return {threadId:'created',hostId:'local'};}return {thread:{status:{type:'idle'}},turns:[]};}};
  const bridge=await startBridge({tools,stateDir,port:0,enableIpc:false});
  try{
    const send=()=>fetch(bridge.baseUrl+'/v1/tasks',{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`,'Idempotency-Key':'same'},body:JSON.stringify({prompt:'test'})}).then(r=>r.json());
    const one=send(),two=send();await new Promise(resolve=>setTimeout(resolve,20));release();
    const [a,b]=await Promise.all([one,two]);assert.equal(creates,1);assert.equal(a.id,b.id);assert.equal(a.taskCallback.token,undefined);
  }finally{release();await bridge.close();removeTestDirectory(stateDir);}
});

test('execution validation rejects ambiguous configuration before any mutation', () => {
  assert.deepEqual(normalizeExecution({ projectId: 'project', environment: 'local', model: 'test-model', effort: 'high' }), { target: { type: 'project', projectId: 'project', environment: { type: 'local' } }, model: 'test-model', effort: 'high' });
  for (const input of [{ effort: 'turbo' }, { effort: 'low', thinking: 'high' }, { target: null }, { threadId: 'x', projectId: 'p' }, { projectId: 'p', environment: { type: 'worktree' } }]) assert.throws(() => normalizeExecution(input));
});

test('a tracked turn outside the recent window is reconciled by exact native history without taking an unrelated final answer',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-bridge-history-'));let oldVisible=true;const lookups=[];
 const tools={callerThread:'test',close(){},async readTrackedTurn(threadId,turnId){lookups.push([threadId,turnId]);return {id:'old',status:'interrupted',completionEvidence:'native-next-user-before-final',items:[]};},async call(name){if(name==='create_thread')return {threadId:'chat'};if(name==='read_thread')return {thread:{status:{type:'idle'}},turns:oldVisible?[{id:'old',status:'inProgress',items:[]}]:[{id:'new',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'unrelated answer'}]}]};throw Error(name);}};
 const bridge=await startBridge({tools,stateDir,port:0,pollMs:10,enableIpc:false});
 try{const r=await fetch(bridge.baseUrl+'/v1/tasks',{method:'POST',headers:{Authorization:`Bearer ${bridge.token}`},body:JSON.stringify({prompt:'test'})}),task=await r.json();for(let n=0;n<100&&!bridge.state.tasks[task.id].turnId;n++)await new Promise(r=>setTimeout(r,10));assert.equal(bridge.state.tasks[task.id].turnId,'old');oldVisible=false;for(let n=0;n<100&&bridge.state.tasks[task.id].status==='running';n++)await new Promise(r=>setTimeout(r,10));const saved=bridge.state.tasks[task.id];assert.equal(saved.status,'interrupted');assert.equal(saved.turnId,'old');assert.equal(saved.result,'');assert.equal(saved.completionEvidence,'native-next-user-before-final');assert.deepEqual(lookups,[['chat','old']]);}
 finally{await bridge.close();removeTestDirectory(stateDir);}
});

test('project/model/effort passthrough, effective settings, filtered thread listing and idle wake', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-config-'));
  const calls = [];
  let turns = [];
  const tools = {
    callerThread: 'controller', close() {},
    async readSettings() { return { settings: { model: 'test-model', reasoningEffort: 'high' } }; },
    async call(name, args) {
      calls.push({ name, args });
      if (name === 'create_thread' || name === 'send_message_to_thread') return { threadId: 'configured-thread', hostId: 'local' };
      if (name === 'read_thread') return { thread: { status: { type: 'idle' } }, turns };
      if (name === 'list_threads') return { pinnedThreads: [], threads: [
        { id: 'configured-thread', kind: 'codex', projectId: 'project', hostId: 'local', status: 'idle', title: 'Test project' },
        { id: 'other', kind: 'codex', projectId: 'other', hostId: 'local', status: 'active', title: 'Other' },
        { id: 'chat', kind: 'chatgpt', projectId: 'project', status: 'idle', title: 'Chat' },
      ] };
      throw new Error(name);
    },
  };
  const bridge = await startBridge({ tools, stateDir, port: 0, pollMs: 20, enableIpc: false });
  const request = async (route, method = 'GET', data) => {
    const response = await fetch(`${bridge.baseUrl}${route}`, { method, headers: { Authorization: `Bearer ${bridge.token}` }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  const finish = async (taskId, turnId) => {
    turns = [{ id: turnId, status: 'completed', items: [{ id: `message-${turnId}`, type: 'agentMessage', text: 'DONE', phase: 'final_answer' }] }, ...turns];
    for (let i = 0; i < 50 && bridge.state.tasks[taskId].status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bridge.state.tasks[taskId].status, 'completed');
  };
  try {
    const created = await request('/v1/threads', 'POST', { prompt: 'Test', projectId: 'project', environment: 'local', model: 'test-model', effort: 'high' });
    assert.equal(created.status, 202);
    const native = calls.find(x => x.name === 'create_thread').args;
    assert.deepEqual(native.target, { type: 'project', projectId: 'project', environment: { type: 'local' } });
    assert.equal(native.model, 'test-model'); assert.equal(native.thinking, 'high');
    assert.ok(native.prompt.startsWith('Test\n\n'));
    assert.ok(!native.prompt.includes('--credentials'));
    const guide = fs.readFileSync(path.join(stateDir, 'guide-v2.md'), 'utf8');
    assert.match(guide, /--tool bridge_decision/);
    const credentials = JSON.parse(fs.readFileSync(created.data.taskCallback.credentialsFile, 'utf8'));
    assert.equal(credentials.taskId, created.data.id);
    assert.equal(created.data.effectiveSettings.reasoningEffort, 'high');
    const listed = await request('/v1/threads?projectId=project&status=idle&q=test&limit=12');
    assert.deepEqual(listed.data.threads.map(x => x.id), ['configured-thread']);
    assert.equal(calls.find(x => x.name === 'list_threads').args.limit, 12);
    await finish(created.data.id, 'turn-one');
    const woke = await request('/v1/threads/configured-thread/wake', 'POST', { prompt: 'Continue', model: 'test-model', effort: 'low' });
    assert.equal(woke.status, 202); assert.equal(woke.data.operation, 'wake');
    const send = calls.find(x => x.name === 'send_message_to_thread').args;
    assert.equal(send.model, 'test-model'); assert.equal(send.thinking, 'low');
    await finish(woke.data.id, 'turn-two');
    assert.ok(bridge.state.tasks[woke.data.id].wakeConfirmedAt);
    const events = await request('/v1/events');
    assert.ok(events.data.events.some(x => x.type === 'session.awakened'));
  } finally { await bridge.close(); removeTestDirectory(stateDir); }
});

test('decision signals persist, pause completion, and answer wakes the same session exactly once', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-decision-'));
  let turns = [];
  let sends = 0;
  const tools = {
    callerThread: 'controller', close() {},
    async call(name) {
      if (name === 'create_thread') return { threadId: 'decision-thread', hostId: 'local' };
      if (name === 'send_message_to_thread') { sends++; return { threadId: 'decision-thread' }; }
      if (name === 'read_thread') return { thread: { status: { type: 'idle' } }, turns };
      throw new Error(name);
    },
  };
  let bridge = await startBridge({ tools, stateDir, port: 0, pollMs: 20, enableIpc: false });
  const request = async (route, method = 'GET', data, token) => {
    const response = await fetch(`${bridge.baseUrl}${route}`, { method, headers: { Authorization: `Bearer ${token ?? bridge.token}` }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const created = await request('/v1/tasks', 'POST', { prompt: 'Decide then continue' });
    assert.equal(created.data.taskCallback.token,undefined);
    const taskCredentials=JSON.parse(fs.readFileSync(created.data.taskCallback.credentialsFile,'utf8'));
    const signal = { taskId: created.data.id, messageId: 'decide-one', kind: 'decision', question: 'Choose?', options: ['A', 'B'], recommendation: 'A' };
    const asked = await request('/v1/inbox', 'POST', signal, taskCredentials.token);
    assert.equal(asked.status, 202);
    const repeated = await request('/v1/inbox', 'POST', signal, taskCredentials.token);
    assert.equal(repeated.data.decisionId, asked.data.decisionId);
    assert.equal((await request('/v1/inbox', 'POST', { ...signal, question: 'Different?' }, taskCredentials.token)).status, 409);
    turns = [{ id: 'decision-turn', status: 'completed', items: [{ id: 'waiting', type: 'agentMessage', phase: 'final_answer', text: 'Waiting' }] }];
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(bridge.state.tasks[created.data.id].status, 'awaiting_decision');
    assert.equal(bridge.state.tasks[created.data.id].completedAt, undefined);
    await bridge.close(); bridge = await startBridge({ tools, stateDir, port: 0, pollMs: 20, enableIpc: false });
    const pending = await request('/v1/decisions?status=pending');
    assert.equal(pending.data.decisions.length, 1);
    const answered = await request(`/v1/decisions/${asked.data.decisionId}/respond`, 'POST', { answer: 'A' });
    assert.equal(answered.status, 202); assert.equal(answered.data.continuation.threadId, 'decision-thread');
    const duplicateAnswer = await request(`/v1/decisions/${asked.data.decisionId}/respond`, 'POST', { answer: 'A' });
    assert.equal(duplicateAnswer.data.continuation.id, answered.data.continuation.id); assert.equal(sends, 1);
    assert.equal((await request(`/v1/decisions/${asked.data.decisionId}/respond`, 'POST', { answer: 'B' })).status, 409);
    turns = [{ id: 'answer-turn', status: 'completed', items: [{ id: 'done', type: 'agentMessage', phase: 'final_answer', text: 'FINAL' }] }, ...turns];
    for (let i = 0; i < 50 && bridge.state.tasks[created.data.id].status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bridge.state.tasks[created.data.id].result, 'FINAL'); assert.equal(sends, 1);
  } finally { await bridge.close(); removeTestDirectory(stateDir); }
});
