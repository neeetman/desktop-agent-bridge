import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import operations from "../../src/compat/canary-operations.cjs";
import {
  probeCapabilities,
  certifiedCapabilities,
  checkExecutionOperation,
} from "../../src/compat/capability-checks.mjs";

test("a failed creation excludes permissions, but an independent reload still runs", async () => {
  const calls = [],
    updates = [];
  const checks = await probeCapabilities(
    "codex",
    async (method) => {
      calls.push(method);
      if (method === "create") throw Error("Outcome unknown");
      return {
        threadId: "dedicated",
        server: "desktop-bridge",
        verified: "tool-call",
      };
    },
    async () => {},
    (checks) => updates.push(structuredClone(checks)),
  );
  assert.deepEqual(calls, ["create", "mcp"]);
  assert.equal(updates[0].create.status, "attempting");
  assert.deepEqual(certifiedCapabilities("codex", checks), [
    "read",
    "send",
    "mcp",
  ]);
  assert.equal(checks.permissions.status, "skipped");
});
test("verified permission changes only apply within the accepted sandbox modes", () => {
  const input = {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    writableRoots: [],
  };
  assert.throws(
    () => checkExecutionOperation(["create"], "set_permissions", input),
    { code: "CAPABILITY_UNSUPPORTED" },
  );
  const caps = ["create", "permissions"];
  checkExecutionOperation(caps, "set_permissions", input);
  for (const override of [
    { sandboxMode: "danger-full-access" },
    { approvalPolicy: "never" },
    { writableRoots: ["elsewhere"] },
  ]) {
    assert.throws(
      () => checkExecutionOperation(caps, "prepare", { ...input, ...override }),
      { code: "CAPABILITY_UNSUPPORTED" },
    );
  }
  assert.throws(
    () =>
      certifiedCapabilities("codex", {
        permissions: { status: "passed", evidence: { threadId: "x" } },
      }),
    /restoration/,
  );
});
test("an automatically prepared validation chat supplies creation evidence without another write", async () => {
  const fixture = { threadId: "new-chat", cwd: "isolated-workspace" };
  const calls = [];
  const checks = await probeCapabilities("codex", async method => {
    calls.push(method);
    if (method === "mcp") throw Error("DEFERRED: protected desktop chat");
    return { threadId: fixture.threadId, changed: "workspace-write", restored: "read-only" };
  }, async () => {}, () => {}, fixture);
  assert.deepEqual(calls, ["permissions", "mcp"]);
  assert.deepEqual(checks.create.evidence, fixture);
  assert.deepEqual(certifiedCapabilities("codex", checks), ["read", "send", "create", "permissions"]);
});
test("Claude can create a validation chat without a previous session or touching protected chats", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "runtime/router"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime/router/protected-threads.json"), JSON.stringify({ threadIds: ["protected"] }));
  const fixture = operations({ root, app: "claude", runId: "new", expiresAt: Date.now() + 10000 }, createRequire(import.meta.url));
  const cwd = path.join(root, "runtime", "canary-workspaces", "new", "claude");
  let starts = 0;
  const renderer = async (method, args) => {
    if (method === "getSessionList") return { sessions: [{ sessionId: "protected", model: "haiku-test" }] };
    if (method === "start") {
      starts++;
      assert.equal(args[0].cwd, cwd);
      assert.match(args[0].message, /bridge_ack and, when requested, bridge_reply/);
      return { sessionId: "new-chat" };
    }
    assert.equal(method, "getSession");
    assert.deepEqual(args, ["new-chat"]);
    return { sessionId: "new-chat", cwd };
  };
  assert.deepEqual(await fixture.claude("create", renderer, null, null), { threadId: "new-chat", cwd });
  assert.equal(fixture.threadId(), "new-chat");
  await assert.rejects(fixture.claude("create", renderer, null, null), /already attempted/);
  assert.equal(starts, 1);
});
test("Codex reload requires idle, unprotected chats and a successful tool call on the exact test chat", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-reload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapterRoot = path.join(root, "adapter");
  fs.mkdirSync(adapterRoot);
  fs.writeFileSync(
    path.join(adapterRoot, "helper-binding.cjs"),
    "exports.loadedThreadIds=async()=>['dedicated']",
  );
  fs.writeFileSync(
    path.join(adapterRoot, "execution-policy.cjs"),
    "module.exports={}",
  );
  const config = {
    app: "codex",
    root,
    adapterRoot,
    threadId: "dedicated",
    runId: "fixture",
    expiresAt: Date.now() + 60_000,
  };
  const dir = path.join(root, "runtime/router");
  fs.mkdirSync(dir, { recursive: true });
  const protection = path.join(dir, "protected-threads.json");
  const req = createRequire(import.meta.url);
  let reloads = 0,
    busy = false,
    reported = "dedicated";
  const connection = {
    sendAppServerRequest: async (name) => {
      if (name === "config/mcpServer/reload") {
        reloads++;
        return {};
      }
      if (name === "mcpServerStatus/list")
        return {
          data: [{ name: "desktop-bridge", tools: { bridge_self: {} } }],
        };
      return {
        content: [
          {
            text: JSON.stringify({
              app: "codex",
              threadId: reported,
              worker: { status: "current" },
            }),
          },
        ],
      };
    },
  };
  const run = () => {
    const ops = operations(config, req);
    ops.bound(connection, {
      readThread: async () => ({
        thread: { status: { type: busy ? "active" : "idle" } },
      }),
      getThreadExecutionState: () => ({}),
      getConversation: () => ({}),
    });
    return ops.codex("mcp");
  };
  fs.writeFileSync(protection, JSON.stringify({ threadIds: ["protected"] }));
  await assert.rejects(run, /protected/);
  fs.writeFileSync(protection, JSON.stringify({ threadIds: [] }));
  busy = true;
  await assert.rejects(run, /active/);
  assert.equal(reloads, 0);
  busy = false;
  reported = "other";
  await assert.rejects(run, /lookup/);
  reported = "dedicated";
  assert.equal((await run()).verified, "tool-call");
});
test("Claude queued reconnect and an unconfirmed connection never grant the capability", async () => {
  const config = {
    app: "claude",
    root: os.tmpdir(),
    runId: "fixture",
    threadId: "dedicated",
    expiresAt: Date.now() + 60_000,
  };
  const go = (response, status) =>
    operations(config, createRequire(import.meta.url)).claude(
      "mcp",
      async () => response,
      {
        sessions: new Map([
          [
            "dedicated",
            {
              query: {
                mcpServerStatus: async () => [
                  { name: "desktop-bridge", status },
                ],
              },
            },
          ],
        ]),
      },
      {},
    );
  await assert.rejects(go({ queued: true }, "connected"), /DEFERRED/);
  await assert.rejects(go({}, "failed"), /not confirmed/);
  assert.equal((await go({}, "connected")).verified, "connected");
});
