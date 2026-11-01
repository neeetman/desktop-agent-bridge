import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { peerTools as tools } from '../../mcp/peer-catalog.mjs';
import { callPeerTool } from '../../mcp/peer-call.mjs';

export const name = 'desktop-session-bridge';
export const inject = ['sessionController', 'workspaceRegistry', 'tools', 'agents'];

// Loaded by the real desktop Host through its profile/HMR plugin mechanism.
export async function apply(ctx, config) {
  const directory = path.join(config.directory, 'runtime/deepseek-native');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'imported.json'), JSON.stringify({ pid: process.pid, time: new Date().toISOString(), source: import.meta.url }));
  let teardown = () => {};
  try {
  fs.writeFileSync(path.join(directory, 'scope.json'), JSON.stringify(Object.fromEntries(['sessionController', 'workspaceRegistry', 'tools', 'agents'].map(key => [key, !!ctx.get(key)]))));
  const file = path.join(directory, 'connection.json');
  const token = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).token : crypto.randomBytes(32).toString('hex');
  const signal = () => AbortSignal.timeout(60000);
  const methods = {
    list: () => ctx.sessionController.list({}),
    inspect: async ({ sessionId }) => {
      const result = await ctx.sessionController.inspect(sessionId, signal());
      const projections = await ctx.sessionController.projections({ sessionId }, signal());
      return { meta: result.meta, events: result.events.slice(-400), projections, hasMore: result.events.length > 400, status: ctx.agents.get(sessionId)?.status ?? 'idle' };
    },
    workspaces: () => ({ items: ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: w.sessionIds })) }),
    createWorkspace: async ({ path: directoryPath, title }) => {
      const existing = await ctx.workspaceRegistry.resolveByPath(directoryPath);
      const workspace = existing ?? await ctx.workspaceRegistry.create(directoryPath, title);
      return { created: !existing, workspace: { id: workspace.id, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds } };
    },
    models: () => ctx.sessionController.modelCatalog(),
    create: args => ctx.sessionController.create(args),
    rename: args => ctx.sessionController.rename(args),
    selectModel: args => ctx.sessionController.selectModel(args),
    prompt: args => ctx.sessionController.prompt(args, signal()),
  };
  const server = http.createServer(async (request, response) => {
    const reply = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      if (request.headers.origin || request.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Local plugin authorization required' });
      if (request.method === 'GET' && request.url === '/health') return reply(200, { ok: true, pid: process.pid, transport: 'deepseek-desktop-host-plugin' });
      if (request.method !== 'POST' || request.url !== '/rpc') return reply(404, { error: 'Unknown route' });
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) return reply(413, { error: 'Request too large' }); chunks.push(chunk); }
      const { method, args = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Object.hasOwn(methods, method)) return reply(400, { error: 'Unsupported native method' });
      return reply(200, { result: await methods[method](args) });
    } catch (error) { return reply(500, { error: error.message, code: error.code }); }
  });
  const close = () => {
    server.close(); server.closeAllConnections();
  };
  teardown = close;
  ctx.effect(() => close, 'desktop-bridge.http');
  // Recover this plugin's own listener if an earlier failed activation left it behind.
  for (const handle of process._getActiveHandles()) {
    if (handle !== server && typeof handle.address === 'function' && handle.address()?.port === (config.port ?? 43132) && handle.listeners?.('request').some(fn => String(fn).includes('Local plugin authorization required'))) {
      handle.closeAllConnections(); await new Promise(resolve => handle.close(resolve));
    }
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 43132, '127.0.0.1', resolve); });
  fs.writeFileSync(file, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid }, null, 2), { mode: 0o600 });
  const request = async (route, body) => {
    const c = JSON.parse(fs.readFileSync(path.join(config.directory, 'runtime/router/connection.json')));
    const response = await fetch(c.baseUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? `Router HTTP ${response.status}`); return value;
  };
  for (const tool of tools) ctx.tools.register({
    name: `mcp__desktop_bridge__${tool.name}`, description: tool.description, parameters: tool.inputSchema,
    output: { schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false }, render: (_args, value) => value.content },
    execute: async (args, exec) => {
      const threadId = exec.agent?.session?.id;
      if (!threadId) throw new Error('A desktop session Agent is required for bridge tools');
      const who = { app: 'deepseek', threadId };
      const self = async args => { if (args.fromThreadId && args.fromThreadId !== threadId) throw new Error('fromThreadId disagrees with the current runtime identity'); return who; };
      const value = await callPeerTool(tool.name, args, { request, self, identity: async args => ({ ...await self(args), evidence: 'ToolExecution.agent.session.id', needsThreadId: false }) });
      fs.appendFileSync(path.join(directory, 'tool-calls.jsonl'), JSON.stringify({ time: new Date().toISOString(), tool: tool.name, threadId }) + '\n');
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  });
  fs.writeFileSync(path.join(directory, 'plugin-ready.json'), JSON.stringify({ pid: process.pid, time: new Date().toISOString(), tools: tools.map(tool => tool.name), identity: 'ToolExecution.agent.session.id' }, null, 2));
  } catch (error) {
    teardown(); fs.writeFileSync(path.join(directory, 'activation-error.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2)); throw error;
  }
}
