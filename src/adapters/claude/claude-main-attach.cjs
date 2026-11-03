// This function is serialized into Claude's main Node.js context.
function install(config) {
  if (process.type !== 'browser') return JSON.stringify({ installed: false, reason: 'not browser process' });
  const requireMain = process.mainModule.require.bind(process.mainModule);
  const guard=config.binding?requireMain(requireMain('node:path').join(config.adapterRoot,'helper-binding.cjs')).createGuard(config.binding.root,'claude',config.binding):null;
  if (globalThis.__externalClaudeBridge) {
    if (guard?guard.replacement(globalThis.__externalClaudeBridge):globalThis.__externalClaudeBridge.revision === config.revision) return JSON.stringify({ installed: true, reused: true, pid: process.pid });
    globalThis.__externalClaudeBridge.stop();
    delete globalThis.__externalClaudeBridge;
  }
  if (!requireMain('node:worker_threads').isMainThread) return JSON.stringify({ installed: false, reason: 'not main thread' });
  const { app, webContents } = requireMain('electron');
  const fs = requireMain('node:fs');
  const net = requireMain('node:net');
  const token = JSON.parse(fs.readFileSync(config.connectionFile, 'utf8')).token;
  const records = new Map();
  let stopped = false;
  const eligible = contents => !contents.isDestroyed() && /^(?:app:\/\/localhost|https:\/\/claude\.ai)\/epitaxy(?:[/?#]|$)/.test(contents.getURL());
  async function attach(contents, force = false) {
    const record = records.get(contents.id);
    if (stopped || !record || record.busy || !eligible(contents)) return;
    record.busy = true;
    try {
      if (config.transport === 'main-renderer-rpc') {
        if (record.nativeReady && !force) return;
        record.nativeReady = await contents.executeJavaScript('Boolean(window["claude.web"]?.LocalSessions)', true);
        if (!record.nativeReady) throw new Error('Claude LocalSessions API is not ready');
        record.attaches++; record.lastAttachedAt = new Date().toISOString(); record.error = null;
        return;
      }
      if (!force && await contents.executeJavaScript('Boolean(window.__claudeGuiRelay)', true)) return;
      const script = fs.readFileSync(config.bootstrapFile, 'utf8');
      await contents.executeJavaScript(script, true);
      record.attaches++; record.lastAttachedAt = new Date().toISOString(); record.error = null;
    } catch (error) { record.nativeReady=false;record.error = String(error.message ?? error).slice(0, 250); }
    finally { record.busy = false; }
  }
  function observe(contents) {
    if (records.has(contents.id) || contents.getType() === 'devtools') return;
    const record = { id: contents.id, attaches: 0, busy: false, error: null };
    records.set(contents.id, record);
    contents.on('did-finish-load', () => void attach(contents, true));
    contents.on('destroyed', () => records.delete(contents.id));
    void attach(contents);
  }
  const created = (_event, contents) => observe(contents);
  app.on('web-contents-created', created);
  for (const contents of webContents.getAllWebContents()) observe(contents);
  const timer = setInterval(() => { for (const contents of webContents.getAllWebContents()) { observe(contents); void attach(contents); } }, 2000);
  timer.unref();
  const status = () => ({ pid: process.pid, version: app.getVersion(), revision: config.revision, devToolsOpen: webContents.getAllWebContents().some(contents => !contents.isDestroyed() && contents.getURL().startsWith('devtools://')), records: [...records.values()].map(({ id, attaches, lastAttachedAt, error }) => ({ id, attaches, lastAttachedAt, error })) });
  const server = net.createServer(socket => {
    let data = '';
    socket.setTimeout(65000, () => socket.destroy());
    socket.on('data', async chunk => {
      data += chunk.toString('utf8'); if (data.length > 1024 * 1024) { socket.destroy(); return; }
      const index = data.indexOf('\n'); if (index < 0) return;
      try {
        const request = JSON.parse(data.slice(0, index)); data = '';
        if (request.token !== token) { socket.end(JSON.stringify({ error: 'Unauthorized' }) + '\n'); return; }
        if(request.method!=='status')guard?.check(request,{probe:['maintenance','sessions','identity'].includes(request.method)});
        if (request.method === 'status') socket.end(JSON.stringify({...status(),binding:config.binding}) + '\n');
        else if (request.method === 'native') {
          const allowed = new Set(['getSessionList','getSession','getTranscriptTail','getTranscriptPage','getDetectedProjects','getDefaultEffort','start','sendMessage','setModel','setEffort','warmSession','updateSession','mcpReconnect','stop']);
          if (!allowed.has(request.nativeMethod) || !Array.isArray(request.args)) throw new Error('Unsupported native API method or arguments');
          if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) throw new Error('Native request expired; refusing delayed execution');
          const target = webContents.getAllWebContents().find(eligible);
          if (!target) throw new Error('Claude app page unavailable');
          if(guard&&['mcpReconnect','stop'].includes(request.nativeMethod)){const check=await target.executeJavaScript(`(async()=>{const s=await window['claude.web'].LocalSessions.getSession(${JSON.stringify(request.args[0])});return Boolean(s&&!s.isRunning&&!s.turnRunning);})()`,true);if(!check)throw Object.assign(Error('Worker refresh is deferred while its native session is busy'),{code:'REFRESH_DEFERRED_BUSY',status:503});}
          const expression = `(async()=>{const api=window['claude.web']?.LocalSessions;if(!api)throw new Error('Claude LocalSessions API unavailable');return JSON.stringify({result:await api[${JSON.stringify(request.nativeMethod)}](...${JSON.stringify(request.args)})});})()`;
          const value = await target.executeJavaScript(expression, true);
          socket.end(value + '\n');
        }
        else if (request.method === 'identity' || request.method === 'sessions' || request.method === 'maintenance') {
          const path = requireMain('node:path');
          const compatibility = config.manifest??JSON.parse(fs.readFileSync(config.compatibilityFile, 'utf8'));
          const manager = requireMain(path.join(app.getAppPath(), compatibility.sessionModule)).claudeCodeSessionManager;
          if(request.method==='maintenance'){const sessions=[...manager.sessions.values()];socket.end(JSON.stringify({authoritative:true,idle:sessions.every(s=>!s.isRunning&&!s.turnRunning&&!s.pendingPermissionRequest),binding:config.binding})+'\n');return;}
          if (request.method === 'sessions') {
            const list = await manager.getSessionList();
            socket.end(JSON.stringify({sessions:list.sessions.map(({sessionId,title,cwd,originCwd,model,effort,isRunning,turnRunning})=>({sessionId,title,cwd,originCwd,model,effort,isRunning,turnRunning}))})+'\n');
            return;
          }
          const sessions = [...manager.sessions.values()];
          if (!Number.isSafeInteger(request.pid) || request.pid <= 0) throw new Error('A positive worker PID is required');
          const workerPid = session => compatibility.workerPidField === 'cliPid' ? session.cliPid : session.query?.transport?.process?.pid;
          const matches = sessions.filter(session => workerPid(session) === request.pid);
          socket.end(JSON.stringify(matches.length === 1 ? { app: 'claude', threadId: matches[0].sessionId, evidence: 'desktop-native-worker-pid' } : { app: 'claude', needsThreadId: true, workerMatches: matches.length }) + '\n');
        }
        else if (request.method === 'reload') {
          if(guard)throw Object.assign(Error('Page refresh requires a separate idle maintenance operation'),{code:'REFRESH_DEFERRED_BUSY'});
          const target = webContents.getAllWebContents().find(eligible);
          if (!target) throw new Error('Claude app page unavailable');
          socket.end(JSON.stringify({ accepted: true, webContentsId: target.id }) + '\n'); target.reload();
        } else if (request.method === 'quit') {
          if(guard)throw Object.assign(Error('Application exit requires explicit desktop maintenance'),{code:'REFRESH_DEFERRED_BUSY'});
          socket.end(JSON.stringify({ accepted: true }) + '\n'); setImmediate(() => app.quit());
        } else throw new Error('Unsupported lifecycle operation');
      } catch (error) { socket.end(JSON.stringify({ error: error.message,code:error.code,status:error.status }) + '\n'); }
    });
  });
  server.on('error', () => {});
  server.listen(config.pipe);
  globalThis.__externalClaudeBridge = { binding:config.binding, revision: config.revision, status:()=>({...status(),binding:config.binding}), stop() { stopped = true; clearInterval(timer); app.removeListener('web-contents-created', created); server.close(); } };
  return JSON.stringify({ installed: true, pid: process.pid });
}
module.exports = install;
