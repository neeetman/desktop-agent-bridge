import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class DeepSeekNative {
  constructor(connectionFile = fileURLToPath(new URL('./runtime/deepseek-native/connection.json', import.meta.url))) { this.connectionFile = connectionFile; }
  async request(method, args = {}) {
    const connection = JSON.parse(fs.readFileSync(this.connectionFile));
    const response = await fetch(connection.baseUrl + '/rpc', { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(65000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `DeepSeek native HTTP ${response.status}`);
    return value.result;
  }
}
export function deepseekTurns(events) {
  const turns = []; let current;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') { current = { id: String(data.turn), status: 'inProgress', items: [], startedAt: event.timestamp }; turns.push(current); }
    if (!current) continue;
    if (event.type === 'assistant/message') {
      const text = (data.message?.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (text) current.items.push({ id: String(event.seq), type: 'agentMessage', text, phase: 'commentary' });
    }
    if (event.type === 'turn/end') {
      const reason = data.reason?.kind;
      current.status = reason === 'completed' ? 'completed' : reason === 'aborted' ? 'interrupted' : 'failed';
      current.completedAt = event.timestamp;
      if (current.items.length && current.status === 'completed') current.items.at(-1).phase = 'final_answer';
      if (current.status !== 'completed') current.error = data.reason?.error ?? data.reason?.reason ?? reason;
    }
  }
  return turns;
}
export function deepseekSelection(catalog, model, effort, provider) {
  const group = catalog.groups?.find(g => g.models?.some(m => m.id === model) && (!provider || g.id === provider)) ?? catalog.groups?.find(g => g.models?.some(m => m.id === model));
  if (!group) throw new Error('Unknown DeepSeek model; inspect its native model catalog');
  const nativeEffort = effort === 'none' ? 'off' : effort;
  const info = group.models.find(m => m.id === model);
  if (nativeEffort && !info.reasoning?.efforts?.some(item => item.id === nativeEffort)) throw new Error(`DeepSeek model supports reasoning efforts: ${(info.reasoning?.efforts ?? []).map(item => item.id).join(', ')}`);
  return { provider: group.id, model, ...(nativeEffort ? { reasoningEffort: nativeEffort } : {}) };
}
export class DeepSeekTools {
  provider = 'deepseek'; transport = 'deepseek-desktop-host-plugin'; callerThread = 'deepseek-desktop-native-controller';
  effortValues = ['none', 'low', 'high', 'max'];
  constructor(connectionFile) { this.native = new DeepSeekNative(connectionFile); }
  async listing() { return (await this.native.request('list')).items; }
  title(row) { const title = row.projections?.values?.title; return typeof title === 'string' ? title : title?.title ?? row.title ?? row.sessionId; }
  async readSettings(threadId) {
    const snapshot = await this.native.request('inspect', { sessionId: threadId });
    const pending = snapshot.events.findLast(e => e.type === 'model/selection')?.data;
    const last = snapshot.events.findLast(e => e.type === 'request/header')?.data;
    const used = last?.header?.config ?? last?.config;
    const selected = snapshot.projections?.values?.modelSelection;
    const model = selected?.next ?? selected?.lastUsed ?? pending ?? used ?? snapshot.meta.options ?? {};
    const { items: workspaces } = await this.native.request('workspaces');
    const workspace = workspaces.find(w => w.sessionIds?.includes(threadId));
    return { settings: { model: model.model ?? null, provider: model.provider ?? null, reasoningEffort: model.reasoningEffort ?? null, cwd: snapshot.projections?.values?.workingDirectory ?? snapshot.meta.cwd, originCwd: snapshot.meta.cwd, workspaceId: workspace?.id ?? null, workspaceName: workspace?.title ?? null, workspacePath: workspace?.path ?? null, environmentId: null } };
  }
  async select(threadId, model, effort) {
    const current = (await this.readSettings(threadId)).settings;
    const catalog = await this.native.request('models');
    const selected = await this.native.request('selectModel', { sessionId: threadId, ...deepseekSelection(catalog, model ?? current.model, effort, current.provider) });
    return selected;
  }
  async call(tool, args) {
    switch (tool) {
      case 'list_workspaces': return { workspaces: (await this.native.request('workspaces')).items.map(w => ({ workspaceId: w.id, name: w.title, path: w.path, sessionCount: w.sessionIds?.length ?? 0 })) };
      case 'create_workspace': return this.native.request('createWorkspace', { path: args.path, ...(args.title ? { title: args.title } : {}) });
      case 'list_projects': {
        const { items } = await this.native.request('workspaces');
        return { projects: items.map(w => ({ projectId: w.id, workspaceId: w.id, projectKind: 'local', label: w.title, path: w.path, hostId: 'local' })) };
      }
      case 'list_threads': {
        const rows = await this.listing();
        const { items: workspaces } = await this.native.request('workspaces');
        return { defaultKind: 'deepseek', pinnedThreads: [], threads: rows.filter(row => !row.parentSessionId).sort((a,b) => b.updatedAt-a.updatedAt).slice(0, args.limit ?? 50).map(row => {
          const w = workspaces.find(w => w.sessionIds?.includes(row.sessionId));
          return { id: row.sessionId, kind: 'deepseek', hostId: 'local', projectId: w?.id ?? null, workspaceId: w?.id ?? null, workspaceName: w?.title ?? null, workspacePath: w?.path ?? null, title: this.title(row), originCwd: row.cwd, cwd: row.projections?.values?.workingDirectory ?? row.cwd, status: row.running ? 'active' : 'idle', updatedAt: row.updatedAt };
        }) };
      }
      case 'read_thread': {
        const snapshot = await this.native.request('inspect', { sessionId: args.threadId });
        const title = snapshot.projections?.values?.title ?? snapshot.events.findLast(e => e.type === 'session/title')?.data?.title ?? snapshot.meta.title ?? args.threadId;
        const { items: workspaces } = await this.native.request('workspaces');
        const w = workspaces.find(w => w.sessionIds?.includes(args.threadId));
        return { thread: { id: args.threadId, kind: 'deepseek', hostId: 'local', title, projectId: w?.id ?? null, workspaceId: w?.id ?? null, workspaceName: w?.title ?? null, workspacePath: w?.path ?? null, originCwd: snapshot.meta.cwd, cwd: snapshot.projections?.values?.workingDirectory ?? snapshot.meta.cwd, status: { type: snapshot.status === 'running' ? 'active' : 'idle' } }, turns: deepseekTurns(snapshot.events).reverse().slice(0, args.turnLimit ?? 10), hasMore: snapshot.hasMore };
      }
      case 'create_thread': {
        if (args.model || args.thinking) {
          const catalog = await this.native.request('models');
          deepseekSelection(catalog, args.model ?? catalog.default?.model, args.thinking);
        }
        let location;
        if (args.target.type === 'project') location = { workspaceId: args.target.projectId };
        else { const cwd = fileURLToPath(new URL('./runtime/deepseek-workspace/', import.meta.url)); fs.mkdirSync(cwd, { recursive: true }); location = { cwd }; }
        const created = await this.native.request('create', { ...location, sessionId: crypto.randomUUID() });
        const id = created.sessionId;
        if (args.title) await this.native.request('rename', { sessionId: id, title: args.title });
        if (args.model || args.thinking) await this.select(id, args.model, args.thinking);
        await this.native.request('prompt', { sessionId: id, requestId: crypto.randomUUID(), content: [{ type: 'text', text: args.prompt }], clientTimeZone: 'Asia/Hong_Kong' });
        return { threadId: id, hostId: 'local' };
      }
      case 'send_message_to_thread': {
        if (args.model || args.thinking) await this.select(args.threadId, args.model, args.thinking);
        await this.native.request('prompt', { sessionId: args.threadId, requestId: crypto.randomUUID(), content: [{ type: 'text', text: args.prompt }], clientTimeZone: 'Asia/Hong_Kong' });
        return { threadId: args.threadId };
      }
      default: throw new Error(`DeepSeek adapter does not implement ${tool}`);
    }
  }
  close() {}
}
