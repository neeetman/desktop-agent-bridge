// This function is serialized into Claude's main Node.js context.
function install(config) {
  if (process.type !== 'browser') return JSON.stringify({ installed: false, reason: 'not browser process' });
  if (globalThis.__externalClaudeBridge) {
    if (globalThis.__externalClaudeBridge.revision === config.revision) return JSON.stringify({ installed: true, reused: true, pid: process.pid });
    globalThis.__externalClaudeBridge.stop();
    delete globalThis.__externalClaudeBridge;
  }
  const requireMain = process.mainModule.require.bind(process.mainModule);
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
    } catch (error) { record.error = String(error.message ?? error).slice(0, 250); }
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
        if (request.method === 'status') socket.end(JSON.stringify(status()) + '\n');
        else if (request.method === 'native') {
          const allowed = new Set(['getSessionList','getSession','getTranscriptTail','getTranscriptPage','getDetectedProjects','getDefaultEffort','start','sendMessage','setModel','setEffort','warmSession','updateSession','mcpReconnect','stop']);
          if (!allowed.has(request.nativeMethod) || !Array.isArray(request.args)) throw new Error('Unsupported native API method or arguments');
          if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) throw new Error('Native request expired; refusing delayed execution');
          const target = webContents.getAllWebContents().find(eligible);
          if (!target) throw new Error('Claude app page unavailable');
          const expression = `(async()=>{const api=window['claude.web']?.LocalSessions;if(!api)throw new Error('Claude LocalSessions API unavailable');return JSON.stringify({result:await api[${JSON.stringify(request.nativeMethod)}](...${JSON.stringify(request.args)})});})()`;
          const value = await target.executeJavaScript(expression, true);
          socket.end(value + '\n');
        }
        else if (request.method === 'identity' || request.method === 'sessions') {
          const path = requireMain('node:path');
          const compatibility = JSON.parse(fs.readFileSync(config.compatibilityFile, 'utf8'));
          const manager = requireMain(path.join(app.getAppPath(), compatibility.sessionModule)).claudeCodeSessionManager;
          if (request.method === 'sessions') {
            const list = await manager.getSessionList();
            socket.end(JSON.stringify({sessions:list.sessions.map(({sessionId,title,cwd,originCwd,model,effort,isRunning,turnRunning})=>({sessionId,title,cwd,originCwd,model,effort,isRunning,turnRunning}))})+'\n');
            return;
          }
          const sessions = [...manager.sessions.values()];
          const matches = sessions.filter(session => session.query?.transport?.process?.pid === request.pid);
          socket.end(JSON.stringify(matches.length === 1 ? { app: 'claude', threadId: matches[0].sessionId, evidence: 'desktop-native-worker-pid' } : { app: 'claude', needsThreadId: true, workerMatches: matches.length }) + '\n');
        }
        else if (request.method === 'reload') {
          const target = webContents.getAllWebContents().find(eligible);
          if (!target) throw new Error('Claude app page unavailable');
          socket.end(JSON.stringify({ accepted: true, webContentsId: target.id }) + '\n'); target.reload();
        } else if (request.method === 'quit') {
          socket.end(JSON.stringify({ accepted: true }) + '\n'); setImmediate(() => app.quit());
        } else throw new Error('Unsupported lifecycle operation');
      } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
    });
  });
  server.on('error', () => {});
  server.listen(config.pipe);
  globalThis.__externalClaudeBridge = { revision: config.revision, status, stop() { stopped = true; clearInterval(timer); app.removeListener('web-contents-created', created); server.close(); } };
  return JSON.stringify({ installed: true, pid: process.pid });
}
module.exports = install;
