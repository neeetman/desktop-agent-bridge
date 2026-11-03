import {projectURL} from "../lib/paths.mjs";
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DesktopTools, PipeRpc } from '../adapters/codex/native.mjs';
import { normalizeExecution, nativeModelArgs, queryThreads, EFFORTS, canonicalJson } from './contracts.mjs';
import { Signals } from './signals.mjs';
import {publicResult,errorData} from './collaboration.mjs';
import {coordinator} from '../compat/compatibility.mjs';

const terminal = new Set(['completed', 'failed', 'interrupted', 'attention']);
const active = new Set(['prepared', 'dispatching', 'running', 'unknown', 'awaiting_decision', 'resuming']);
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(publicResult(value))); };
const fail = (status, message) => Object.assign(new Error(message), { status });
const nonempty = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw fail(400, `${field} must be nonempty`); return value; };
const same = (a, b) => { const x = Buffer.from(a ?? ''), y = Buffer.from(b ?? ''); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function reportTask(task){
  if(!task.cachedResult||!['failed','unknown'].includes(task.status))return task;
  return {...task,code:task.status==='unknown'?'CACHED_TASK_OUTCOME_UNKNOWN':'CACHED_TASK_FAILURE',httpStatus:409,originalError:task.error,error:`Stored ${task.status} result for task ${task.id}, created at ${task.createdAt}. This request was not executed again. Inspect the original outcome before using a new idempotency key. Original error: ${task.error??'unavailable'}`,retrySafe:task.dispatchOutcome==='not-started'};
}

function writeJson(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function body(req) {
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw fail(413, 'Request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw fail(400, 'Invalid JSON'); }
}

export async function startBridge({ tools, stateDir, port = 43127, pollMs = 3000, enableIpc = true, preflight }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
    schemaVersion: 1, token: crypto.randomBytes(32).toString('hex'), tasks: {}, watches: {}, idempotency: {},
  };
  const save = () => writeJson(stateFile, state);
  if (preflight) {
    // Compatibility bindings need credentials before the first native probe.
    // Do not publish a PID/address until the service has actually started.
    save();
    writeJson(path.join(stateDir, 'connection.json'), { token: state.token, initializing: true });
    try { await preflight(); } catch (error) { tools.close(); throw error; }
  }
  state.provider = tools.provider ?? 'codex';
  // A crash during native dispatch must never lead to an automatic duplicate send.
  for (const task of Object.values(state.tasks)) if (['prepared', 'dispatching'].includes(task.status)) task.status = 'unknown';
  save();
  const journal = path.join(stateDir, 'events.jsonl');
  const events = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  let nextEvent = (events.at(-1)?.id ?? 0) + 1;
  const streams = new Set();
  const emit = (type, data) => {
    const event = { id: nextEvent++, time: new Date().toISOString(), type, ...data };
    fs.appendFileSync(journal, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    events.push(event);
    for (const stream of streams) if (!stream.write(`id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`)) stream.destroy();
    return event;
  };
  const callbackToken = threadId => crypto.createHmac('sha256', state.token).update(`callback:${threadId}`).digest('hex');
  let baseUrl;
  const signals = new Signals({ state, stateDir, save, emit, getBaseUrl: () => baseUrl });
  for (const decision of Object.values(state.decisions)) {
    if (decision.status !== 'resolving') continue;
    const continuation = state.tasks[state.idempotency[`decision:${decision.id}`]?.taskId];
    decision.status = continuation ? ['unknown', 'failed'].includes(continuation.status) ? 'resume_unknown' : 'answered' : 'pending';
    if (continuation) decision.continuationTaskId = continuation.id;
    const parent = state.tasks[decision.taskId];
    if (parent) {
      parent.status = continuation ? decision.status === 'resume_unknown' ? 'unknown' : 'resumed' : 'awaiting_decision';
      if (!continuation) parent.pendingDecisionId = decision.id;
    }
  }
  save();
  function callback(threadId) {
    const value = { url: `${baseUrl}/v1/inbox`, threadId, token: callbackToken(threadId) };
    const file = path.join(stateDir, `callback-${crypto.createHash('sha256').update(threadId).digest('hex').slice(0, 24)}.json`);
    writeJson(file, value);
    return { ...value, credentialsFile: file };
  }
  function watch(threadId, hostId = 'local') {
    nonempty(threadId, 'threadId');
    const key = `${hostId}:${threadId}`;
    state.watches[key] ??= { threadId, hostId, seen: {}, lastStatus: null };
    save();
    return { ...state.watches[key], callback: callback(threadId) };
  }
  const refreshing = new Set();
  async function refresh(watchState) {
    const key = `${watchState.hostId}:${watchState.threadId}`;
    if (refreshing.has(key)) return;
    refreshing.add(key);
    try {
      const snapshot = await tools.call('read_thread', { threadId: watchState.threadId, hostId: watchState.hostId, turnLimit: 10, maxOutputCharsPerItem: 20000 });
      if(tools.readTrackedTurn){
        const ids=new Set((snapshot.turns??[]).map(turn=>turn.id));
        for(const task of Object.values(state.tasks)){
          if(task.threadId!==watchState.threadId||task.hostId!==watchState.hostId||!['running','awaiting_decision'].includes(task.status)||!task.turnId||ids.has(task.turnId)||Date.now()-(task.historyLookupAt??0)<30000)continue;
          task.historyLookupAt=Date.now();const turn=await tools.readTrackedTurn(task.threadId,task.turnId);
          if(turn?.id===task.turnId){snapshot.turns??=[];snapshot.turns.push(turn);ids.add(turn.id);}
        }
      }
      const status = snapshot.thread?.status;
      if (JSON.stringify(status) !== JSON.stringify(watchState.lastStatus)) {
        watchState.lastStatus = status;
        emit('session.status', { threadId: watchState.threadId, hostId: watchState.hostId, status });
      }
      for (const turn of [...(snapshot.turns ?? [])].reverse()) {
        for (const item of turn.items ?? []) {
          if (item.type !== 'agentMessage' || !item.text) continue;
          const fingerprint = crypto.createHash('sha256').update(JSON.stringify([item.text, item.phase])).digest('hex');
          const itemKey = `${turn.id}:${item.id}`;
          if (watchState.seen[itemKey] !== fingerprint) {
            watchState.seen[itemKey] = fingerprint;
            emit('session.message', { threadId: watchState.threadId, hostId: watchState.hostId, turnId: turn.id, itemId: item.id, text: item.text, phase: item.phase });
          }
        }
        for (const task of Object.values(state.tasks)) {
          if (task.threadId !== watchState.threadId || task.hostId !== watchState.hostId || !['running', 'awaiting_decision'].includes(task.status)) continue;
          // The native send result contains no turn ID. Correlate the next turn against
          // the baseline captured before dispatch. Concurrent human input is detectable
          // only by inspection, so serialize bridge tasks for a given thread.
          if (!task.turnId && !(task.baselineTurnIds ?? []).includes(turn.id)) task.turnId = turn.id;
          if (task.turnId !== turn.id) continue;
          if (task.operation === 'wake' && !task.wakeConfirmedAt) {
            task.wakeConfirmedAt = new Date().toISOString();
            emit('session.awakened', { threadId: task.threadId, taskId: task.id, turnId: turn.id, previousStatus: task.previousStatus });
          }
          if (terminal.has(turn.status)) {
            task.lastTurnStatus = turn.status;
            if(turn.completionEvidence)task.completionEvidence=turn.completionEvidence;
            task.status = task.pendingDecisionId ? 'awaiting_decision' : turn.status;
            task.turnCompletedAt = new Date().toISOString();
            if (!task.pendingDecisionId) task.completedAt = task.turnCompletedAt;
            task.result = (turn.items ?? []).filter(x => x.type === 'agentMessage' && x.phase === 'final_answer').map(x => x.text).join('\n');
            task.error = turn.error;
            if (!task.turnFinishedEmitted) {
              emit(task.pendingDecisionId ? 'task.awaiting_decision' : 'task.completed', { taskId: task.id, threadId: task.threadId, status: task.status, result: task.result, error: task.error });
              task.turnFinishedEmitted = true;
              if (!task.pendingDecisionId) {
                let parent = state.tasks[task.resumesTaskId];
                while (parent) {
                  parent.status = task.status; parent.result = task.result; parent.completedAt = task.completedAt;
                  emit('task.completed', { taskId: parent.id, threadId: parent.threadId, status: parent.status, result: parent.result, continuationTaskId: task.id });
                  parent = state.tasks[parent.resumesTaskId];
                }
              }
            }
          }
        }
      }
      if (watchState.lastError) { delete watchState.lastError; emit('session.connection_restored', { threadId: watchState.threadId }); }
      save();
    } catch (error) {
      if (watchState.lastError !== error.message) {
        watchState.lastError = error.message;
        emit('session.read_error', { threadId: watchState.threadId, error: error.message });
        save();
      }
    } finally { refreshing.delete(key); }
  }

  const dispatching = new Map();
  async function dispatch(input, idempotencyKey, internal = {}) {
    let execution = normalizeExecution(input, { allowWorkspace: tools.provider === 'deepseek',allowExecutionPolicy:!tools.provider||tools.provider==='codex' });
    nonempty(input.prompt, 'prompt');
    const fingerprint = crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
    if (idempotencyKey && state.idempotency[idempotencyKey]) {
      const record = state.idempotency[idempotencyKey];
      const expected = record.fingerprintVersion === 2 ? fingerprint : crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (record.fingerprint !== expected) throw fail(409, 'Idempotency-Key already used with a different request');
      if (record.fingerprintVersion !== 2) { record.fingerprintVersion = 2; record.fingerprint = fingerprint; save(); }
      if (dispatching.has(record.taskId)) await dispatching.get(record.taskId);
      return {...state.tasks[record.taskId],cachedResult:true};
    }
    if(tools.preflightDispatch)await tools.preflightDispatch(input);
    if(tools.prepareExecution)execution=await tools.prepareExecution(execution,{threadId:input.threadId});
    else if(execution.cwd)throw fail(400, 'This backend cannot safely create a session at an arbitrary cwd');
    // Another identical caller may have reserved its task during asynchronous preflight.
    if(idempotencyKey&&state.idempotency[idempotencyKey])return dispatch(input,idempotencyKey,internal);
    if(input.peerNotification===true&&input.callbackMode==='peer'&&input.threadId){
      const pending=Object.values(state.tasks).filter(t=>t.threadId===input.threadId&&t.hostId===(input.hostId??'local')&&active.has(t.status));
      if(pending.length===1&&pending[0].status==='awaiting_decision'&&state.decisions[pending[0].pendingDecisionId]?.status==='pending')internal={...internal,pausedTaskId:pending[0].id,operation:'peer_notification'};
    }
    if (input.threadId && Object.values(state.tasks).some(task => task.threadId === input.threadId && task.hostId === (input.hostId ?? 'local') && active.has(task.status) && task.id !== internal.resumesTaskId && task.id !== internal.pausedTaskId)) throw fail(409, 'A bridge task is already pending for this session');
    const task = { id: crypto.randomUUID(), status: 'prepared', operation: internal.operation ?? 'task', resumesTaskId: internal.resumesTaskId, pausedTaskId:internal.pausedTaskId, createdAt: new Date().toISOString(), hostId: input.hostId ?? 'local', threadId: input.threadId ?? null, baselineTurnIds: [], prompt: input.prompt, execution, callbackMode:input.callbackMode==='peer'?'peer':'external', taskVersion:input.taskVersion??null };
    state.tasks[task.id] = task;
    if (idempotencyKey) state.idempotency[idempotencyKey] = { taskId: task.id, fingerprint, fingerprintVersion: 2 };
    save();
    const operation = (async () => {
      try {
        if (task.threadId) {
          const snapshot = await tools.call('read_thread', { threadId: task.threadId, hostId: task.hostId, turnLimit: 10 });
          task.baselineTurnIds = (snapshot.turns ?? []).map(turn => turn.id);
          task.previousStatus = snapshot.thread?.status;
          if(task.pausedTaskId&&(snapshot.thread?.status?.type==='active'||snapshot.turns?.[0]?.status==='inProgress'))throw Object.assign(new Error('Session is active; the notification must wait'),{dispatchNotStarted:true});
          if (task.operation === 'wake' && task.previousStatus?.type === 'active') throw new Error('Session is already active; use messages to queue work after its current task');
        }
        task.status = 'dispatching'; save();
        const prompt = `${input.prompt}\n\n${signals.instructions(task)}`;
        let result;
        if (task.threadId) {
          result = await tools.call('send_message_to_thread', { threadId: task.threadId, hostId: task.hostId, prompt, ...nativeModelArgs(execution) });
        } else {
          result = await tools.call('create_thread', { title: input.title, prompt, target: execution.target, ...nativeModelArgs(execution),...execution.executionPolicy?{executionPolicy:execution.executionPolicy,cwd:execution.cwd,requestId:task.id}:{} });
          if (!result.threadId) throw new Error('Desktop returned no threadId; creation outcome unknown');
          task.threadId = result.threadId; task.hostId = result.hostId ?? 'local';
          task.creation = result;
        }
        if (result.isError || result.error) throw new Error(JSON.stringify(result));
        task.nativeResult = result;
        task.status = task.pendingDecisionId ? 'awaiting_decision' : 'running'; task.dispatchedAt = new Date().toISOString();
        signals.bindTask(task);
        watch(task.threadId, task.hostId);
        if (tools.readSettings) {
          try { task.effectiveSettings = (await tools.readSettings(task.threadId, task.hostId)).settings;if(task.effectiveSettings.executionSource)for(const key of ['sandboxMode','writableRoots','approvalPolicy'])task[key]=task.effectiveSettings[key]; }
          catch (error) { task.settingsReadError = error.message; }
        }
        emit('task.dispatched', { taskId: task.id, threadId: task.threadId, hostId: task.hostId });
        save();
      } catch (error) {
        if(error.createdThreadId&&!task.threadId)task.threadId=error.createdThreadId;
        task.status = task.status === 'dispatching'&&!error.dispatchNotStarted ? 'unknown' : 'failed';
        if(error.dispatchNotStarted)task.dispatchOutcome='not-started';
        task.errorCode=error.code;task.errorStatus=error.status;
        task.error = error.message; save();
        emit('task.dispatch_error', { taskId: task.id, threadId: task.threadId, status: task.status, error: error.message });
      }
    })();
    dispatching.set(task.id, operation);
    try { await operation; } finally { dispatching.delete(task.id); }
    return task;
  }

  const resolutions = new Map();
  async function resolveDecision(decisionId, input) {
    const current = resolutions.get(decisionId);
    if (current) {
      if (current.answer !== input.answer) throw fail(409, 'Decision is being answered differently');
      if(current.peerDecisionId!==input.peerDecisionId||current.context!==input.context)throw fail(409,'Decision continuation context differs from the in-flight resolution');
      return current.promise;
    }
    const promise = resolveDecisionImpl(decisionId, input);
    resolutions.set(decisionId, { answer: input.answer, peerDecisionId:input.peerDecisionId, context:input.context, promise });
    try { return await promise; } finally { resolutions.delete(decisionId); }
  }
  async function resolveDecisionImpl(decisionId, input) {
    const decision = state.decisions[decisionId];
    if (!decision) throw fail(404, 'Unknown decision');
    nonempty(input.answer, 'answer');
    if(input.peerDecisionId){nonempty(input.peerDecisionId,'peerDecisionId');nonempty(input.context,'context');}
    if (decision.status !== 'pending') {
      if (decision.answer !== input.answer) throw fail(409, 'Decision has already been answered differently');
      if(input.peerDecisionId&&decision.peerDecisionId!==input.peerDecisionId)throw fail(409,'Decision was resumed by a different peer decision');
      if(input.peerDecisionId&&decision.answerContext!==input.context)throw fail(409,'Decision continuation context differs from the stored resolution');
      return { decision, continuation: state.tasks[decision.continuationTaskId] ?? null };
    }
    const parent = state.tasks[decision.taskId];
    const threadId = decision.threadId ?? parent?.threadId;
    if (!threadId) throw fail(409, 'Session creation is still in progress');
    const hostId = parent?.hostId ?? input.hostId ?? 'local';
    const snapshot = await tools.call('read_thread', { threadId, hostId, turnLimit: 1 });
    if (snapshot.thread?.status?.type === 'active' || snapshot.turns?.[0]?.status === 'inProgress') throw fail(409, 'Decision was recorded; wait for the reporting turn to finish before answering');
    // Persist resolution before dispatch. The stable internal idempotency key prevents
    // a retry from generating a second continuation after transport uncertainty.
    decision.status = 'resolving'; decision.answer = input.answer; decision.answeredAt = new Date().toISOString();
    if(input.peerDecisionId){decision.peerDecisionId=nonempty(input.peerDecisionId,'peerDecisionId');decision.answerContext=input.context??null;}
    if (parent) { parent.status = 'resuming'; delete parent.pendingDecisionId; }
    save();
    let continuation;
    try {
      continuation = await dispatch({ threadId, hostId, prompt: input.peerDecisionId?nonempty(input.context,'context'):`已选择「${input.answer}」，请继续原任务。`,callbackMode:input.callbackMode,
        model: input.model ?? parent?.execution?.model, effort: input.effort ?? input.thinking ?? parent?.execution?.effort }, `decision:${decision.id}`, { resumesTaskId: parent?.id, operation: 'decision_resume' });
    } catch (error) {
      decision.status = 'pending'; if (parent) { parent.status = 'awaiting_decision'; parent.pendingDecisionId = decision.id; }
      save(); throw error;
    }
    decision.continuationTaskId = continuation.id;
    decision.status = ['unknown', 'failed'].includes(continuation.status) ? 'resume_unknown' : 'answered';
    if (parent) { parent.continuationTaskId = continuation.id; parent.status = ['unknown', 'failed'].includes(continuation.status) ? 'unknown' : 'resumed'; }
    emit('decision.answered', { decisionId, threadId, taskId: parent?.id ?? null, answer: decision.answer, continuationTaskId: continuation.id, status: decision.status });
    save();
    return { decision, continuation };
  }

  const server = http.createServer(async (req, res) => {
    try {
      // No browser-origin access or CORS: this is an authenticated local agent API.
      if (req.headers.origin) throw fail(403, 'Browser-origin requests are not accepted');
      const url = new URL(req.url, 'http://localhost');
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const root = same(token, state.token);
      if (!root && !(req.method === 'POST' && url.pathname === '/v1/inbox')) throw fail(401, 'Bearer token required');
      if (req.method === 'POST' && url.pathname === '/v1/inbox') {
        const data = await body(req);
        return json(res, 202, signals.receive(data, token, root));
      }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: '0.8.4', backend: state.provider, transport: tools.transport ?? 'codex-desktop-native-pipe', callerThread: tools.callerThread });
      if (req.method === 'GET' && url.pathname === '/v1/compatibility') return json(res,200,await coordinator.doctor(state.provider==='claude'?'claude':'codex'));
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') return json(res, 200, { version: '0.8.4', executionFields: ['projectId', ...tools.provider === 'deepseek' ? ['workspaceId'] : [], 'environment', 'target', 'model', 'effort',...tools.prepareExecution?['cwd']:[],'taskVersion',...tools.executionCapabilities?['writableRoots','sandboxMode','approvalPolicy']:[]], effortValues: tools.effortValues ?? EFFORTS,effortAliases:{median:'medium'},models:tools.listModels?'/v1/models':null,cwdPolicy:tools.prepareExecution?'registered-project-or-verified-git-worktree':'native-project-only',...tools.executionCapabilities?tools.executionCapabilities():{},callbackSecrets:'credentialsFile-only', wake: ['idle', 'notLoaded'], outbound: ['message', 'progress', 'finding', 'blocker', 'decision'], autoInjectCallback: true });
      if (tools.provider === 'deepseek' && url.pathname === '/v1/workspaces') {
        if (req.method === 'GET') return json(res, 200, await tools.call('list_workspaces', {}));
        if (req.method === 'POST') { const input = await body(req); nonempty(input.path, 'path'); const result = await tools.call('create_workspace', input); return json(res, result.created ? 201 : 200, result); }
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects') return json(res, 200, await tools.call('list_projects', {}));
      if (req.method === 'GET' && url.pathname === '/v1/models') {if(!tools.listModels)throw fail(501,'Native model catalog unavailable for this backend');return json(res,200,await tools.listModels());}
      if (req.method === 'GET' && ['/v1/sessions', '/v1/threads'].includes(url.pathname)) {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw fail(400, 'limit must be 1-50');
        return json(res, 200, queryThreads(await tools.call('list_threads', { limit }), url.searchParams));
      }
      if (req.method === 'GET' && url.pathname === '/v1/threads/archived') return json(res, 200, await tools.call('list_archived_threads', { source: 'codex', limit: Number(url.searchParams.get('limit') ?? 50), cursor: url.searchParams.get('cursor') ?? undefined, hostId: url.searchParams.get('hostId') ?? undefined }));
      if (req.method === 'GET' && url.pathname === '/v1/decisions') return json(res, 200, { decisions: Object.values(state.decisions).filter(item => !url.searchParams.has('status') || item.status === url.searchParams.get('status')) });
      const decisionRoute = url.pathname.match(/^\/v1\/decisions\/([^/]+)(?:\/(respond))?$/);
      if (decisionRoute) {
        if (req.method === 'GET' && !decisionRoute[2]) { const decision = state.decisions[decisionRoute[1]]; if (!decision) throw fail(404, 'Unknown decision'); return json(res, 200, decision); }
        if (req.method === 'POST' && decisionRoute[2] === 'respond') return json(res, 202, await resolveDecision(decisionRoute[1], await body(req)));
      }
      if (req.method === 'POST' && ['/v1/sessions', '/v1/threads', '/v1/tasks'].includes(url.pathname)) {
        const input = await body(req);
        if (url.pathname !== '/v1/tasks' && input.threadId) throw fail(400, 'Session creation cannot include threadId');
        const task = reportTask(await dispatch(input, req.headers['idempotency-key']));
        return json(res, task.httpStatus??(task.status === 'unknown' ? 502 : task.status === 'failed' ? task.errorStatus??400 : 202), { ...task, callback: task.threadId ? callback(task.threadId) : null, taskCallback: signals.taskCallback(task) });
      }
      const session = url.pathname.match(/^\/v1\/(?:sessions|threads)\/([^/]+)(?:\/(messages|watch|wake|settings|permissions))?$/);
      if (session) {
        const threadId = decodeURIComponent(session[1]);
        if(req.method==='POST'&&session[2]==='permissions'){
          if(!tools.setPermissions)throw fail(400,'Permission updates are only supported for managed Codex threads');
          const input=await body(req);if(!input.sandboxMode||Object.keys(input).some(key=>!['sandboxMode','approvalPolicy','writableRoots'].includes(key)))throw fail(400,'Explicit sandboxMode and permission fields only are required');
          return json(res,200,await tools.setPermissions(threadId,input));
        }
        if (req.method === 'GET' && session[2] === 'settings') {
          if (!tools.readSettings) throw fail(501, 'Settings IPC unavailable');
          return json(res, 200, await tools.readSettings(threadId, url.searchParams.get('hostId') ?? 'local'));
        }
        if (req.method === 'GET' && !session[2]) return json(res, 200, await tools.call('read_thread', { threadId, hostId: url.searchParams.get('hostId') ?? 'local', turnLimit: 10, maxOutputCharsPerItem: 20000 }));
        if (req.method === 'POST' && session[2] === 'watch') {
          const input = await body(req); return json(res, 200, watch(threadId, input.hostId));
        }
        if (req.method === 'POST' && session[2] === 'messages') {
          const input = await body(req); const task = reportTask(await dispatch({ ...input, threadId }, req.headers['idempotency-key']));
          return json(res, task.httpStatus??(task.status === 'unknown' ? 502 : task.status === 'failed' ? task.errorStatus??400 : 202), task);
        }
        if (req.method === 'POST' && session[2] === 'wake') {
          const input = await body(req);
          const task = reportTask(await dispatch({ ...input, threadId, prompt: input.prompt ?? '请恢复当前任务；先检查之前的进展与阻塞，再在原有授权范围内继续。' }, req.headers['idempotency-key'], { operation: 'wake' }));
          emit('session.wake_requested', { threadId, taskId: task.id, status: task.status });
          return json(res, task.httpStatus??(['failed', 'unknown'].includes(task.status) ? 409 : 202), task);
        }
      }
      if (req.method === 'GET' && url.pathname === '/v1/tasks') return json(res, 200, { tasks: Object.values(state.tasks) });
      const taskRoute = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && taskRoute) {
        const task = state.tasks[taskRoute[1]]; if (!task) throw fail(404, 'Unknown task');
        if(task.threadId&&tools.readSettings&&(task.execution?.executionPolicy||tools.isExecutionManaged?.(task.threadId))){try{const settings=(await tools.readSettings(task.threadId,task.hostId)).settings;return json(res,200,{...task,effectiveSettings:settings,sandboxMode:settings.sandboxMode,writableRoots:settings.writableRoots,approvalPolicy:settings.approvalPolicy});}catch(e){return json(res,200,{...task,effectiveSettings:null,sandboxMode:null,writableRoots:null,approvalPolicy:null,executionReadError:e.message});}}
        return json(res, 200, task);
      }
      if (req.method === 'GET' && ['/v1/events', '/v1/events/stream'].includes(url.pathname)) {
        const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw fail(400, 'Invalid event cursor');
        const available = events.filter(event => event.id > after);
        if (url.pathname === '/v1/events') return json(res, 200, { events: available, cursor: events.at(-1)?.id ?? 0 });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for (const event of available) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.write(': connected\n\n'); streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      throw fail(404, 'Unknown endpoint');
    } catch (error) { if (!res.headersSent) {const details=errorData(error,502);json(res,details.httpStatus,{...details,error:details.message});} else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  writeJson(path.join(stateDir, 'connection.json'), { baseUrl, token: state.token, pid: process.pid, callerThread: tools.callerThread, backend: state.provider });
  for (const item of Object.values(state.watches)) callback(item.threadId);
  for (const task of Object.values(state.tasks)) signals.taskCallback(task);
  const timer = setInterval(() => { for (const item of Object.values(state.watches)) void refresh(item); }, pollMs);
  timer.unref();
  let ipc;
  if (enableIpc && process.platform === 'win32') {
    ipc = new PipeRpc('\\\\.\\pipe\\codex-ipc', 'ipc');
    ipc.on('transportError', () => {});
    ipc.on('notification', message => {
      if (message.type !== 'broadcast' || message.method !== 'thread-stream-state-changed') return;
      const params = message.params ?? {};
      const item = state.watches[`${params.hostId ?? 'local'}:${params.conversationId}`];
      if (item) void refresh(item);
    });
    try { const initialized = await ipc.request('initialize', { clientType: 'external-gui-bridge' }); ipc.clientId = initialized.clientId; emit('bridge.ipc_connected', { clientId: initialized.clientId }); }
    catch (error) { emit('bridge.ipc_unavailable', { error: error.message, fallback: 'native read_thread polling' }); ipc.close(); }
  }
  return {
    baseUrl, token: state.token, state,
    async close() { clearInterval(timer); ipc?.close(); for (const stream of streams) stream.end(); tools.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, i, all) => item.startsWith('--') ? [...pairs, [item.slice(2), all[i + 1]]] : pairs, []));
  const tools = new DesktopTools(flags.pipe ?? null, flags['caller-thread'] ?? process.env.CODEX_THREAD_ID);
  // Probe the real desktop before accepting clients; do not start another app-server.
  const bridge = await startBridge({ tools, stateDir: path.resolve(flags.state ?? fileURLToPath(projectURL("runtime"))), port: Number(flags.port ?? 43127), preflight: () => tools.listTools() });
  console.log(`Codex GUI bridge listening at ${bridge.baseUrl}`);
  console.log('Credentials saved to connection.json in the state directory.');
  const stop = () => bridge.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
