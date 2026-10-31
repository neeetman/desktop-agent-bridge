export async function bootstrap(root, relative, token, allowedMethods, controllerId) {
  const api = window['claude.web']?.LocalSessions;
  const controller = controllerId;
  if (!api || !controller) throw new Error('Native API/control-session ID unavailable');
  window.__claudeGuiRelay?.stop();
  delete window.__claudeGuiRelay;
  // Cold starts hydrate persisted LocalSessions asynchronously. Do not report
  // attachment ready before its controller and native watcher are available.
  await api.getSessionList();
  if (!await api.getSession(controller)) throw new Error('Native control session no longer exists');
  const allowed = new Set(allowedMethods);
  let busy = false, stopped = false, lastId, lastHeartbeat = 0, rerun = false;
  const read = async file => {
    const result = await api.readFileAtCwd(root, `${relative}/${file}`);
    const text = typeof result === 'string' ? result : result?.contents;
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  };
  const write = (file, value) => api.writeSessionFile(controller, `${relative}/${file}`, JSON.stringify(value));
  const tick = async () => {
    if (stopped) return;
    if (busy) { rerun = true; return; }
    busy = true;
    try {
      if (Date.now() - lastHeartbeat > 5000) { await write('heartbeat.json', { time: Date.now(), controller }); lastHeartbeat = Date.now(); }
      const request = await read('request.json');
      if (!request || request.id === lastId || request.token !== token) return;
      const previous = await read('response.json');
      if (previous?.id === request.id) { lastId = request.id; return; }
      const inflight = await read('inflight.json');
      if (inflight?.id === request.id) { lastId = request.id; await write('response.json', { id: request.id, error: 'Earlier native operation outcome unknown; refusing automatic replay' }); return; }
      lastId = request.id;
      try {
        if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) throw new Error('Native request expired; refusing delayed execution after reconnect');
        if (!allowed.has(request.method)) throw new Error('Unsupported native method');
        await write('inflight.json', { id: request.id });
        const result = await api[request.method](...request.args);
        await write('response.json', { id: request.id, result });
      } catch (error) { await write('response.json', { id: request.id, error: String(error.message ?? error) }); }
    } catch (error) { console.warn('Claude bridge file transport:', error.message); }
    finally { busy = false; if (rerun) { rerun = false; queueMicrotask(tick); } }
  };
  const unsubscribe = api.onSessionDirectoryChanged((sessionId) => { if (sessionId === controller) void tick(); });
  const watchId = 'external-claude-gui-relay';
  try { await api.watchSessionDirectories({ sessionId: controller, watchId, dirPaths: [relative] }); }
  catch (error) { unsubscribe(); throw error; }
  await tick();
  const timer = setInterval(tick, 5000);
  window.__claudeGuiRelay = { stop() { stopped = true; clearInterval(timer); unsubscribe(); void api.watchSessionDirectories({ sessionId: controller, watchId, dirPaths: [] }); } };
  return 'Claude native file relay initialized';
}
