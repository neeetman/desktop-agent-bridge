// Antigravity 2.0 desktop adapter. No injection: the live Language Server Hub is
// discovered from its daemon file, writes go through the bundled `agentapi` CLI
// and reads come from the local conversation index and transcript logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const SUMMARY_COLUMNS = ['conversation_id', 'title', 'preview', 'step_count', 'last_modified_time', 'workspace_uris',
  'status', 'project_id', 'agent_name', 'parent_conversation_id', 'nesting_depth', 'killed', 'not_fully_idle'];
export const AGENTAPI_COMMANDS = ['send-message', 'new-conversation', 'get-conversation-metadata'];
export const MODEL_TIERS = ['flash_lite', 'flash', 'pro'];
// Windows limits a command line to 32767 UTF-16 units; keep room for the executable and flags.
export const MAX_INLINE_CHARS = 24000;
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), {status, ...extra});
const notStarted = (code, message) => fail(503, message, {code, dispatchNotStarted: true, dispatchStage: 'notStarted'});

export function antigravityPaths({home = os.homedir(), localAppData = process.env.LOCALAPPDATA} = {}) {
  const data = path.join(home, '.gemini', 'antigravity');
  return {
    data, config: path.join(home, '.gemini', 'config'), daemon: path.join(data, 'daemon'),
    summaries: path.join(data, 'conversation_summaries.db'), brain: path.join(data, 'brain'),
    languageServer: path.join(localAppData ?? path.join(home, 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
  };
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Newest hub file whose process is alive and whose /healthz answers 200. The
// CSRF token is non-enumerable so a serialized hub record never contains it.
export async function discoverHub({daemon, fetchImpl = fetch, alive = pidAlive, timeoutMs = 1500} = {}) {
  let names = [];
  try { names = fs.readdirSync(daemon).filter(name => /^hub_\d+\.json$/.test(name)); } catch {}
  const rows = names.map(name => {
    const file = path.join(daemon, name);
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {}
    return {name, file, mtime};
  }).sort((a, b) => b.mtime - a.mtime);
  const checked = [];
  for (const row of rows) {
    let data;
    try { data = JSON.parse(fs.readFileSync(row.file, 'utf8')); } catch { checked.push({hubFile: row.name, state: 'unreadable'}); continue; }
    const pid = Number(data.pid), port = Number(data.httpPort), token = typeof data.csrfToken === 'string' ? data.csrfToken : '';
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) { checked.push({hubFile: row.name, state: 'invalid'}); continue; }
    if (!Number.isInteger(pid) || pid < 1 || !alive(pid)) { checked.push({hubFile: row.name, pid, state: 'stale'}); continue; }
    try {
      const response = await fetchImpl(`http://localhost:${port}/healthz`, {signal: AbortSignal.timeout(timeoutMs)});
      if (response.status !== 200) { checked.push({hubFile: row.name, pid, state: 'unhealthy', httpStatus: response.status}); continue; }
    } catch (error) { checked.push({hubFile: row.name, pid, state: 'unreachable', error: error.message}); continue; }
    const hub = {hubFile: row.name, pid, httpPort: port, address: `localhost:${port}`, lsVersion: data.lsVersion ?? null};
    Object.defineProperty(hub, 'csrfToken', {value: token, enumerable: false});
    return {hub, checked};
  }
  return {hub: null, checked};
}

function classify(message, code) {
  if (/code = (NotFound)/.test(message)) return fail(404, message, {code: 'ANTIGRAVITY_NOT_FOUND'});
  if (/code = (InvalidArgument)/.test(message) || /^Usage: agentapi/m.test(message)) return fail(400, message, {code: 'ANTIGRAVITY_INVALID_ARGUMENT'});
  if (/code = (Unavailable)|connection refused|actively refused|no such host|connectex/i.test(message)) return notStarted('APP_NOT_RUNNING', `Antigravity Language Server rejected the connection: ${message}`);
  if (/code = (Unauthenticated|PermissionDenied)|csrf/i.test(message)) return notStarted('CREDENTIALS_NOT_READY', `Antigravity hub credentials were rejected: ${message}`);
  // Anything else may have reached the hub; the router must not replay it.
  return fail(502, message || `agentapi exited ${code}`, {code: 'ANTIGRAVITY_AGENTAPI_FAILED'});
}

// Credentials travel only in the child environment, never on the command line.
export function runAgentApi(args, hub, {exe, timeoutMs = 30000, spawnImpl = spawn, raw = false} = {}) {
  return new Promise((resolve, reject) => {
    const env = {...process.env};
    delete env.ANTIGRAVITY_LS_ADDRESS; delete env.ANTIGRAVITY_CSRF_TOKEN;
    if (hub) { env.ANTIGRAVITY_LS_ADDRESS = hub.address; env.ANTIGRAVITY_CSRF_TOKEN = hub.csrfToken; }
    const redact = text => hub?.csrfToken ? text.split(hub.csrfToken).join('<redacted>') : text;
    let child;
    try { child = spawnImpl(exe, ['agentapi', ...args], {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (error) { return reject(notStarted('AGENTAPI_UNAVAILABLE', `Cannot start agentapi: ${error.message}`)); }
    let out = '', err = '', settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, fail(504, `agentapi ${args[0]} did not finish within ${timeoutMs} ms; outcome unknown`, {code: 'ANTIGRAVITY_AGENTAPI_TIMEOUT'}));
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => finish(reject, notStarted('AGENTAPI_UNAVAILABLE', `Cannot start agentapi: ${error.message}`)));
    child.on('close', code => {
      if (raw) return finish(resolve, {code, stdout: redact(out), stderr: redact(err)});
      let parsed; try { parsed = JSON.parse(out); } catch {}
      if (code === 0 && parsed?.response && !parsed.error) return finish(resolve, parsed.response);
      finish(reject, classify(redact(String(parsed?.error ?? (err.trim() || out.trim()))), code));
    });
  });
}

let DatabaseSync;
async function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite is stable enough for read-only queries; hide only its experimental notice.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
    return emit.call(this, warning, ...rest);
  };
  try { ({DatabaseSync} = await import('node:sqlite')); } finally { process.emitWarning = emit; }
  return DatabaseSync;
}

export async function openSummaries(file) {
  if (!fs.existsSync(file)) throw notStarted('ANTIGRAVITY_NOT_INSTALLED', 'Antigravity conversation index not found');
  const Database = await sqlite();
  const url = pathToFileURL(file); url.searchParams.set('mode', 'ro');
  return new Database(url, {readOnly: true});
}

export function summaryColumns(db) {
  return db.prepare('PRAGMA table_info(conversation_summaries)').all().map(row => row.name);
}

export function parseTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const iso = value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

export function workspacePaths(raw) {
  let uris = [];
  try { uris = JSON.parse(raw || '[]'); } catch { uris = raw ? [raw] : []; }
  return uris.filter(uri => typeof uri === 'string').map(uri => {
    try { return uri.startsWith('file:') ? fileURLToPath(uri) : uri; } catch { return uri; }
  });
}

export function readProjects(configDir) {
  const directory = path.join(configDir, 'projects');
  let names = [];
  try { names = fs.readdirSync(directory).filter(name => name.endsWith('.json')); } catch {}
  const projects = [];
  for (const name of names) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      const folders = (value.projectResources?.resources ?? []).map(row => row.gitFolder?.folderUri ?? row.folderUri).filter(Boolean);
      projects.push({id: value.id ?? name.slice(0, -5), name: value.name ?? null, paths: workspacePaths(JSON.stringify(folders)), sidecar: !!value.sidecar});
    } catch {}
  }
  return projects;
}

// Read complete JSONL records from the end of a file until `enough(record)`
// says the window is sufficient. Large transcripts are never read in full.
export function readTail(file, enough, {chunkBytes = 1 << 20, maxBytes = 64 << 20} = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let position = size, carry = Buffer.alloc(0), stopped = false;
    const records = [];
    while (position > 0 && !stopped) {
      const length = Math.min(chunkBytes, position); position -= length;
      const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, position);
      const data = carry.length ? Buffer.concat([buffer, carry]) : buffer;
      const cut = position === 0 ? -1 : data.indexOf(10);
      if (position > 0 && cut === -1) { carry = data; continue; }
      carry = position === 0 ? Buffer.alloc(0) : data.subarray(0, cut);
      const lines = data.subarray(cut + 1).toString('utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim(); if (!line) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        records.push(record);
        if (enough(record)) stopped = true;
      }
      if (size - position >= maxBytes) break;
    }
    return {records: records.reverse(), fromStart: position === 0 && !stopped && carry.length === 0, size};
  } finally { fs.closeSync(fd); }
}

const MESSAGE = /<SYSTEM_MESSAGE>\s*\[Message\]([^\n]*?)content=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>\s*$/;
export function inboundStep(step) {
  const content = typeof step.content === 'string' ? step.content : '';
  if (step.type === 'USER_INPUT') {
    const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
    return {kind: 'user', text: request ? request[1] : content};
  }
  if (step.type === 'SYSTEM_MESSAGE') {
    const match = MESSAGE.exec(content);
    if (match) return {kind: 'message', sender: /sender=(\S+)/.exec(match[1])?.[1] ?? null, text: match[2]};
  }
  return null;
}

// Turn boundaries: every USER_INPUT, and a delivered [Message] that arrives
// after the agent finished its previous run (that message woke the chat). A
// message from the chat's own background task (sender "<threadId>/task-N")
// continues the run that started the task.
export function antigravityTurns(steps, {running = false, fromStart = true, now = Date.now(), maxChars, threadId} = {}) {
  const clip = text => maxChars && text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]` : text;
  const turns = [];
  let current = null, ended = fromStart;
  for (const step of steps) {
    const index = step.step_index, input = inboundStep(step);
    const own = input?.kind === 'message' && !!threadId && !!input.sender?.startsWith(`${threadId}/`);
    if (input && (input.kind === 'user' || (ended && !(own && current)))) {
      current = {id: `step-${index}`, status: 'inProgress', items: [], startedAt: step.created_at ?? null, ended: false};
      turns.push(current); ended = false;
    }
    if (!current) {
      if (step.type === 'PLANNER_RESPONSE') ended = !step.tool_calls?.length;
      continue;
    }
    current.lastStepAt = step.created_at ?? current.lastStepAt;
    if (input) { current.items.push({id: String(index), type: 'userMessage', text: clip(input.text), ...input.sender ? {sender: input.sender} : {}}); continue; }
    if (step.type === 'PLANNER_RESPONSE') {
      if (typeof step.content === 'string' && step.content.trim()) current.items.push({id: String(index), type: 'agentMessage', text: clip(step.content), phase: 'commentary', final: !step.tool_calls?.length});
      ended = !step.tool_calls?.length;
      current.ended = ended; if (ended) current.error = undefined;
    } else if (step.type === 'ERROR_MESSAGE') {
      current.error = typeof step.content === 'string' ? step.content : 'Antigravity reported an error';
      ended = true; current.ended = true;
    }
  }
  turns.forEach((turn, position) => {
    const last = position === turns.length - 1;
    const final = turn.items.findLast(item => item.type === 'agentMessage');
    // The index can briefly report idle before the last step lands in the log.
    const settling = last && !turn.ended && now - (parseTime(turn.lastStepAt) ?? 0) < 10000;
    if (last && (running || settling)) turn.status = 'inProgress';
    else if (turn.error && !final?.final) turn.status = 'failed';
    else if (turn.ended && final?.final) { turn.status = 'completed'; final.phase = 'final_answer'; turn.completedAt = turn.lastStepAt ?? null; }
    else turn.status = last ? 'interrupted' : 'completed';
    for (const item of turn.items) delete item.final;
    delete turn.ended; delete turn.lastStepAt;
    if (!turn.error) delete turn.error;
  });
  return turns;
}

export function readTranscript(brainDir, threadId, {turnLimit = 10, maxChars} = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw fail(400, 'Antigravity conversation IDs are UUIDs');
  const logs = path.join(brainDir, threadId, '.system_generated', 'logs');
  const file = path.join(logs, 'transcript.jsonl');
  if (!fs.existsSync(file)) return {steps: [], fromStart: true, missing: true};
  let inputs = 0;
  const window = readTail(file, record => record.type === 'USER_INPUT' && ++inputs >= turnLimit);
  const truncated = window.records.filter(step => step.truncated_fields?.length);
  if (truncated.length) {
    const full = path.join(logs, 'transcript_full.jsonl');
    if (fs.existsSync(full)) {
      const wanted = new Map(truncated.map(step => [step.step_index, step]));
      const lowest = Math.min(...wanted.keys());
      const replacement = readTail(full, record => record.step_index <= lowest, {maxBytes: 256 << 20});
      for (const record of replacement.records) {
        const step = wanted.get(record.step_index);
        if (!step) continue;
        for (const field of step.truncated_fields) if (record[field] !== undefined) step[field] = record[field];
        step.restoredFromFull = true;
      }
    }
  }
  return {steps: window.records, fromStart: window.fromStart};
}

export class AntigravityNative {
  constructor({paths = antigravityPaths(), fetchImpl = fetch, alive = pidAlive, spawnImpl = spawn, contractTtlMs = 600000} = {}) {
    Object.assign(this, {paths, fetchImpl, alive, spawnImpl, contractTtlMs});
    this.contractCache = null;
  }
  hub() { return discoverHub({daemon: this.paths.daemon, fetchImpl: this.fetchImpl, alive: this.alive}); }
  async liveHub() {
    const {hub, checked} = await this.hub();
    if (!hub) throw Object.assign(notStarted('APP_NOT_RUNNING', 'Antigravity is not running (no live Language Server Hub); the message stays queued'), {hubChecks: checked});
    return hub;
  }
  agentapi(args, hub, options = {}) {
    if (!fs.existsSync(this.paths.languageServer)) return Promise.reject(notStarted('ANTIGRAVITY_NOT_INSTALLED', 'Antigravity language_server.exe not found'));
    return runAgentApi(args, hub, {exe: this.paths.languageServer, spawnImpl: this.spawnImpl, ...options});
  }
  async withSummaries(fn) {
    const db = await openSummaries(this.paths.summaries);
    try { return fn(db); } finally { db.close(); }
  }
  // Contract probes replace binary hashes: the three agentapi subcommands and the
  // columns this adapter reads. The hub is reported separately (not running is
  // not a contract failure).
  async contract({force = false} = {}) {
    let stamp = null;
    try { const stat = fs.statSync(this.paths.languageServer); stamp = `${stat.size}:${stat.mtimeMs}`; } catch {}
    if (!force && this.contractCache && this.contractCache.stamp === stamp && Date.now() - this.contractCache.at < this.contractTtlMs) return this.contractCache.value;
    const checks = [];
    if (!stamp) checks.push({check: 'language_server', ok: false, error: 'language_server.exe not found'});
    else {
      try {
        const help = await this.agentapi(['--help'], null, {raw: true, timeoutMs: 15000});
        const text = `${help.stdout}\n${help.stderr}`;
        const missing = AGENTAPI_COMMANDS.filter(name => !new RegExp(`^\\s+${name}\\b`, 'm').test(text));
        const newConversation = /new-conversation[^\n]*--model=/.test(text);
        checks.push({check: 'agentapi_commands', ok: !missing.length && newConversation, missing, modelFlag: newConversation});
      } catch (error) { checks.push({check: 'agentapi_commands', ok: false, error: error.message}); }
    }
    try {
      const columns = await this.withSummaries(summaryColumns);
      const missing = SUMMARY_COLUMNS.filter(name => !columns.includes(name));
      checks.push({check: 'conversation_summaries_columns', ok: !missing.length, missing});
    } catch (error) { checks.push({check: 'conversation_summaries_columns', ok: false, error: error.message}); }
    const value = {ok: checks.every(check => check.ok), checks};
    this.contractCache = {stamp, at: Date.now(), value};
    return value;
  }
  async requireContract() {
    const value = await this.contract();
    if (!value.ok) throw Object.assign(notStarted('CONTRACT_MISMATCH', `Antigravity native contract changed: ${JSON.stringify(value.checks.filter(check => !check.ok))}`), {contract: value});
    return value;
  }
}

export function summaryRow(row, projects = []) {
  const project = projects.find(item => item.id === row.project_id);
  const paths = workspacePaths(row.workspace_uris);
  return {
    id: row.conversation_id, kind: 'antigravity', hostId: 'local',
    projectId: row.project_id || null, projectName: project?.name ?? null,
    title: row.title || (row.preview ? String(row.preview).slice(0, 80) : row.conversation_id),
    summary: row.preview || null, workspacePaths: paths, cwd: paths[0] ?? null,
    // not_fully_idle: background tasks still run and will wake the chat when they finish.
    status: row.status === RUNNING || Number(row.not_fully_idle) ? 'active' : 'idle', nativeStatus: row.status || null,
    stepCount: Number(row.step_count ?? 0), updatedAt: parseTime(row.last_modified_time),
    ...row.agent_name ? {agentName: row.agent_name} : {},
    ...Number(row.nesting_depth) > 0 ? {parentThreadId: row.parent_conversation_id || null, nestingDepth: Number(row.nesting_depth)} : {},
  };
}

export class AntigravityTools {
  provider = 'antigravity';
  transport = 'antigravity-language-server-agentapi';
  callerThread = 'antigravity-desktop-agentapi';
  effortValues = [];
  executionCapabilities() {
    return {
      executionFields: ['title', 'model', 'taskVersion'],
      effortAliases: {},
      cwdPolicy: 'projectless-only',
      projectSelection: 'unsupported; agentapi new-conversation creates projectless chats only (pass absolute workspace paths in prompt)',
      reasoningSelection: 'model-tier-only; omit effort and pass flash_lite, flash, pro or a model ID',
    };
  }
  constructor(options = {}) {
    this.native = options.native ?? new AntigravityNative(options);
    this.spillDirectory = options.spillDirectory ?? null;
  }
  async summaries({limit = 50, threadId, includeNested = false} = {}) {
    return this.native.withSummaries(db => {
      if (threadId) return db.prepare(`SELECT ${SUMMARY_COLUMNS.join(',')} FROM conversation_summaries WHERE conversation_id = ?`).all(threadId);
      return db.prepare(`SELECT ${SUMMARY_COLUMNS.join(',')} FROM conversation_summaries WHERE killed = 0 ${includeNested ? '' : 'AND nesting_depth = 0'} ORDER BY last_modified_time DESC LIMIT ?`).all(limit);
    });
  }
  async thread(threadId) {
    const [row] = await this.summaries({threadId});
    if (row && !Number(row.killed)) return summaryRow(row, readProjects(this.native.paths.config));
    // A chat created moments ago may not be in the index yet; the hub knows it.
    const {hub} = row ? {hub: null} : await this.native.hub();
    if (hub) {
      try {
        const {conversationMetadata: {metadata = {}} = {}} = await this.native.agentapi(['get-conversation-metadata', threadId], hub, {timeoutMs: 15000});
        const paths = workspacePaths(JSON.stringify(metadata.workspaceUris ?? []));
        return {id: threadId, kind: 'antigravity', hostId: 'local', projectId: null, projectName: null, title: threadId, summary: null,
          workspacePaths: paths, cwd: paths[0] ?? null, status: 'active', nativeStatus: null, stepCount: 0, updatedAt: parseTime(metadata.createdAt), indexPending: true};
      } catch (error) { if (error.status !== 404) throw error; }
    }
    throw fail(404, `Antigravity conversation ${threadId} not found`, {code: 'THREAD_NOT_FOUND'});
  }
  // Writes only: reads work while the desktop is closed.
  async preflightDispatch(input) {
    await this.native.requireContract();
    await this.native.liveHub();
    if (input?.threadId) await this.thread(input.threadId);
  }
  async listModels() {
    return {models: MODEL_TIERS.map(id => ({id, kind: 'tier'})), acceptsModelIds: true,
      note: 'agentapi new-conversation accepts a tier or a model ID; an unavailable model ID runs on the flash tier. Reasoning effort is not selectable.'};
  }
  async readSettings(threadId) {
    const thread = await this.thread(threadId);
    const settings = {model: null, reasoningEffort: null, projectId: thread.projectId, projectName: thread.projectName,
      workspacePaths: thread.workspacePaths, cwd: thread.cwd, parentThreadId: thread.parentThreadId ?? null, source: 'conversation_summaries'};
    const {hub} = await this.native.hub();
    if (hub) {
      try {
        const {conversationMetadata: {metadata = {}} = {}} = await this.native.agentapi(['get-conversation-metadata', threadId], hub, {timeoutMs: 15000});
        const planner = metadata.staticConfig?.cascadeConfig?.plannerConfig ?? {};
        Object.assign(settings, {
          model: planner.requestedModel ?? (planner.modelName || planner.planModel || null),
          workspacePaths: workspacePaths(JSON.stringify(metadata.workspaceUris ?? [])).length ? workspacePaths(JSON.stringify(metadata.workspaceUris)) : thread.workspacePaths,
          rootThreadId: metadata.rootConversationId || null, parentThreadId: metadata.parentConversationId || settings.parentThreadId,
          createdAt: metadata.createdAt ?? null, source: 'get-conversation-metadata',
        });
        settings.cwd = settings.workspacePaths[0] ?? null;
      } catch (error) { settings.metadataError = error.message; }
    }
    return {settings};
  }
  messageText(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw fail(400, 'prompt must be nonempty');
    if (prompt.length <= MAX_INLINE_CHARS) return prompt;
    if (!this.spillDirectory) throw fail(413, `Antigravity message exceeds ${MAX_INLINE_CHARS} characters`, {dispatchNotStarted: true});
    // The command line cannot carry the whole text; deliver it as a local file.
    fs.mkdirSync(this.spillDirectory, {recursive: true});
    const file = path.join(this.spillDirectory, `${crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 24)}.md`);
    fs.writeFileSync(file, prompt, {encoding: 'utf8', mode: 0o600});
    const head = prompt.slice(0, MAX_INLINE_CHARS - 600);
    return `${head}\n\n[desktop-bridge] This message was ${prompt.length} characters, longer than the Antigravity command line allows. Read the complete text, including the part cut off above, from: ${file}`;
  }
  async call(tool, args = {}) {
    switch (tool) {
      case 'list_projects':
        return {projects: readProjects(this.native.paths.config).filter(project => !project.sidecar).map(project => ({projectId: project.id, projectKind: 'local', label: project.name, path: project.paths[0] ?? null, paths: project.paths, hostId: 'local'}))};
      case 'list_threads': {
        const projects = readProjects(this.native.paths.config);
        const rows = await this.summaries({limit: Math.min(Math.max(Number(args.limit) || 50, 1), 200)});
        return {defaultKind: 'antigravity', pinnedThreads: [], threads: rows.map(row => summaryRow(row, projects))};
      }
      case 'read_thread': {
        const thread = await this.thread(args.threadId);
        const transcript = readTranscript(this.native.paths.brain, args.threadId, {turnLimit: args.turnLimit ?? 10});
        const turns = antigravityTurns(transcript.steps, {running: thread.status === 'active', fromStart: transcript.fromStart, maxChars: args.maxOutputCharsPerItem, threadId: args.threadId});
        return {thread: {...thread, status: {type: thread.status}}, turns: turns.reverse().slice(0, args.turnLimit ?? 10), hasMore: !transcript.fromStart || turns.length > (args.turnLimit ?? 10), ...transcript.missing ? {transcriptMissing: true} : {}};
      }
      case 'create_thread': {
        if (args.target?.type === 'project') throw fail(400, 'Antigravity agentapi cannot choose a project or workspace; omit projectId to create a projectless chat', {dispatchNotStarted: true});
        if (args.thinking && args.thinking !== 'none') throw fail(400, 'Antigravity selects reasoning by model tier; omit effort and pass model (flash_lite, flash, pro or a model ID)', {dispatchNotStarted: true});
        if (args.model !== undefined && !/^[A-Za-z0-9._:-]{1,80}$/.test(args.model)) throw fail(400, 'model must be a tier or model ID', {dispatchNotStarted: true});
        const hub = await this.native.liveHub();
        const command = ['new-conversation', ...args.model ? [`--model=${args.model}`] : [], ...args.title ? [`--title=${String(args.title).replace(/[\r\n]+/g, ' ').slice(0, 120)}`] : [],
          ...args.profile ? [`--profile=${args.profile}`] : [], '--', this.messageText(args.prompt)];
        const response = await this.native.agentapi(command, hub);
        const threadId = response.newConversation?.conversationId;
        if (!threadId) throw fail(502, 'agentapi new-conversation returned no conversationId; creation outcome unknown', {code: 'ANTIGRAVITY_CREATE_UNCONFIRMED'});
        return {threadId, hostId: 'local'};
      }
      case 'send_message_to_thread': {
        if (args.model || (args.thinking && args.thinking !== 'none')) throw fail(400, 'An existing Antigravity chat keeps its model; omit model and effort', {dispatchNotStarted: true});
        await this.thread(args.threadId);
        const hub = await this.native.liveHub();
        // send-message wakes an idle chat and queues into a working one.
        const response = await this.native.agentapi(['send-message', '--title=Desktop bridge', args.threadId, this.messageText(args.prompt)], hub);
        if (response.sendMessage?.recipientId !== args.threadId) throw fail(502, 'agentapi send-message did not confirm the recipient; delivery outcome unknown', {code: 'ANTIGRAVITY_SEND_UNCONFIRMED'});
        return {threadId: args.threadId, delivery: 'agentapi-send-message'};
      }
      default: throw fail(501, `Antigravity adapter does not implement ${tool}`);
    }
  }
  close() {}
}

async function serviceHealth(connectionFile) {
  if (!connectionFile) return null;
  try {
    const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    if (connection.initializing || !connection.baseUrl) return {ok: false, state: 'initializing'};
    const response = await fetch(connection.baseUrl + '/health', {headers: {Authorization: `Bearer ${connection.token}`}, signal: AbortSignal.timeout(3000)});
    const value = await response.json();
    return {ok: response.ok && value.ok === true, pid: connection.pid ?? null, transport: value.transport ?? null};
  } catch (error) { return {ok: false, state: error.code === 'ENOENT' ? 'not_started' : 'unreachable', error: error.message}; }
}

// Identity evidence from the shared MCP client log: whether recent Antigravity
// tool calls carried the conversation in tools/call _meta.
function recentIdentity(clientLog) {
  if (!clientLog || !fs.existsSync(clientLog)) return null;
  try {
    const {records} = readTail(clientLog, () => false, {maxBytes: 512 << 10});
    const calls = records.filter(row => row.event === 'tool_call' && row.app === 'antigravity');
    const last = calls.at(-1);
    return last ? {calls: calls.length, lastAt: last.time, lastHadMetaThread: !!last.metaThread, withMetaThread: calls.filter(row => row.metaThread).length} : {calls: 0};
  } catch { return null; }
}

// Doctor: contract probes plus hub state, without exposing the CSRF token.
export async function antigravityDoctor(native = new AntigravityNative(), {connectionFile, clientLog} = {}) {
  const installed = fs.existsSync(native.paths.languageServer);
  const [contract, {hub, checked}, service] = await Promise.all([
    installed ? native.contract({force: true}) : {ok: false, checks: [{check: 'language_server', ok: false, error: 'not installed'}]},
    native.hub(), serviceHealth(connectionFile)]);
  return {installed, contract, hub: hub ? {...hub, healthz: 200} : null, hubChecks: checked, service, identity: recentIdentity(clientLog),
    phase: !installed ? 'not_installed' : !contract.ok ? 'contract_mismatch' : hub ? 'ready' : 'app_not_running'};
}
