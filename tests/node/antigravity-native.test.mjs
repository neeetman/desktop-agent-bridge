import {projectURL} from '../../src/lib/paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {
  AntigravityNative, AntigravityTools, MAX_INLINE_CHARS, antigravityTurns, discoverHub, readTail, readTranscript, runAgentApi,
} from '../../src/adapters/antigravity/antigravity-native.mjs';
import {canonicalArguments, consumeBinding} from '../../src/adapters/antigravity/antigravity-binding.mjs';
import {verifiedPeer} from '../../src/mcp/delegations.mjs';
import {creationOrigin} from '../../src/core/contracts.mjs';

const TOKEN = 'csrf-secret-0123456789';
const ID = '11111111-2222-3333-4444-555555555555';
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };

function fakeSpawn(reply) {
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    calls.push({exe, args, env: options.env});
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => {
      const {code = 0, stdout = '', stderr = ''} = reply(args);
      child.stdout.end(stdout); child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return {calls, spawnImpl};
}

function fixture({hub = true} = {}) {
  const home = temp('agy-home-');
  const data = path.join(home, '.gemini', 'antigravity');
  const paths = {data, config: path.join(home, '.gemini', 'config'), daemon: path.join(data, 'daemon'),
    summaries: path.join(data, 'conversation_summaries.db'), brain: path.join(data, 'brain'), languageServer: path.join(home, 'language_server.exe')};
  write(paths.languageServer, 'stub');
  if (hub) write(path.join(paths.daemon, 'hub_4100.json'), {pid: 4242, httpPort: 4100, httpsPort: 4099, csrfToken: TOKEN, lsVersion: '2.32.1'});
  write(path.join(paths.config, 'projects', 'p1.json'), {id: 'p1', name: 'Demo', projectResources: {resources: [{gitFolder: {folderUri: 'file:///d%3A/Demo'}}]}});
  fs.mkdirSync(data, {recursive: true});
  const db = new DatabaseSync(paths.summaries);
  db.exec('CREATE TABLE conversation_summaries (conversation_id text primary key, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, status text, source text, project_id text, agent_name text, parent_conversation_id text, nesting_depth integer, killed numeric, not_fully_idle numeric)');
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run(ID, 'Bridge test', 'preview', 4, '2026-11-16 09:42:34.9247+00:00', '["file:///d%3A/Demo"]', 'CASCADE_RUN_STATUS_IDLE', '', 'p1', '', '', 0, 0, 0);
  insert.run('22222222-2222-3333-4444-555555555555', 'Subagent', '', 1, '2026-11-16 09:43:00+00:00', '[]', 'CASCADE_RUN_STATUS_RUNNING', '', 'p1', 'worker', ID, 1, 0, 1);
  insert.run('33333333-2222-3333-4444-555555555555', 'Killed', '', 1, '2026-11-16 09:44:00+00:00', '[]', 'CASCADE_RUN_STATUS_IDLE', '', '', '', '', 0, 1, 0);
  db.close();
  const steps = [
    {step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-16T09:42:29Z', content: '<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'},
    {step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: '2026-11-16T09:42:30Z', content: 'cut', truncated_fields: ['content']},
  ];
  write(path.join(paths.brain, ID, '.system_generated', 'logs', 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');
  write(path.join(paths.brain, ID, '.system_generated', 'logs', 'transcript_full.jsonl'), [steps[0], {...steps[1], content: 'the complete final answer', truncated_fields: undefined}].map(s => JSON.stringify(s)).join('\n') + '\n');
  return {home, paths};
}

const healthy = async url => ({status: /4100/.test(url) ? 200 : 500});

test('hub discovery picks the newest live, healthy hub and never serializes the CSRF token', async () => {
  const {home, paths} = fixture();
  try {
    write(path.join(paths.daemon, 'hub_5000.json'), {pid: 9999, httpPort: 5000, csrfToken: 'stale-token'});
    const later = Date.now() / 1000 + 60;
    fs.utimesSync(path.join(paths.daemon, 'hub_5000.json'), later, later);
    const {hub, checked} = await discoverHub({daemon: paths.daemon, fetchImpl: healthy, alive: pid => pid === 4242});
    assert.equal(hub.address, 'localhost:4100');
    assert.equal(hub.csrfToken, TOKEN);
    assert.doesNotMatch(JSON.stringify({hub, checked}), /csrf-secret|stale-token/);
    assert.deepEqual(checked.map(row => row.state), ['stale']);
    assert.equal((await discoverHub({daemon: paths.daemon, fetchImpl: healthy, alive: () => false})).hub, null);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('agentapi receives hub credentials only through the child environment and errors are redacted', async () => {
  const hub = {address: 'localhost:4100'}; Object.defineProperty(hub, 'csrfToken', {value: TOKEN, enumerable: false});
  const ok = fakeSpawn(() => ({stdout: JSON.stringify({response: {sendMessage: {recipientId: ID}}})}));
  assert.deepEqual(await runAgentApi(['send-message', ID, 'hi'], hub, {exe: 'ls.exe', spawnImpl: ok.spawnImpl}), {sendMessage: {recipientId: ID}});
  assert.equal(ok.calls[0].env.ANTIGRAVITY_CSRF_TOKEN, TOKEN);
  assert.equal(ok.calls[0].env.ANTIGRAVITY_LS_ADDRESS, 'localhost:4100');
  assert.ok(!ok.calls[0].args.some(arg => arg.includes(TOKEN)));
  const refused = fakeSpawn(() => ({code: 1, stdout: JSON.stringify({response: {}, error: `rpc error: code = Unavailable desc = dial tcp: connection refused token=${TOKEN}`})}));
  await assert.rejects(runAgentApi(['send-message', ID, 'hi'], hub, {exe: 'x', spawnImpl: refused.spawnImpl}), error => {
    assert.equal(error.status, 503); assert.equal(error.dispatchNotStarted, true); assert.equal(error.code, 'APP_NOT_RUNNING');
    assert.doesNotMatch(error.message, /csrf-secret/); return true;
  });
  const missing = fakeSpawn(() => ({code: 1, stdout: JSON.stringify({response: {}, error: 'rpc error: code = NotFound desc = trajectory not found'})}));
  await assert.rejects(runAgentApi(['get-conversation-metadata', ID], hub, {exe: 'x', spawnImpl: missing.spawnImpl}), {status: 404});
  const ambiguous = fakeSpawn(() => ({code: 2, stderr: 'panic: something odd'}));
  await assert.rejects(runAgentApi(['send-message', ID, 'hi'], hub, {exe: 'x', spawnImpl: ambiguous.spawnImpl}), error => error.status === 502 && !error.dispatchNotStarted);
});

test('turn boundaries: user input, a message that wakes an idle chat, mid-run messages and final answers', () => {
  const steps = [
    {step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nfirst\n</USER_REQUEST>'},
    {step_index: 1, type: 'PLANNER_RESPONSE', content: 'looking', tool_calls: [{name: 'read_file'}]},
    {step_index: 2, type: 'GENERIC', content: 'tool output'},
    {step_index: 3, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=system priority=HIGH content=steer now\n</SYSTEM_MESSAGE>'},
    {step_index: 4, type: 'PLANNER_RESPONSE', content: 'DONE ONE'},
    {step_index: 5, type: 'SYSTEM_MESSAGE', content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=abc priority=HIGH content=[bridge {"id":"m"}]\nwake up\n</SYSTEM_MESSAGE>'},
    {step_index: 6, type: 'PLANNER_RESPONSE', content: 'ACK', tool_calls: []},
    {step_index: 7, type: 'SYSTEM_MESSAGE', content: 'reminder without a message envelope'},
    {step_index: 8, type: 'USER_INPUT', content: 'third'},
    {step_index: 9, type: 'ERROR_MESSAGE', content: 'model failed'},
  ];
  const turns = antigravityTurns(steps, {now: 0});
  assert.deepEqual(turns.map(turn => [turn.id, turn.status]), [['step-0', 'completed'], ['step-5', 'completed'], ['step-8', 'failed']]);
  assert.deepEqual(turns[0].items.map(item => [item.type, item.phase ?? item.sender ?? null]), [['userMessage', null], ['agentMessage', 'commentary'], ['userMessage', 'system'], ['agentMessage', 'final_answer']]);
  assert.equal(turns[0].items[1].text, 'looking');
  assert.equal(turns[1].items[0].text, '[bridge {"id":"m"}]\nwake up');
  assert.equal(turns[1].items[1].phase, 'final_answer');
  assert.equal(turns[2].error, 'model failed');
  const running = antigravityTurns(steps.slice(0, 7), {running: true});
  assert.equal(running.at(-1).status, 'inProgress');
  const background = [
    {step_index: 0, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=system priority=HIGH content=sleep then answer\n</SYSTEM_MESSAGE>'},
    {step_index: 1, type: 'PLANNER_RESPONSE', content: 'launched in the background, waiting'},
    {step_index: 2, type: 'SYSTEM_MESSAGE', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=${ID}/task-6 priority=HIGH content=Task finished\n</SYSTEM_MESSAGE>`},
    {step_index: 3, type: 'PLANNER_RESPONSE', content: 'ACK-BUSY-3'},
  ];
  const resumed = antigravityTurns(background, {threadId: ID, now: 0});
  assert.deepEqual(resumed.map(turn => [turn.id, turn.status]), [['step-0', 'completed']], "the chat's own background task continues its turn");
  assert.deepEqual(resumed[0].items.filter(item => item.type === 'agentMessage').map(item => item.phase), ['commentary', 'final_answer']);
  assert.equal(antigravityTurns(background.slice(0, 2), {threadId: ID, running: true}).at(-1).status, 'inProgress');
  const partial = antigravityTurns(steps.slice(1, 7), {fromStart: false});
  assert.deepEqual(partial.map(turn => turn.id), ['step-5'], 'a window that starts mid-turn drops the unconfirmed leading turn');
});

test('tail reading stops early and truncated steps are restored from transcript_full', () => {
  const {home, paths} = fixture();
  try {
    const file = path.join(home, 'big.jsonl');
    fs.writeFileSync(file, Array.from({length: 200}, (_, index) => JSON.stringify({step_index: index, type: index % 50 === 0 ? 'USER_INPUT' : 'GENERIC', pad: 'x'.repeat(40)})).join('\n') + '\n');
    let inputs = 0;
    const window = readTail(file, record => record.type === 'USER_INPUT' && ++inputs >= 2, {chunkBytes: 256});
    assert.equal(window.fromStart, false);
    assert.ok(window.records[0].step_index <= 100 && window.records[0].step_index > 50);
    assert.equal(window.records.at(-1).step_index, 199);
    assert.deepEqual(readTail(file, () => false, {chunkBytes: 97}).records.map(record => record.step_index), Array.from({length: 200}, (_, index) => index));
    const transcript = readTranscript(paths.brain, ID);
    assert.equal(transcript.steps[1].content, 'the complete final answer');
    assert.throws(() => readTranscript(paths.brain, '../escape'), /UUIDs/);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('Antigravity tools read the index read-only, gate writes on a live hub and keep the -- before the prompt', async () => {
  const {home, paths} = fixture();
  try {
    let alive = true;
    const fake = fakeSpawn(args => {
      if (args[1] === 'new-conversation') return {stdout: JSON.stringify({response: {newConversation: {conversationId: '44444444-2222-3333-4444-555555555555'}}})};
      if (args[1] === 'send-message') return {stdout: JSON.stringify({response: {sendMessage: {recipientId: args.at(-2)}}})};
      if (args[1] === '--help') return {stdout: 'Usage: agentapi <command> [args]\n\nAvailable Commands:\n  get-conversation-metadata <conversation_id>\n  new-conversation [--model=<flash_lite|flash|pro|model_id>] [--title=<title>] <prompt>\n  send-message [--title=<title>] <recipient_id> <content>\n'};
      return {code: 1, stdout: JSON.stringify({response: {}, error: 'unexpected'})};
    });
    const native = new AntigravityNative({paths, fetchImpl: healthy, alive: () => alive, spawnImpl: fake.spawnImpl});
    const tools = new AntigravityTools({native, spillDirectory: path.join(home, 'spill')});
    const listed = await tools.call('list_threads', {limit: 10});
    assert.deepEqual(listed.threads.map(row => row.id), [ID], 'nested and killed conversations are not listed');
    assert.equal(listed.threads[0].projectName, 'Demo');
    assert.equal(listed.threads[0].status, 'idle');
    const read = await tools.call('read_thread', {threadId: ID});
    assert.equal(read.turns[0].status, 'completed');
    assert.equal(read.turns[0].items.at(-1).text, 'the complete final answer');
    assert.deepEqual((await tools.call('list_projects')).projects.map(project => project.label), ['Demo']);
    await assert.rejects(tools.call('create_thread', {prompt: 'x', target: {type: 'project', projectId: 'p1'}}), /cannot choose a project/);
    await assert.rejects(tools.call('create_thread', {prompt: 'x', target: {type: 'projectless'}, thinking: 'high'}), /reasoning by model tier/);
    await assert.rejects(tools.call('send_message_to_thread', {threadId: ID, prompt: 'x', model: 'pro'}), /keeps its model/);
    assert.equal(fake.calls.length, 0, 'invalid requests never reach agentapi');
    await tools.preflightDispatch({threadId: ID});
    assert.equal(fake.calls.filter(call => call.args[1] === '--help').length, 1);
    const created = await tools.call('create_thread', {prompt: '-starts-with-dash', title: 'T\nitle', model: 'flash', target: {type: 'projectless'}});
    assert.equal(created.threadId, '44444444-2222-3333-4444-555555555555');
    assert.deepEqual(fake.calls.at(-1).args, ['agentapi', 'new-conversation', '--model=flash', '--title=T itle', '--', '-starts-with-dash']);
    assert.deepEqual(await tools.call('send_message_to_thread', {threadId: ID, prompt: 'hello'}), {threadId: ID, delivery: 'agentapi-send-message'});
    assert.deepEqual(fake.calls.at(-1).args, ['agentapi', 'send-message', '--title=Desktop bridge', ID, 'hello']);
    const long = 'y'.repeat(MAX_INLINE_CHARS + 10);
    await tools.call('send_message_to_thread', {threadId: ID, prompt: long});
    const sent = fake.calls.at(-1).args.at(-1);
    assert.ok(sent.length <= MAX_INLINE_CHARS);
    const spilled = /from: (.+\.md)$/.exec(sent)[1];
    assert.equal(fs.readFileSync(spilled, 'utf8'), long);
    alive = false;
    const before = fake.calls.length;
    await assert.rejects(tools.call('send_message_to_thread', {threadId: ID, prompt: 'queued'}), error => error.status === 503 && error.dispatchNotStarted && error.code === 'APP_NOT_RUNNING');
    await assert.rejects(tools.preflightDispatch({threadId: ID}), {code: 'APP_NOT_RUNNING'});
    assert.equal(fake.calls.length, before);
    assert.equal((await tools.call('read_thread', {threadId: ID})).thread.id, ID, 'reads work while the desktop is closed');
    await assert.rejects(tools.call('read_thread', {threadId: '33333333-2222-3333-4444-555555555555'}), {status: 404});
    alive = true;
    const pending = '55555555-2222-3333-4444-555555555555';
    const metadata = fakeSpawn(args => args[1] === 'get-conversation-metadata' && args[2] === pending
      ? {stdout: JSON.stringify({response: {conversationMetadata: {metadata: {workspaceUris: [], createdAt: '2026-11-16T09:53:49.444912Z'}}}})}
      : {code: 1, stdout: JSON.stringify({response: {}, error: 'rpc error: code = NotFound desc = trajectory not found'})});
    const fresh = new AntigravityTools({native: new AntigravityNative({paths, fetchImpl: healthy, alive: () => true, spawnImpl: metadata.spawnImpl})});
    const indexed = await fresh.call('read_thread', {threadId: pending});
    assert.equal(indexed.thread.indexPending, true, 'a chat the index has not listed yet is resolved through the hub');
    assert.equal(indexed.thread.status.type, 'active');
    await assert.rejects(fresh.call('read_thread', {threadId: '66666666-2222-3333-4444-555555555555'}), {status: 404});
    assert.deepEqual((await tools.listModels()).models.map(model => model.id), ['flash_lite', 'flash', 'pro']);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('contract probes report missing agentapi commands and index columns', async () => {
  const {home, paths} = fixture();
  try {
    const fake = fakeSpawn(() => ({stdout: 'Available Commands:\n  send-message [--title=<title>] <recipient_id> <content>\n'}));
    const native = new AntigravityNative({paths, fetchImpl: healthy, alive: () => true, spawnImpl: fake.spawnImpl});
    const contract = await native.contract();
    assert.equal(contract.ok, false);
    assert.deepEqual(contract.checks.find(check => check.check === 'agentapi_commands').missing, ['new-conversation', 'get-conversation-metadata']);
    assert.equal(contract.checks.find(check => check.check === 'conversation_summaries_columns').ok, true);
    await assert.rejects(native.requireContract(), error => error.code === 'CONTRACT_MISMATCH' && error.dispatchNotStarted);
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('fallback hook binding identifies exactly one chat per call and the hook always returns a decision', async () => {
  const directory = temp('agy-bindings-');
  try {
    const args = {toApp: 'codex', text: 'hi'};
    const record = (conversationId, at = Date.now(), tool = 'bridge_send', value = args) => write(path.join(directory, `${at}-${conversationId}.json`), {conversationId, tool, digest: canonicalArguments(value), at});
    assert.equal(canonicalArguments('{"text":"hi","toApp":"codex"}'), canonicalArguments(args));
    record(ID);
    record('99999999-2222-3333-4444-555555555555', Date.now() - 60000);
    assert.deepEqual(consumeBinding(directory, 'bridge_send', args), {conversationId: ID, toolCallId: undefined});
    assert.equal(consumeBinding(directory, 'bridge_send', args), null, 'records are consumed once and expired ones removed');
    assert.deepEqual(fs.readdirSync(directory), []);
    record(ID); record('99999999-2222-3333-4444-555555555555');
    assert.deepEqual(consumeBinding(directory, 'bridge_send', args), {ambiguous: true});
    // The installed hook runs from the plugin folder with its own config.
    const plugin = temp('agy-plugin-');
    for (const name of ['antigravity-hook.mjs', 'antigravity-binding.mjs']) fs.copyFileSync(fileURLToPath(projectURL(name)), path.join(plugin, name));
    const run = (cwd, payload) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(cwd, 'antigravity-hook.mjs')], {cwd, windowsHide: true});
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(output))); child.stdin.end(payload);
    });
    const payload = JSON.stringify({conversationId: ID, toolCall: {id: 'call_1', name: 'call_mcp_tool', args: {ServerName: 'desktop-agent-bridge_desktop-bridge', ToolName: 'bridge_self', Arguments: {}}}});
    assert.deepEqual(await run(plugin, payload), {decision: 'ask'}, 'missing config still yields a decision');
    assert.deepEqual(await run(plugin, 'not json'), {decision: 'ask'});
    const bindings = path.join(plugin, 'bindings');
    write(path.join(plugin, 'hook-config.json'), {bindingsDirectory: bindings});
    assert.deepEqual(await run(plugin, payload), {decision: 'ask'});
    assert.deepEqual(consumeBinding(bindings, 'bridge_self', {}), {conversationId: ID, toolCallId: 'call_1'});
    await run(plugin, payload.replace('desktop-agent-bridge_desktop-bridge', 'other_server'));
    assert.equal(fs.readdirSync(bindings).length, 0, 'other MCP servers are not recorded');
    fs.rmSync(plugin, {recursive: true, force: true});
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('Antigravity identity comes from tools/call _meta and only verified evidence carries delegation', async () => {
  const child = spawn(process.execPath, [fileURLToPath(projectURL('peer-client.mjs'))], {windowsHide: true});
  let output = ''; child.stdout.on('data', data => { output += data; });
  const meta = {'antigravity.google/conversation_id': ID, 'antigravity.google/root_conversation_id': ID};
  child.stdin.end([
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', clientInfo: {name: 'antigravity-client', version: 'v1.0.0'}, capabilities: {}}},
    {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'bridge_self', arguments: {}, _meta: meta}},
    {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'bridge_self', arguments: {fromThreadId: 'another'}, _meta: meta}},
  ].map(JSON.stringify).join('\n') + '\n');
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const results = output.trim().split('\n').map(JSON.parse);
  const self = JSON.parse(results.find(row => row.id === 2).result.content[0].text);
  assert.equal(self.app, 'antigravity'); assert.equal(self.threadId, ID); assert.equal(self.evidence, 'MCP-call-metadata');
  assert.equal(results.find(row => row.id === 3).result.isError, true);
  assert.equal(verifiedPeer({app: 'antigravity', threadId: ID, identityEvidence: 'MCP-call-metadata'}), true);
  assert.equal(verifiedPeer({app: 'antigravity', threadId: ID, identityEvidence: 'antigravity-pretooluse-hook'}), true);
  assert.equal(verifiedPeer({app: 'antigravity', threadId: ID, identityEvidence: 'explicit-current-thread'}), false);
  const key = `mcp-create:antigravity:${ID}:r1`;
  assert.deepEqual(creationOrigin(`[bridge {"kind":"task_creation","from":"antigravity:${ID}","requestId":"r1"}]\nbody`, key), {app: 'antigravity', threadId: ID});
});

test('router queues messages for a closed Antigravity desktop and delivers them once the hub is back', async () => {
  const {PeerRouter} = await import('../../src/mcp/peer-router.mjs');
  const directory = temp('agy-router-');
  let running = false; const sends = [];
  const backendRequest = async (app, route, method, body) => {
    if (route.endsWith('/settings')) return {settings: {}};
    if (method === 'POST') {
      if (app === 'antigravity' && !running) throw Object.assign(new Error('Antigravity is not running'), {status: 503, code: 'APP_NOT_RUNNING', dispatchNotStarted: true});
      sends.push({app, route, body}); return {id: 'task-1', status: 'completed', completionEvidence: 'native-input-accepted'};
    }
    if (route.startsWith('/v1/tasks/')) return {status: 'completed', completionEvidence: 'native-input-accepted'};
    if (route === '/health') return {ok: true, transport: app};
    return {thread: {status: {type: 'idle'}}, turns: [], threads: []};
  };
  const router = new PeerRouter({directory, backendRequest, pollMs: 1e9, delegationPath: path.join(directory, 'none.json')});
  try {
    const message = await router.send({from: {app: 'codex', threadId: 'c'}, to: {app: 'antigravity', threadId: ID}, text: 'hello antigravity'});
    await router.tick();
    assert.equal(router.delivery(message).stage, 'waiting_for_connection');
    assert.equal(sends.length, 0);
    running = true; await router.tick();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].route, `/v1/threads/${ID}/messages`);
    assert.equal(router.delivery(router.state.messages[message.id]).stage, 'delivered');
    assert.throws(() => router.prepareMessage({from: {app: 'antigravity', threadId: ID}, to: {app: 'gemini', threadId: 'x'}, text: 'x'}, 'message'), /antigravity/);
    const health = await router.health('all');
    assert.ok(health.results.some(row => row.app === 'antigravity'));
  } finally { router.close(); fs.rmSync(directory, {recursive: true, force: true}); }
});
