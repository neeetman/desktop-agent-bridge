import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {codexModelCatalog,resolveSelection,matchRegisteredCwd} from '../../core/collaboration.mjs';
import policy from '../../core/execution-policy.cjs';
import {registeredLocation} from '../../core/worktree-location.mjs';
import {ensureExecution,executionRpc} from './codex-execution.mjs';
import {withCapability,compatError} from '../../compat/compatibility.mjs';

const run = promisify(execFile);
export const MAX_FRAME = 8 * 1024 * 1024;

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME) throw new Error('Frame exceeds 8 MiB');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameReader {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE();
      if (length === 0 || length > MAX_FRAME) throw new Error('Invalid frame length');
      if (this.buffer.length < 4 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

export async function discoverToolPipe() {
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH) return process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if (process.platform !== 'win32') throw new Error('Set CODEX_APP_TOOLS_PIPE_PATH on this platform');
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-ChildItem -LiteralPath '\\\\.\\pipe\\' | Where-Object Name -like 'codex-app-tools-*' | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"], { windowsHide: true });
  const value = JSON.parse(stdout.trim() || '[]');
  const paths = Array.isArray(value) ? value : [value];
  if (paths.length !== 1) throw new Error(`Expected one desktop tool pipe, found ${paths.length}; specify --pipe`);
  return `\\\\.\\pipe\\${paths[0]}`;
}

export class PipeRpc extends EventEmitter {
  pending = new Map();
  socket = null;
  connecting = null;
  constructor(path, mode = 'tools') { super(); this.path = path; this.mode = mode; }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.resolvePath) this.path = await this.resolvePath();
      return new Promise((resolve, reject) => {
      const reader = new FrameReader();
      const socket = net.connect(this.path);
      const timer = setTimeout(() => socket.destroy(new Error('Pipe connection timeout')), 5000);
      socket.on('connect', () => { clearTimeout(timer); this.socket = socket; resolve(); });
      socket.on('data', chunk => {
        try { for (const message of reader.push(chunk)) this.receive(message); }
        catch (error) { socket.destroy(error); }
      });
      socket.on('error', error => { clearTimeout(timer); reject(error); this.emit('transportError', error); });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        for (const [id,pending] of this.pending) if(pending.socket===socket) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new Error('Desktop pipe closed; operation outcome may be unknown')); }
        this.emit('disconnect');
      });
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  receive(message) {
    const id = this.mode === 'ipc' ? message.requestId : message.id;
    const pending = this.pending.get(id);
    if (pending && (this.mode !== 'ipc' || message.type === 'response')) {
      this.pending.delete(id); clearTimeout(pending.timer);
      if (message.error || message.resultType === 'error') pending.reject(new Error(typeof message.error === 'string' ? message.error : JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (this.mode === 'ipc' && message.type === 'client-discovery-request') {
      this.socket?.write(frame({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }));
      return;
    }
    this.emit('notification', message);
  }
  async request(method, params = {}, timeoutMs = 30000, extra = {}) {
    await this.connect();
    const id = crypto.randomUUID();
    const message = this.mode === 'ipc'
      ? { type: 'request', requestId: id, sourceClientId: this.clientId ?? 'initializing-client', method, params, version: 0, timeoutMs, ...extra }
      : { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native request timeout: ${method}; outcome unknown, do not retry a mutation blindly`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket:this.socket });
      this.socket.write(frame(message), error => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  close() { this.socket?.destroy(); }
}

export function unwrapTool(result) {
  const blocks = result.contentItems ?? result.content ?? [];
  const text = blocks.filter(block => typeof block.text === 'string').map(block => block.text).join('\n');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(text || 'Native tool returned no JSON result'); }
  if (result.isError === true || result.error) throw new Error(text || JSON.stringify(result.error));
  return data;
}

export class DesktopTools {
  constructor(pipe, callerThread, {executionRuntime,guardRuntime=withCapability} = {}) {
    if (!callerThread) throw new Error('Set --caller-thread or CODEX_THREAD_ID to the dispatcher chat ID');
    this.rpc = new PipeRpc(pipe);
    if (!pipe) this.rpc.resolvePath = discoverToolPipe;
    this.callerThread = callerThread;
    this.executionRuntime = executionRuntime ?? {ensureExecution,executionRpc};
    this.guardRuntime=guardRuntime;
  }
  async listTools() { return this.guardRuntime('codex','read',async()=>{const value=await this.rpc.request('tools/list', { threadStartKind: 'all' });if(!Array.isArray(value.tools))throw compatError('CONTRACT_MISMATCH','Native tools/list contract changed');return value.tools;}); }
  async listModels(){const tool=(await this.listTools()).find(item=>item.name==='create_thread');return codexModelCatalog(tool?.inputSchema?.properties?.model?.description??'');}
  executionCapabilities(){const config=policy.readSettings();return {sandboxModes:['workspace-write','read-only','danger-full-access'],fullAccess:{sandboxMode:'danger-full-access',defaultApprovalPolicy:'never',writableRoots:'omit; full access is unrestricted'},permissionUpdates:'explicit; managed idle Codex threads only; pending approvals rejected',defaultSandboxMode:config.defaultSandboxMode??'workspace-write',approvalPolicies:['on-request','untrusted','never','on-failure'],allowedWritableRoots:config.allowedWritableRoots,executionPolicySettingsFile:policy.settingsFile(),executionPolicyPersistence:'per-thread; revalidated before every bridge wake',cwdPolicy:'registered-project-or-verified-git-worktree'};}
  async setPermissions(threadId,input){await this.checkExecutionReady();return this.executionRuntime.executionRpc('set_permissions',{threadId,policy:input});}
  async preflightDispatch(input){await this.guardRuntime('codex','send',async()=>{});if(input.threadId&&this.isExecutionManaged(input.threadId))await this.checkExecutionReady();}
  isExecutionManaged(threadId){return !!policy.loadState().threads[threadId];}
  async prepareExecution(execution,{threadId}={}){
    if(threadId)return execution;
    const executionPolicy=policy.validate(execution);
    let projects;
    if(execution.cwd||execution.target.type==='project')projects=(await this.call('list_projects',{})).projects;
    if(execution.cwd){
      let exists=false;try{exists=path.isAbsolute(execution.cwd)&&fs.statSync(execution.cwd).isDirectory();}catch{}
      if(!exists)throw Object.assign(new Error(`cwd must be an existing absolute directory: ${execution.cwd}; no session was created`),{status:400});
      const location=await registeredLocation(projects,execution.cwd,execution.target.type==='project'?execution.target.projectId:null);
      execution.cwd=location.cwd;execution.location=location;execution.target={type:'project',projectId:location.projectId,environment:{type:'local'}};
    }
    else if(execution.target.type==='project'){const project=projects.find(row=>row.projectId===execution.target.projectId);if(!project)throw Object.assign(new Error('Registered project not found'),{status:400});execution.cwd=policy.canonicalDirectory(project.path);}
    if(execution.model)execution.model=resolveSelection(await this.listModels(),execution.model,execution.effort);
    execution.executionPolicy=executionPolicy;
    // Resolve compatibility before bridge.mjs reserves an idempotency record.
    await this.checkExecutionReady();
    return execution;
  }
  async checkExecutionReady(){
    try{return await this.executionRuntime.ensureExecution();}
    catch(error){throw Object.assign(error,{status:503,code:error.code??'EXECUTION_PREFLIGHT_FAILED',dispatchNotStarted:true});}
  }
  async readSettings(threadId, hostId = 'local') {
    if(this.isExecutionManaged(threadId))return this.guardRuntime('codex','read',async selection=>{
      if(selection.profile?.coreApiVersion===2)return this.readSettingsGuarded(threadId,hostId);
      return this.guardRuntime('codex','settings',()=>this.readSettingsGuarded(threadId,hostId));
    });
    return this.guardRuntime('codex','settings',()=>this.readSettingsGuarded(threadId,hostId));
  }
  async readSettingsGuarded(threadId, hostId = 'local') {
    if(policy.loadState().threads[threadId]){
      await ensureExecution();const native=await executionRpc('read',{threadId});if(!native.loaded)throw Object.assign(new Error('Native execution state is not loaded; wake this managed thread to restore it'),{status:503});
      return {settings:{model:native.model,reasoningEffort:native.reasoningEffort,cwd:native.cwd,sandboxMode:native.sandboxMode,writableRoots:native.writableRoots,approvalPolicy:native.approvalPolicy,permissionScope:native.permissionScope,nextTurnPermissions:native.nextTurnPermissions,executionSource:native.source},nativeExecution:native};
    }
    if (process.platform !== 'win32') throw new Error('Desktop settings IPC is only implemented on Windows');
    if (!this.settingsRpc) {
      this.settingsRpc = new PipeRpc('\\\\.\\pipe\\codex-ipc', 'ipc');
      this.settingsRpc.on('transportError', () => {});
    }
    if (!this.settingsRpc.socket || this.settingsRpc.socket.destroyed) {
      const init = await this.settingsRpc.request('initialize', { clientType: 'external-gui-bridge' }, 5000);
      this.settingsRpc.clientId = init.clientId;
    }
    const result=await this.settingsRpc.request('thread-follower-read-model-settings', { conversationId: threadId }, 5000,
      hostId === 'local' ? { version: 1 } : { version: 2, hostId });
    try{const snapshot=await this.call('read_thread',{threadId,hostId,turnLimit:1,maxOutputCharsPerItem:128});return {...result,settings:{...result.settings,cwd:snapshot.thread?.cwd??null}};}catch{return result;}
  }
  async call(tool, args, timeoutMs = 45000) {
    if(tool==='create_thread'&&args.executionPolicy){
      await this.checkExecutionReady();const created=await this.executionRuntime.executionRpc('create',{args:{...args.executionPolicy,requestId:args.requestId,cwd:args.cwd,title:args.title,projectId:args.target.type==='project'?args.target.projectId:undefined,model:args.model,effort:args.thinking}});
      try{
      const visible=await this.rawCall('read_thread',{threadId:created.threadId,hostId:'local',turnLimit:1});if(args.cwd&&path.resolve(visible.thread.cwd).toLowerCase()!==path.resolve(args.cwd).toLowerCase())throw new Error('Native cwd readback mismatch; first model turn was not dispatched');
      await this.executionRuntime.executionRpc('prepare',{threadId:created.threadId});
      await this.rawCall('send_message_to_thread',{threadId:created.threadId,hostId:'local',prompt:args.prompt,...args.model?{model:args.model}:{},...args.thinking?{thinking:args.thinking}:{}});
      return {threadId:created.threadId,hostId:'local',executionManaged:true};
      }catch(error){throw Object.assign(error,{dispatchNotStarted:false,dispatchStage:'sent',createdThreadId:created.threadId});}
    }
    if(tool==='send_message_to_thread'&&policy.loadState().threads[args.threadId]){await this.checkExecutionReady();await this.executionRuntime.executionRpc('prepare',{threadId:args.threadId});}
    return this.rawCall(tool,args,timeoutMs);
  }
  async rawCall(tool,args,timeoutMs=45000){
    if(!['list_projects','list_threads','list_archived_threads','read_thread','create_thread','send_message_to_thread'].includes(tool))throw compatError('CAPABILITY_UNSUPPORTED','Unknown native tool is not allowed by the bridge contract');
    const capability=['create_thread','send_message_to_thread'].includes(tool)?'send':'read';
    return this.guardRuntime('codex',capability,async selection=>{
    if(tool==='create_thread' && (selection.profile?.coreApiVersion===2||selection.profile?.evidence?.stage==='messaging-verified'))throw compatError('CAPABILITY_UNSUPPORTED','Generated profiles require validated managed creation');
    if(this.nativeGeneration&&this.nativeGeneration!==selection.binding?.generation){this.rpc.close();this.settingsRpc?.close();this.nativeSchema=null;}
    this.nativeGeneration=selection.binding?.generation;
    if(capability==='send'&&this.nativeSchema!==selection.binding?.activationEpoch){const declaration=await this.rpc.request('tools/list',{threadStartKind:'all'});if(!Array.isArray(declaration.tools)||!declaration.tools.some(item=>item.name===tool&&item.inputSchema?.type==='object'))throw compatError('CONTRACT_MISMATCH','Native write-tool schema is unavailable');this.nativeSchema=selection.binding?.activationEpoch;}
    const result = await this.rpc.request('tools/call', {
      callerSource: 'codex', namespace: 'codex_app', hostId: 'local',
      threadId: this.callerThread, turnId: 'external-gui-bridge', callId: crypto.randomUUID(),
      tool, arguments: args,
    }, timeoutMs);
    const value=unwrapTool(result);
    if(tool==='read_thread'&&(!value.thread||!Array.isArray(value.turns)))throw compatError('CONTRACT_MISMATCH','Native read_thread response changed');
    return value;
    });
  }
  close() { this.rpc.close(); this.settingsRpc?.close(); }
}
