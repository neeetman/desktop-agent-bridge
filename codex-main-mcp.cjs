function install(root) {
  if (process.type !== 'browser') return JSON.stringify({ installed: false });
  const req = process.mainModule.require.bind(process.mainModule);
  if (!req('node:worker_threads').isMainThread) return JSON.stringify({ installed: false });
  const fs = req('node:fs'), path = req('node:path'), net = req('node:net'), crypto = req('node:crypto');
  const { app } = req('electron');
  const compatibility = JSON.parse(fs.readFileSync(path.join(root, 'codex-mcp-compatibility.json'), 'utf8'));
  if(globalThis.__codexBridgeMcp?.state?.helperRevision===compatibility.helperRevision)return JSON.stringify({installed:true,reused:true,pid:process.pid});
  if(globalThis.__codexBridgeMcp?.state?.refreshing)return JSON.stringify({installed:false,reason:'MCP reload is in progress'});
  if(globalThis.__codexBridgeMcp&&!globalThis.__codexBridgeMcp.dispose)throw Error('Existing legacy helper cannot be safely replaced in place');
  globalThis.__codexBridgeMcp?.dispose();
  const runtime = req(path.join(root,'codex-runtime.cjs'));
  const directory = path.join(root, 'runtime/codex-mcp'); fs.mkdirSync(directory, { recursive: true });
  const token = JSON.parse(fs.readFileSync(path.join(root, 'runtime/connection.json'), 'utf8')).token;
  const state = { pid: process.pid, helperRevision:compatibility.helperRevision,desktopPackageVersion:compatibility.version,installedAt: new Date().toISOString(), state: 'finding_connection', reloads: 0 };
  const persist = () => fs.writeFileSync(path.join(directory, 'native-state.json'), JSON.stringify(state, null, 2));
  let connection, refreshing, lastFingerprint, debounce;
  const config = path.join(process.env.CODEX_HOME || app.getPath('home') + '/.codex', 'config.toml');
  const fingerprint = () => crypto.createHash('sha256').update(fs.readFileSync(config)).digest('hex');
  async function findConnection() {
    const constructor=await runtime.connectionConstructor(compatibility);
    if (connection && !connection.disposed && connection.connectionState === 'connected') return connection;
    const inspector = req('node:inspector'), session = new inspector.Session(); session.connect();
    const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
    try {
      globalThis.__codexBridgeMcpPrototype = constructor.prototype;
      const prototype = await post('Runtime.evaluate', { expression: 'globalThis.__codexBridgeMcpPrototype' });
      const objects = await post('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
      const found = await post('Runtime.callFunctionOn', { objectId: objects.objects.objectId, functionDeclaration: 'function(){const x=this.find(x=>x.options?.hostId==="local"&&!x.disposed&&x.connectionState==="connected");globalThis.__codexBridgeLocalConnection=x;return !!x}', returnByValue: true });
      if (!found.result?.value) throw new Error('Local desktop app-server connection is not ready');
      connection = globalThis.__codexBridgeLocalConnection;
      delete globalThis.__codexBridgeMcpPrototype; delete globalThis.__codexBridgeLocalConnection;
      state.state = 'connected'; persist(); return connection;
    } finally { session.disconnect(); }
  }
  async function reload(reason = 'requested') {
    if (refreshing) return refreshing;
    let protection;try{protection=JSON.parse(fs.readFileSync(path.join(root,'runtime/router/protected-threads.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const block=runtime.reloadBlockReason(protection);if(block){state.reloadDeferred=block;persist();throw new Error(block);}
    state.refreshing=true;
    refreshing = (async () => {
      const connection = await findConnection();
      await connection.sendAppServerRequest('config/mcpServer/reload', undefined);
      state.reloads++; state.lastReloadAt = new Date().toISOString(); state.lastReloadReason = reason; state.lastError = null;
      lastFingerprint = fingerprint(); persist(); return { queued: true, ...state };
    })().catch(error => { state.lastError = error.message; persist(); throw error; }).finally(() => { refreshing = null;state.refreshing=false;persist(); });
    return refreshing;
  }
  const bridge = { state, reload };
  globalThis.__codexBridgeMcp = bridge;
  const allowedTools = new Set(['bridge_self', 'bridge_list_threads', 'bridge_read_thread', 'bridge_send', 'bridge_reply', 'bridge_receive', 'bridge_request_decision', 'bridge_answer_decision', 'bridge_decisions', 'bridge_message']);
  const server = net.createServer(socket => {
    let data = ''; socket.setTimeout(90000, () => socket.destroy());
    socket.on('data', async chunk => {
      data += chunk.toString('utf8'); if (data.length > 128 * 1024) { socket.destroy(); return; }
      const index = data.indexOf('\n'); if (index < 0) return;
      let request; try { request = JSON.parse(data.slice(0, index)); data = ''; } catch { socket.destroy(); return; }
      const reply = value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
      if (request.token !== token) return reply({ error: 'Unauthorized' });
      try {
        if (request.method === 'status') return reply(state);
        if (request.method === 'reload') return reply(await reload('external_request'));
        const current = await findConnection();
        if (request.method === 'servers') return reply(await current.sendAppServerRequest('mcpServerStatus/list', { threadId: request.threadId, serverName: 'desktop-bridge', detail: 'toolsAndAuthOnly', limit: 20 }));
        if (request.method === 'call') {
          if (!allowedTools.has(request.tool) || typeof request.threadId !== 'string' || !/^[a-f0-9-]{36}$/i.test(request.threadId)) throw new Error('Current GUI thread and desktop-bridge tool required');
          return reply(await current.sendAppServerRequest('mcpServer/tool/call', { threadId: request.threadId, server: 'desktop-bridge', tool: request.tool, arguments: request.arguments ?? {}, _meta: { threadId: request.threadId, thread_id: request.threadId } }));
        }
        throw new Error('Unsupported MCP lifecycle operation');
      } catch (error) { reply({ error: error.message }); }
    });
  });
  server.on('error', error => { state.lastError = error.message; persist(); });
  server.listen('\\\\.\\pipe\\codex-gui-bridge-mcp');
  lastFingerprint = fingerprint();
  const onConfigChanged=() => {
    try { if (fingerprint() === lastFingerprint) return; } catch { return; }
    clearTimeout(debounce); debounce = setTimeout(() => void reload('config_changed').catch(() => {}), 700); debounce.unref();
  };
  fs.watchFile(config, { interval: 1000, persistent: false }, onConfigChanged);
  let attempts = 0;
  const startup = () => void reload('bridge_attached').catch(() => { if (++attempts < 10) { const timer = setTimeout(startup, 2000); timer.unref(); } });
  bridge.dispose=()=>{clearTimeout(debounce);fs.unwatchFile(config,onConfigChanged);server.close();};
  if(compatibility.reloadOnAttach!==false)startup();else void findConnection().catch(error=>{state.lastError=error.message;persist();});persist();
  return JSON.stringify({ installed: true, pid: process.pid });
}
module.exports = install;
