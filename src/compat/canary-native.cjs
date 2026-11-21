// Runs in the existing Electron main thread. Advanced mutations are confined
// to the disposable fixture, or to the separately idle-checked MCP operation.
function attach(config, operations) {
  if (!process.mainModule) return JSON.stringify({ installed: false });
  const req = process.mainModule.require.bind(process.mainModule);
  const path = req("node:path");
  // Codex 26.1117+ runs its app server connection in a utility process.
  const runtime =
    config.app === "codex"
      ? req(path.join(config.adapterRoot, "codex-runtime.cjs"))
      : null;
  const wrongHost = runtime
    ? runtime.hostMismatch(config.manifest, process)
    : process.type === "browser"
      ? null
      : "not the desktop main process";
  if (wrongHost) return JSON.stringify({ installed: false, reason: wrongHost });
  const advanced = operations(config,req);
  if (!req("node:worker_threads").isMainThread)
    return JSON.stringify({ installed: false });
  const { app, webContents } = process.type === "browser" ? req("electron") : {};
  const net = req("node:net");
  const sock = net.connect(config.port, "127.0.0.1");
  const write = (value) => sock.write(JSON.stringify(value) + "\n");
  sock.on("error", () => sock.destroy());
  const expiry = setTimeout(() => sock.destroy(), config.duration);
  expiry.unref();
  sock.on("close", () => clearTimeout(expiry));
  // The validation channel is bound to the desktop main process; a helper in the
  // app server host reports its parent, which is that main process.
  const desktopPid = config.manifest?.host ? process.ppid : process.pid;
  sock.on("connect", () =>
    write({ token: config.token, pid: desktopPid, helperPid: process.pid }),
  );
  let buffer = "";
  async function call({ method, text }) {
    if (config.app === "codex") {
      if (method !== "probe") return advanced.codex(method);
      const manifest = config.manifest;
      const connection = await runtime.resolveConnection(manifest);
      const manager = await runtime.resolveManager(manifest, connection);
      advanced.bound(connection, manager);
      return { connected: true, helperPid: process.pid, transport: manager.kind };
    }
    const page = webContents
      .getAllWebContents()
      .filter(
        (x) =>
          !x.isDestroyed() &&
          /^(?:app:\/\/localhost|https:\/\/claude\.ai)\/epitaxy(?:[/?#]|$)/.test(
            x.getURL(),
          ),
      );
    if (page.length !== 1) throw Error("Expected one Claude session renderer");
    // Only use a module the desktop has already loaded.
    const loaded =
      req("node:module")._cache[
        path.join(app.getAppPath(), config.manifest.sessionModule)
      ];
    const manager = loaded?.exports?.claudeCodeSessionManager;
    if (!manager || typeof manager.getSessionList !== "function")
      throw Error("Live Claude session manager not found");
    async function renderer(method, args) {
      return page[0].executeJavaScript(
        'window["claude.web"].LocalSessions[' +
          JSON.stringify(method) +
          "](..." +
          JSON.stringify(args) +
          ")",
      );
    }
    const id = advanced.threadId();
    const s = id ? await renderer("getSession", [id]) : null;
    if (id && (s?.sessionId !== id || s.isArchived))
      throw Error("Claude test chat unavailable or archived");
    if (method === "probe") {
      const list = await manager.getSessionList();
      if (id && !list.sessions.some((x) => x.sessionId === id))
        throw Error("Test chat missing from native session list");
      const ok = await page[0].executeJavaScript(
        '["sendMessage","getTranscriptTail","getTranscriptPage"].every(k=>typeof window["claude.web"].LocalSessions[k]==="function")',
      );
      if (!ok) throw Error("Claude session method missing");
      return { connected: true, version: app.getVersion() };
    }
    if (method === "create") return advanced.claude(method, renderer, manager, s);
    if (!s) throw Error("Create a dedicated Claude validation chat first");
    if (method === "send") {
      if (s.turnRunning || s.isRunning || s.pendingPermissionRequest)
        throw Error("Test chat is busy");
      if (
        typeof text !== "string" ||
        !text.startsWith(
          "Desktop Bridge compatibility test " + config.runId + "\n",
        ) ||
        text.length > 1400
      )
        throw Error("Invalid challenge");
      const result = await renderer("sendMessage", [id, text]);
      if (result?.error) throw Error("Claude refused the challenge");
      return true;
    }
    if (method === "read") {
      const tail = await renderer("getTranscriptTail", [id, 80]);
      return {
        session: {
          sessionId: id,
          isRunning: s.isRunning,
          turnRunning: s.turnRunning,
        },
        messages: tail.messages
          .filter(
            (row) =>
              row.type === "user" ||
              row.type === "result" ||
              row.type === "assistant",
          )
          .map((row) => {
            const content = row.message?.content;
            return {
              type: row.type,
              uuid: row.uuid,
              isMeta: row.isMeta,
              timestamp: row.timestamp,
              subtype: row.subtype,
              is_error: row.is_error,
              result:
                typeof row.result === "string"
                  ? row.result.slice(0, 1500)
                  : undefined,
              message: {
                stop_reason: row.message?.stop_reason,
                content:
                  typeof content === "string"
                    ? content.slice(0, 1500)
                    : Array.isArray(content)
                      ? content.map((x) => ({
                          type: x.type,
                          text:
                            x.type === "text"
                              ? x.text.slice(0, 1500)
                              : undefined,
                        }))
                      : [],
              },
            };
          }),
      };
    }
    return advanced.claude(method,renderer,manager,s);
  }
  sock.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 8192) return sock.destroy();
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    call(request).then(
      (value) => write({ id: request.id, value }),
      (e) => write({ id: request.id, error: e.message }),
    );
  });
  return JSON.stringify({ installed: true });
}
module.exports = attach;
