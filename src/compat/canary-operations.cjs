// Serialized into the temporary main-process probe. Only fixture operations are exposed.
module.exports = function operations(config, req) {
  const fs = req("node:fs"),
    path = req("node:path");
  const cwd = path.join(
    config.root,
    "runtime",
    "canary-workspaces",
    config.runId,
    config.app,
  );
  let created, connection, manager;
  const used = new Set();
  const title = "Bridge capability test " + config.runId.slice(0, 8);
  const setupPrompt = [
    "This chat is dedicated to the user's local Desktop Bridge validation run " + config.runId + ".",
    "For later Desktop Bridge compatibility test messages for this run, you are authorized to call desktop-bridge MCP bridge_ack and, when requested, bridge_reply with the exact test message ID and marker, then output the requested final marker.",
    "This authorization covers only these test receipts. Do not edit files or perform other work. Reply only READY to this setup message.",
  ].join("\n");
  function guard(id, global = false) {
    if (Date.now() >= config.expiresAt)
      throw Error("Validation window expired");
    let protectedIds = [];
    try {
      protectedIds = JSON.parse(
        fs.readFileSync(
          path.join(config.root, "runtime/router/protected-threads.json"),
        ),
      ).threadIds;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (global ? protectedIds.length : protectedIds.includes(id))
      throw Error("DEFERRED: protected desktop chat");
  }
  function once(op) {
    if (used.has(op)) throw Error("Mutation already attempted");
    used.add(op);
  }
  function workspace() {
    fs.mkdirSync(cwd, { recursive: true });
    return cwd;
  }
  function bound(c, m) {
    connection = c;
    manager = m;
  }
  async function codex(method) {
    if (!manager || !connection) throw Error("Live Codex probe required");
    const policy = req(path.join(config.adapterRoot, "execution-policy.cjs"));
    const sandbox = (mode) => ({
      sandboxMode: mode,
      approvalPolicy: "on-request",
      writableRoots: [],
    });
    const permissions = (mode) => policy.nativePermissions(sandbox(mode), cwd);
    const idle = async (id) => {
      guard(id);
      const row = await manager.readThread(id, { includeTurns: false });
      if (
        row.thread?.status?.type !== "idle" ||
        manager.getThreadExecutionState(id)?.inProgress ||
        manager.getConversation(id)?.requests?.length
      )
        throw Error("DEFERRED: Codex chat active or awaiting approval");
    };
    if (method === "create") {
      guard(config.threadId);
      once(method);
      workspace();
      const r = await manager.startConversation(
        {
          input: config.threadId ? [] : [{ type: "text", text: setupPrompt, text_elements: [] }],
          cwd,
          workspaceRoots: [cwd],
          workspaceKind: "projectless",
          initialTitle: title,
          mode: "default",
          threadSource: "user",
          threadStartKind: "default",
          permissionsConfig: permissions("read-only"),
          config: policy.nativeConfig(sandbox("read-only")),
        },
        {
          readThreadCreationInputs: async () => ({
            hasDesktopRuntime: true,
            hasLocalRuntime: true,
            hasDeveloperInstructions: true,
            isBrowserRuntime: false,
            usesDesktopMcp: manager.settings.usesDesktopMcp,
            readDynamicTools: manager.settings.readDynamicTools,
            sidebarSectionToolsEnabled: true,
            everydayWork: false,
          }),
        },
      );
      if (
        r.status !== "created" ||
        !r.conversationId ||
        r.conversationId === config.threadId
      )
        throw Error("Unexpected Codex creation result");
      created = r.conversationId;
      let row;
      const deadline = Math.min(config.expiresAt, Date.now() + 15000);
      while (!row) {
        try {
          row = await manager.readThread(created, { includeTurns: false });
        } catch (error) {
          // Starting the setup turn can expose a rollout before its first row
          // has been flushed. Read it again, keeping the original native ID.
          const pendingRollout = error.message.includes(created) &&
            error.message.includes("failed to read session metadata") &&
            error.message.includes("is empty");
          if (config.threadId || !pendingRollout || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      if (
        row.thread?.id !== created ||
        path.resolve(row.thread.cwd) !== path.resolve(cwd)
      )
        throw Error("Created Codex chat identity or workspace mismatch");
      return { threadId: created, cwd };
    }
    if (method === "permissions") {
      if (!created) throw Error("No disposable chat for permission test");
      await idle(created);
      once(method);
      const chat = manager.getConversation(created);
      const resumed = await manager.resumeConversation(
        {
          conversationId: created,
          cwd,
          workspaceRoots: [cwd],
          model: chat?.latestModel ?? null,
          reasoningEffort: chat?.latestReasoningEffort ?? null,
          permissions: permissions("read-only"),
          collaborationMode: chat?.latestCollaborationMode ?? null,
        },
        {
          readResumeInputs: async ({ model, cwd }) =>
            manager.settings.readSettings(model, cwd),
        },
      );
      if (resumed.status === "not-ready")
        throw Error("Disposable Codex chat could not resume");
      await idle(created);
      async function set(mode) {
        const native = permissions(mode),
          applied = await manager.updateThreadSettingsForNextTurn(created, {
            cwd,
            ...native,
            permissions: null,
          });
        let settings;
        for (let i = 0; i < 20; i++) {
          settings = manager.getConversation(created)?.latestThreadSettings;
          if (
            applied !== false &&
            settings?.sandboxPolicy?.type === native.sandboxPolicy.type &&
            settings.approvalPolicy === native.approvalPolicy
          )
            return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error(
          "Next-turn permission readback failed: wanted " +
            mode +
            ", observed " +
            settings?.sandboxPolicy?.type +
            " / " +
            settings?.approvalPolicy +
            " (applied " +
            applied +
            ")",
        );
      }
      await set("read-only");
      try {
        await set("workspace-write");
      } finally {
        await set("read-only");
      }
      return {
        threadId: created,
        changed: "workspace-write",
        restored: "read-only",
      };
    }
    if (method === "mcp") {
      guard(null, true);
      const threadId = config.threadId ?? created;
      const loaded = await req(
        path.join(config.adapterRoot, "helper-binding.cjs"),
      ).loadedThreadIds(connection);
      for (const id of loaded) await idle(id);
      const request = (name, args) =>
        connection.sendAppServerRequest(name, args);
      guard(null, true);
      once(method);
      await request("config/mcpServer/reload", undefined);
      const servers = await request("mcpServerStatus/list", {
        threadId,
        serverName: "desktop-bridge",
        detail: "toolsAndAuthOnly",
        limit: 20,
      });
      if (
        !servers.data?.some(
          (server) =>
            server.name === "desktop-bridge" && server.tools?.bridge_self,
        )
      )
        throw Error("MCP tool missing after reload");
      const result = await request("mcpServer/tool/call", {
        threadId,
        server: "desktop-bridge",
        tool: "bridge_self",
        arguments: {},
        _meta: { threadId, thread_id: threadId },
      });
      if (
        result.isError ||
        !result.content?.some((x) => {
          try {
            const who = JSON.parse(x.text);
            return (
              who.app === "codex" &&
              who.threadId === threadId &&
              who.worker?.status === "current"
            );
          } catch {
            return false;
          }
        })
      )
        throw Error("MCP self lookup failed after reload");
      return {
        threadId,
        server: "desktop-bridge",
        verified: "tool-call",
      };
    }
    throw Error("Unsupported validation method");
  }
  async function claude(method, renderer, manager, session) {
    const threadId = config.threadId ?? created;
    guard(threadId);
    if (method === "create") {
      once(method);
      workspace();
      const list = await renderer("getSessionList", []);
      const before = new Set(list.sessions.map((s) => s.sessionId));
      const model =
        session?.model ||
        list.sessions.find((s) => !s.isArchived && /haiku/i.test(s.model ?? ""))?.model ||
        list.sessions.find((s) => !s.isArchived && s.model)?.model;
      if (!model) throw Error("No desktop model available");
      const result = await renderer("start", [
        {
          cwd,
          model,
          title,
          useWorktree: false,
          message: config.threadId
            ? "Desktop bridge session creation test. Reply only OK. Do not use tools."
            : setupPrompt,
        },
      ]);
      const id = result?.sessionId;
      if (!id || before.has(id)) throw Error("No fresh Claude chat ID");
      const row = await renderer("getSession", [id]);
      if (
        row?.sessionId !== id ||
        path.resolve(row.originCwd || row.cwd) !== path.resolve(cwd)
      )
        throw Error("Claude chat workspace readback failed");
      created = id;
      return { threadId: id, cwd };
    }
    if (method === "mcp") {
      if (
        session.isRunning ||
        session.turnRunning ||
        session.pendingPermissionRequest
      )
        throw Error("DEFERRED: Claude test chat busy");
      const live = manager.sessions.get(threadId);
      if (!live?.query || live.pendingPermissionRequest)
        throw Error("DEFERRED: idle Claude worker unavailable");
      once(method);
      const result = await renderer("mcpReconnect", [
        threadId,
        "desktop-bridge",
      ]);
      if (result?.error || result?.queued)
        throw Error(
          result?.error?.includes("Click Connect first")
            ? "DEFERRED: Claude requires Connect for this server"
            : result.error || "DEFERRED: reconnect queued",
        );
      const servers = await live.query.mcpServerStatus();
      if (
        !servers.some(
          (s) => s.name === "desktop-bridge" && s.status === "connected",
        )
      )
        throw Error("Reconnected Claude server not confirmed");
      return {
        threadId,
        server: "desktop-bridge",
        verified: "connected",
      };
    }
    throw Error("Unsupported validation method");
  }
  return { bound, codex, claude, threadId: () => config.threadId ?? created };
};
