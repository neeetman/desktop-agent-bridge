import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {withCapability} from './compatibility.mjs';

export class ClaudeNative {
  constructor(connectionFile = fileURLToPath(new URL('./runtime/claude-relay/connection.json', import.meta.url))) {
    this.connectionFile = connectionFile;
  }
  async request(method, args = []) {
    const connection = JSON.parse(fs.readFileSync(this.connectionFile, 'utf8'));
    const response = await fetch(`${connection.baseUrl}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(65000) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? `Native relay HTTP ${response.status}`);
    return body.result;
  }
}

export function claudeTurns(messages, session) {
  const turns = []; let current;
  for (const row of messages) {
    const content = row.message?.content;
    const userText = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
    if (row.type === 'user' && userText && !row.isMeta && !(Array.isArray(content)&&content.some(item=>item.type==='tool_result'))) {
      if(current?.status==='inProgress'){
        if(current.items.some(item=>item.phase==='final_answer')){
          current.status='completed';current.completedAt=current.finalMessageAt;current.completionEvidence='native-final-message-before-next-user';
        }else{
          current.status='interrupted';current.completedAt=row.timestamp;current.completionEvidence='native-next-user-before-final';current.supersededByTurnId=row.uuid;current.error='A subsequent native user input superseded this tracked input before its standalone final answer';
        }
      }
      current = { id: row.uuid, status: 'inProgress', items: [], startedAt: row.timestamp };
      turns.push(current);
    }
    if (!current) continue;
    if (row.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      if (text) current.items.push({ id: row.uuid, type: 'agentMessage', text, phase: row.message.stop_reason === 'end_turn' ? 'final_answer' : 'commentary' });
      if(text&&row.message.stop_reason==='end_turn')current.finalMessageAt=row.timestamp;
    }
    if (row.type === 'result') {
      current.status = row.is_error || row.subtype?.startsWith('error') ? 'failed' : 'completed';
      current.completedAt = row.timestamp;
      if (row.result && !current.items.some(item => item.phase === 'final_answer')) current.items.push({ id: row.uuid, type: 'agentMessage', text: row.result, phase: 'final_answer' });
      if (current.status === 'failed') current.error = row.errors ?? row.result ?? row.subtype;
    }
  }
  if (current?.status === 'inProgress' && !session.turnRunning && !session.isRunning && current.items.some(item => item.phase === 'final_answer')) current.status = 'completed';
  return turns;
}

export class ClaudeTools {
  provider = 'claude';
  transport = 'claude-desktop-native-main-renderer-rpc';
  callerThread = 'claude-desktop-native-controller';
  constructor(connectionFile) { this.native = new ClaudeNative(connectionFile); }
  async preflightDispatch(){await withCapability('claude','send',async()=>{});}
  async readTrackedTurn(threadId,turnId){
    let cursor='',rows=[];const cursors=new Set();
    for(let page=0;page<40;page++){
      const result=await this.native.request('getTranscriptPage',[threadId,cursor,200]);
      if(!Array.isArray(result.messages)||result.found===false)return null;
      rows=[...result.messages,...rows];const index=rows.findIndex(row=>row.type==='user'&&row.uuid===turnId);
      if(index>=0){const session=await this.native.request('getSession',[threadId]);return claudeTurns(rows.slice(index),session).find(turn=>turn.id===turnId)??null;}
      if(!result.hasMore||!result.messages.length)return null;
      cursor=result.messages[0].uuid;if(!cursor||cursors.has(cursor))return null;cursors.add(cursor);
    }
    return null;
  }
  async readSettings(threadId) {
    const session = await this.native.request('getSession', [threadId]);
    if (!session) throw new Error('Claude session not found');
    return { settings: { model: session.model, reasoningEffort: session.effort ?? null, cwd: session.cwd, environmentId: session.startedFromEnvironmentId ?? null, permissionMode: session.permissionMode, cliVersion: session.processCliVersion ?? null } };
  }
  async call(tool, args) {
    switch (tool) {
      case 'list_projects': {
        const detected = await this.native.request('getDetectedProjects');
        const listed = await this.native.request('getSessionList');
        const byPath = new Map();
        for (const row of [...listed.sessions.map(x => ({ path: x.originCwd ?? x.cwd, name: path.basename(x.originCwd ?? x.cwd) })), ...detected]) {
          if (!row.path) continue;
          const key = path.resolve(row.path).toLowerCase();
          if (!byPath.has(key)) byPath.set(key, { projectId: key, projectKind: 'local', label: row.name, path: row.path, hostId: 'local' });
        }
        return { projects: [...byPath.values()] };
      }
      case 'list_threads': {
        const result = await this.native.request('getSessionList');
        return { defaultKind: 'claude', pinnedThreads: [], threads: result.sessions.filter(x => !x.isArchived).sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, args.limit ?? 50).map(x => ({ id: x.sessionId, kind: 'claude', hostId: 'local', projectId: path.resolve(x.originCwd ?? x.cwd).toLowerCase(), cwd: x.cwd, title: x.title, status: x.turnRunning || x.isRunning ? 'active' : 'idle', model: x.model, effort: x.effort ?? null, updatedAt: x.lastActivityAt })) };
      }
      case 'read_thread': {
        const session = await this.native.request('getSession', [args.threadId]);
        if (!session) throw new Error('Claude session not found');
        const tail = await this.native.request('getTranscriptTail', [args.threadId, 200]);
        return { thread: { id: session.sessionId, kind: 'claude', hostId: 'local', title: session.title, cwd: session.cwd, status: { type: session.turnRunning || session.isRunning ? 'active' : 'idle' } }, turns: claudeTurns(tail.messages, session).reverse().slice(0, args.turnLimit ?? 10), hasMore: tail.hasMore };
      }
      case 'create_thread': {
        let cwd;
        if (args.target.type === 'project') {
          const { projects } = await this.call('list_projects', {});
          cwd = projects.find(project => project.projectId === args.target.projectId)?.path;
          if (!cwd) throw new Error('Unknown Claude projectId; query /v1/projects');
        } else {
          cwd = fileURLToPath(new URL('./runtime/claude-workspace/', import.meta.url));
          fs.mkdirSync(cwd, { recursive: true });
        }
        // The native renderer contract requires model, even though the SDK itself has a default.
        const listed = await this.native.request('getSessionList');
        const model = args.model ?? listed.sessions.find(x => !x.isArchived && x.model)?.model;
        if (!model) throw new Error('No observed desktop model; provide model explicitly');
        const result = await this.native.request('start', [{ cwd, model, message: args.prompt, title: args.title ?? 'Bridge task', useWorktree: false, ...args.thinking ? { effort: args.thinking } : {} }]);
        return { threadId: result.sessionId, hostId: 'local' };
      }
      case 'send_message_to_thread': {
        if (args.model) await this.native.request('setModel', [args.threadId, args.model]);
        if (args.thinking) {
          await this.native.request('setEffort', [args.threadId, args.thinking]);
          const accepted = await this.native.request('getSession', [args.threadId]);
          if (accepted.effort !== args.thinking) throw new Error(`Claude did not accept effort ${args.thinking}; read back ${accepted.effort}`);
        }
        await this.native.request('sendMessage', [args.threadId, args.prompt]);
        return { threadId: args.threadId };
      }
      default: throw new Error(`Claude adapter does not implement ${tool}`);
    }
  }
  close() {}
}
