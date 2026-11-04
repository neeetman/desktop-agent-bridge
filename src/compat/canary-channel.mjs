import net from "node:net";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT, readJson } from "./compatibility.mjs";
import attach from "./canary-native.cjs";
import operations from "./canary-operations.cjs";

export async function openChannel(candidate, threadId, runId, duration) {
  const token = randomBytes(24).toString("hex"),
    pending = new Map(),
    sockets = new Set();
  let socket, accept, fail;
  const ready = new Promise((resolve, reject) => {
    accept = resolve;
    fail = reject;
  });
  const server = net.createServer((peer) => {
    sockets.add(peer);
    peer.on("close", () => {
      sockets.delete(peer);
      if (peer === socket)
        for (const item of pending.values())
          item.reject(Error("Desktop canary disconnected"));
    });
    peer.on("error", () => peer.destroy());
    peer.setEncoding("utf8");
    let data = "";
    peer.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) return peer.destroy();
      let end;
      while ((end = data.indexOf("\n")) >= 0) {
        let msg;
        try {
          msg = JSON.parse(data.slice(0, end));
        } catch {
          return peer.destroy();
        }
        data = data.slice(end + 1);
        if (peer !== socket) {
          if (socket || msg.token !== token || msg.pid !== candidate.build.pid)
            return peer.destroy();
          socket = peer;
          accept();
        } else {
          const item = pending.get(msg.id);
          if (item)
            msg.error ? item.reject(Error(msg.error)) : item.resolve(msg.value);
        }
      }
    });
  });
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", r);
  });
  const app = candidate.profile.app;
  const config = {
    app,
    threadId,
    token,
    runId,
    duration,
    root:ROOT,
    expiresAt:Date.now()+duration,
    port: server.address().port,
    adapterRoot: candidate.adapterRoot,
    manifest:
      candidate.profile.manifests[app === "claude" ? "claude" : "execution"],
  };
  const python =
    readJson(path.join(ROOT, "runtime/supervisor/config.json"), {}).python ||
    "python";
  const child = spawn(
    python,
    [path.join(ROOT, "scripts/runtime/canary_attach.py")],
    { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
  );
  let error = "";
  child.stderr.on("data", (chunk) => {
    error = (error + chunk).slice(-1000);
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.once("exit", (code) => {
    if (code !== 0)
      fail(
        Error(
          "Native validation attachment failed: " +
            error.trim().split("\n").at(-1),
        ),
      );
  });
  child.stdin.end(
    JSON.stringify({
      build: candidate.build,
      adapterRoot: candidate.adapterRoot,
      code: "(" + attach.toString() + ")(" + JSON.stringify(config) + ","+operations.toString()+")",
    }),
  );
  const close = () => {
    for (const peer of sockets) peer.destroy();
    server.close();
    if (child.exitCode === null) child.kill();
  };
  const timeout = setTimeout(
    () => fail(Error("Desktop validation channel timed out")),
    50000,
  );
  try {
    await ready;
  } catch (e) {
    close();
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  async function call(method, text) {
    if (socket.destroyed) throw Error("Desktop validation channel closed");
    const id = randomUUID();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Validation " + method + " timed out")),
          ["create","permissions","mcp"].includes(method)?85000:18000,
        );
        pending.set(id, { resolve, reject });
        socket.write(JSON.stringify({ id, method, text }) + "\n");
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  return { close, call };
}
