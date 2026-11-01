import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { EFFORTS } from '../core/contracts.mjs';
import {publicResult,errorData} from '../core/collaboration.mjs';

const argv = process.argv.slice(2);
const getFlag = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const connectionFile = getFlag('connection') ?? getFlag('credentials');
if (!connectionFile) throw new Error('Pass --connection connection.json or --credentials callback-*.json');
const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
const provider = connection.backend ?? 'codex';
const scoped = !connection.baseUrl;
const baseUrl = connection.baseUrl ?? new URL(connection.url).origin;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('Expected a loopback bridge URL');

async function request(route, method = 'GET', data) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error??JSON.stringify(result)),{status:response.status,code:result.code});
  return publicResult(result);
}

const executionProperties = { model: { type: 'string' }, effort: { type: 'string', enum: [...EFFORTS,'median'] }, projectId: { type: 'string' },cwd:{type:'string'},taskVersion:{type:'string'}, environment: { type: 'object', properties: { type: { const: 'local' } }, additionalProperties: false }, target: { type: 'object' } };
if (provider === 'deepseek') executionProperties.workspaceId = { type: 'string', description: 'Native DeepSeek Workspace ID; alias of projectId. Choose the workspace before creating a new session.' };
const modelProperties = { model: executionProperties.model, effort: executionProperties.effort };
if(provider==='codex')Object.assign(executionProperties,{writableRoots:{type:'array',items:{type:'string'}},sandboxMode:{type:'string',enum:['workspace-write','read-only','danger-full-access']},approvalPolicy:{type:'string',enum:['on-request','untrusted','never','on-failure']}});
const listProperties = { limit: { type: 'integer', minimum: 1, maximum: 50 }, projectId: { type: 'string' }, hostId: { type: 'string' }, status: { type: 'string' }, q: { type: 'string' }, kind: { type: 'string', enum: ['codex', 'claude', 'deepseek', 'chatgpt', 'all'] } };
const tools = [
  { name: 'bridge_send', description: 'Proactively send progress, findings or blockers from this Codex session to its external bridge. Does not message any other chat.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['message', 'progress', 'finding', 'blocker'] }, messageId: { type: 'string' }, replyTo: { type: 'string' }, threadId: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'bridge_decision', description: 'Ask the external task owner for a decision. Once accepted, finish the current turn and wait. The answer wakes this same chat; do not poll or guess the answer.', inputSchema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 }, recommendation: { type: 'string' }, context: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' } }, required: ['question', 'options'], additionalProperties: false } },
  ...scoped ? [] : [
    { name: 'codex_threads', description: 'List desktop threads and status. Filter by project, host, status or title text. Filters apply to the recent native window and all pinned threads.', inputSchema: { type: 'object', properties: listProperties, additionalProperties: false } },
    { name: 'codex_sessions', description: 'Alias of codex_threads.', inputSchema: { type: 'object', properties: listProperties, additionalProperties: false } },
    { name: 'codex_projects', description: 'List saved desktop projects for session creation.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'codex_models', description: 'Read the current native desktop model catalog.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'codex_capabilities', description: 'Read execution capabilities and supported efforts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'codex_read', description: 'Read recent messages and status of a desktop session.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, hostId: { type: 'string' } }, required: ['threadId'], additionalProperties: false } },
    { name: 'codex_create_task', description: 'Create a tracked task, optionally in an existing desktop thread. New threads can specify projectId/environment or target, model and effort. Automatically provides outbound messaging and decision instructions. Only use with user authorization.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, title: { type: 'string' }, threadId: { type: 'string' }, hostId: { type: 'string' }, ...executionProperties }, required: ['prompt'], additionalProperties: false } },
    { name: 'codex_send', description: 'Send a prompt to an existing desktop thread, including an idle or unloaded chat. Optional model/effort override. Only use with user authorization.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' }, hostId: { type: 'string' }, ...modelProperties }, required: ['threadId', 'prompt'], additionalProperties: false } },
    { name: 'codex_wake', description: 'Wake an idle/unloaded desktop thread by sending a continuation prompt. This starts a new model turn. Optional model/effort; active sessions are rejected.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' }, hostId: { type: 'string' }, ...modelProperties }, required: ['threadId'], additionalProperties: false } },
    { name: 'codex_settings', description: 'Read the desktop thread\'s actual model and reasoning effort through native IPC.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, hostId: { type: 'string' } }, required: ['threadId'], additionalProperties: false } },
    ...provider==='codex'?[{name:'codex_set_permissions',description:'Set explicit next-turn permissions for an idle managed Codex chat. Full access: danger-full-access / never. Rejects active and approval-waiting chats; never answers prompts.',inputSchema:{type:'object',properties:{threadId:{type:'string'},sandboxMode:executionProperties.sandboxMode,approvalPolicy:executionProperties.approvalPolicy,writableRoots:executionProperties.writableRoots},required:['threadId','sandboxMode'],additionalProperties:false}}]:[],
    { name: 'codex_decisions', description: 'List decision requests raised by Codex sessions. Defaults to pending requests.', inputSchema: { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false } },
    { name: 'codex_respond_decision', description: 'Answer a pending decision and wake the same thread to continue. Requires external human authorization for the answer; never use an answer to bypass a permission prompt.', inputSchema: { type: 'object', properties: { decisionId: { type: 'string' }, answer: { type: 'string' }, ...modelProperties }, required: ['decisionId', 'answer'], additionalProperties: false } },
    { name: 'codex_watch', description: 'Subscribe to a desktop session and issue its scoped outbound callback credentials.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, hostId: { type: 'string' } }, required: ['threadId'], additionalProperties: false } },
    { name: 'codex_task', description: 'Read status and result of a tracked bridge task.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
    { name: 'codex_events', description: 'Receive Codex replies, task completion and explicit outbound messages after an event cursor. Save the returned cursor for the next call.', inputSchema: { type: 'object', properties: { after: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
  ],
];

async function call(name, args = {}) {
  if (provider !== 'codex') name = name.replace(new RegExp(`^${provider}_`), 'codex_');
  if (!tools.some(tool => tool.name === name)) throw new Error('Unknown tool');
  switch (name) {
    case 'bridge_send':
    case 'bridge_decision': return request('/v1/inbox', 'POST', { ...args, kind: name === 'bridge_decision' ? 'decision' : args.kind, taskId: connection.taskId, threadId: connection.threadId ?? args.threadId, messageId: args.messageId ?? crypto.randomUUID() });
    case 'codex_sessions':
    case 'codex_threads': return request(`/v1/threads?${new URLSearchParams(Object.entries(args).filter(([, value]) => value !== undefined))}`);
    case 'codex_projects': return request('/v1/projects');
    case 'codex_models':return request('/v1/models');
    case 'codex_capabilities':return request('/v1/capabilities');
    case 'codex_read': return request(`/v1/sessions/${encodeURIComponent(args.threadId)}?hostId=${encodeURIComponent(args.hostId ?? 'local')}`);
    case 'codex_create_task': return request('/v1/tasks', 'POST', args);
    case 'codex_send': return request(`/v1/threads/${encodeURIComponent(args.threadId)}/messages`, 'POST', { prompt: args.prompt, hostId: args.hostId, model: args.model, effort: args.effort });
    case 'codex_wake': return request(`/v1/threads/${encodeURIComponent(args.threadId)}/wake`, 'POST', { prompt: args.prompt, hostId: args.hostId, model: args.model, effort: args.effort });
    case 'codex_settings': return request(`/v1/threads/${encodeURIComponent(args.threadId)}/settings?hostId=${encodeURIComponent(args.hostId ?? 'local')}`);
    case 'codex_set_permissions':return request(`/v1/threads/${encodeURIComponent(args.threadId)}/permissions`,'POST',Object.fromEntries(['sandboxMode','approvalPolicy','writableRoots'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]])));
    case 'codex_decisions': return request(`/v1/decisions?status=${encodeURIComponent(args.status ?? 'pending')}`);
    case 'codex_respond_decision': return request(`/v1/decisions/${encodeURIComponent(args.decisionId)}/respond`, 'POST', { answer: args.answer, model: args.model, effort: args.effort });
    case 'codex_watch': return request(`/v1/sessions/${encodeURIComponent(args.threadId)}/watch`, 'POST', { hostId: args.hostId });
    case 'codex_task': return request(`/v1/tasks/${encodeURIComponent(args.taskId)}`);
    case 'codex_events': return request(`/v1/events?after=${args.after ?? 0}`);
  }
}

if (argv.includes('--mcp')) {
  const lines = readline.createInterface({ input: process.stdin });
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  lines.on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!Object.hasOwn(message, 'id')) return;
    const id = message.id;
    try {
      let result;
      switch (message.method) {
        case 'initialize': result = { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `${provider}-gui-bridge`, version: '0.8.1' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: provider !== 'codex' ? tools.map(tool => ({ ...tool, name: tool.name.replace(/^codex_/, `${provider}_`), description: tool.description.replaceAll('Codex', provider === 'claude' ? 'Claude' : 'DeepSeek').replaceAll('codex_', `${provider}_`) })) : tools }; break;
        case 'tools/call': {
          try { result = { content: [{ type: 'text', text: JSON.stringify(await call(message.params.name, message.params.arguments)) }] }; }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: JSON.stringify({error:errorData(error)}) }] }; }
          break;
        }
        default: send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      send({ jsonrpc: '2.0', id, result });
    } catch (error) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } }); }
  });
} else {
  const name = getFlag('tool') ?? 'bridge_send';
  const args = getFlag('args-file') ? JSON.parse(fs.readFileSync(getFlag('args-file'), 'utf8').replace(/^\uFEFF/, '')) : getFlag('args') ? JSON.parse(getFlag('args')) : { text: getFlag('text'), messageId: getFlag('message-id') };
  try { console.log(JSON.stringify(await call(name, args))); }
  catch (error) { console.error(JSON.stringify({error:errorData(error)})); process.exitCode = 1; }
}
