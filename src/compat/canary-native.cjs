// Runs in the existing Electron main thread. The transient channel can only read
// the selected Claude chat and send a bounded validation challenge to that chat.
function attach(config) {
  if (process.type !== "browser") return JSON.stringify({ installed: false });
  const req = process.mainModule.require.bind(process.mainModule);
  if (!req("node:worker_threads").isMainThread)
    return JSON.stringify({ installed: false });
  const { app, webContents } = req("electron");
  const net = req("node:net"),
    path = req("node:path");
  const sock = net.connect(config.port, "127.0.0.1");
  const write = (value) => sock.write(JSON.stringify(value) + "\n");
  sock.on("error", () => sock.destroy());
  const expiry = setTimeout(() => sock.destroy(), config.duration);
  expiry.unref();
  sock.on("close", () => clearTimeout(expiry));
  sock.on("connect", () => write({ token: config.token, pid: process.pid }));
  let buffer = "";
  async function call({ method, text }) {
    if (config.app === "codex") {
      if (method !== "probe") throw Error("Unsupported validation method");
      const manifest = config.manifest;
      const ctor = await req(
        path.join(config.adapterRoot, "codex-runtime.cjs"),
      ).connectionConstructor(manifest);
      const session = new (req("node:inspector").Session)();
      session.connect();
      const post = (method, params) =>
        new Promise((resolve, reject) =>
          session.post(method, params, (e, v) => (e ? reject(e) : resolve(v))),
        );
      const key = "__bridgeCanary" + config.token;
      globalThis[key] = ctor.prototype;
      try {
        const proto = await post("Runtime.evaluate", {
          expression: "globalThis." + key,
        });
        const objects = await post("Runtime.queryObjects", {
          prototypeObjectId: proto.result.objectId,
        });
        const callback = await post("Runtime.callFunctionOn", {
          objectId: objects.objects.objectId,
          functionDeclaration:
            'function(){return this.find(x=>x.options?.hostId==="local"&&!x.disposed&&x.connectionState==="connected")?.options.getStatsigEvaluations}',
        });
        const props = await post("Runtime.getProperties", {
          objectId: callback.result.objectId,
        });
        const scopes = props.internalProperties.find(
          (p) => p.name === "[[Scopes]]",
        );
        const list = await post("Runtime.getProperties", {
          objectId: scopes.value.objectId,
          ownProperties: true,
        });
        for (const scope of list.result.filter((s) =>
          s.value?.description?.startsWith("Closure"),
        )) {
          const vars = await post("Runtime.getProperties", {
            objectId: scope.value.objectId,
            ownProperties: true,
          });
          const cls = vars.result.find(
            (v) =>
              v.name === manifest.managerClass && v.value?.type === "function",
          );
          if (!cls) continue;
          const prototype = await post("Runtime.callFunctionOn", {
            objectId: cls.value.objectId,
            functionDeclaration: "function(){return this.prototype}",
          });
          const instances = await post("Runtime.queryObjects", {
            prototypeObjectId: prototype.result.objectId,
          });
          const match = await post("Runtime.callFunctionOn", {
            objectId: instances.objects.objectId,
            functionDeclaration:
              'function(){return this.filter(x=>x.hostId==="local"&&!x.disposed&&["startConversation","getConversation","readThread","updateThreadSettingsForNextTurn"].every(k=>typeof x[k]==="function")).length}',
            returnByValue: true,
          });
          if (match.result.value === 1) return { connected: true };
        }
        throw Error("Unique live conversation manager unavailable");
      } finally {
        delete globalThis[key];
        session.disconnect();
      }
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
    const id = config.threadId;
    const s = await renderer("getSession", [id]);
    if (s?.sessionId !== id || s.isArchived)
      throw Error("Claude test chat unavailable or archived");
    if (method === "probe") {
      const list = await manager.getSessionList();
      if (!list.sessions.some((x) => x.sessionId === id))
        throw Error("Test chat missing from native session list");
      const ok = await page[0].executeJavaScript(
        '["start","sendMessage","getTranscriptTail","getTranscriptPage"].every(k=>typeof window["claude.web"].LocalSessions[k]==="function")',
      );
      if (!ok) throw Error("Claude session method missing");
      return { connected: true, version: app.getVersion() };
    }
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
    throw Error("Unsupported validation method");
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
