import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  atomicJson,
  coordinator,
  ROOT,
  readJson,
  adapterDigest,
} from "./compatibility.mjs";
import { discover } from "./discover.mjs";
import { openChannel } from "./canary-channel.mjs";
import { DesktopTools } from "../adapters/codex/native.mjs";
import { claudeTurns } from "../adapters/claude/claude-native.mjs";

const router = path.join(ROOT, "runtime/router");
const duration = 8 * 60 * 1000;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export function checkThreads(threads, protectedIds) {
  for (const [app, prefix] of [
    ["codex", ""],
    ["claude", "local_"],
  ]) {
    if (
      !new RegExp("^" + prefix + uuid + "$", "i").test(threads[app]) ||
      protectedIds.includes(threads[app])
    )
      throw Error(
        "An exact, unprotected " + app + " validation chat is required",
      );
  }
}

export function confirmedTurn(snapshot, baseline, row, final) {
  const fresh = snapshot.turns.filter((t) => !baseline.has(t.id));
  if (fresh.length > 1) throw Error("Test chat received concurrent input");
  const turn = fresh[0];
  if (!turn) return null;
  if (["failed", "interrupted", "cancelled"].includes(turn.status))
    throw Error("Native test turn " + turn.status);
  if (turn.status !== "completed") return null;
  const text = turn.items
    ?.filter((x) => x.type === "agentMessage" && x.phase === "final_answer")
    .map((x) => x.text)
    .join("\n")
    .trim();
  if (
    text !== final ||
    !turn.id ||
    !row.acknowledgedAt ||
    (row.expectReply && !row.repliedAt)
  )
    throw Error(
      "Completed turn lacks the exact final marker or explicit MCP receipt",
    );
  return turn.id;
}

async function assertBuild(candidate) {
  const name = candidate.profile.app;
  let now = (await coordinator.doctor(name)).apps[name];
  // A genuine second-instance wake briefly appears in process inventory.
  for (let i = 0; now.code === "AMBIGUOUS_DESKTOP" && i < 10; i++) {
    await sleep(350);
    now = (await coordinator.doctor(name)).apps[name];
  }
  const b = now.runningBuild,
    old = candidate.build;
  if (
    (now.code && now.code !== "BUILD_UNSUPPORTED") ||
    b?.pid !== old.pid ||
    b.createdAt !== old.createdAt ||
    b.executable !== old.executable ||
    Object.keys(old.hashes).some((k) => old.hashes[k] !== b.hashes[k])
  )
    throw Error("Desktop changed during validation");
}

export async function certify(app, threads) {
  const protection = () =>
    checkThreads(
      threads,
      readJson(path.join(router, "protected-threads.json"), { threadIds: [] })
        .threadIds,
    );
  protection();
  const conn = readJson(path.join(router, "connection.json"));
  const base = new URL(conn.baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1")
    throw Error("Local validation router required");
  const health = await fetch(new URL("/health", base), {
    headers: { Authorization: "Bearer " + conn.token },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!health.ok || (await health.json()).canaryProtocol !== 1)
    throw Error("Restart the updated peer router before running validation");
  const runId = randomUUID(),
    folder = path.join(router, "canary", runId),
    expiresAt = Date.now() + duration;
  const lock = path.join(router, "canary", "runner.json");
  const channels = {},
    receipts = [];
  let tools;
  await coordinator.locked(() => {
    const owner = readJson(lock, null);
    if (owner && owner.expiresAt > Date.now() && coordinator.alive(owner.pid))
      throw Error("Another validation is in progress");
    atomicJson(lock, { runId, expiresAt, pid: process.pid });
  });
  fs.mkdirSync(folder, { recursive: true });
  const report = { runId, app, stage: "discovery", receipts };
  const save = () => atomicJson(path.join(folder, "report.json"), report);
  try {
    save();
    const candidates = {};
    for (const name of ["claude", "codex"]) {
      candidates[name] = await discover(name);
      report[name] = {
        profile: candidates[name].profile.id,
        hashes: candidates[name].build.hashes,
        pid: candidates[name].build.pid,
      };
    }
    report.stage = "native-probe";
    save();
    for (const name of ["codex", "claude"]) {
      report.stage = "native-probe-" + name;
      save();
      channels[name] = await openChannel(
        candidates[name],
        threads[name],
        runId,
        duration,
      );
      const probe = await channels[name].call("probe");
      if (!probe.connected) throw Error(name + " native probe failed");
      if (name === "claude")
        candidates[name].profile.manifests.claude.desktopVersion =
          probe.version;
    }
    tools = new DesktopTools(
      undefined,
      readJson(path.join(ROOT, "runtime/connection.json")).callerThread,
      {
        guardRuntime: (_app, _cap, op) =>
          op({ binding: { activationEpoch: 1, generation: runId } }),
      },
    );
    if (tools.isExecutionManaged(threads.codex))
      throw Error(
        "Choose a dedicated Codex test chat without managed execution settings",
      );
    async function read(name) {
      if (name === "codex")
        return tools.rawCall("read_thread", {
          threadId: threads.codex,
          hostId: "local",
          turnLimit: 4,
          maxOutputCharsPerItem: 1500,
        });
      const { session, messages } = await channels.claude.call("read");
      return {
        thread: {
          id: session.sessionId,
          status: {
            type: session.isRunning || session.turnRunning ? "active" : "idle",
          },
        },
        turns: claudeTurns(messages, session).reverse().slice(0, 4),
      };
    }
    function idle(snapshot, name) {
      if (
        snapshot.thread?.id !== threads[name] ||
        snapshot.thread.archived ||
        !["idle", "notLoaded"].includes(snapshot.thread.status?.type) ||
        snapshot.turns?.[0]?.status === "inProgress"
      )
        throw Error(name + " test chat is unavailable or busy");
    }
    for (const name of ["codex", "claude"]) idle(await read(name), name);
    fs.writeFileSync(path.join(folder, "open"), "1", { flag: "wx" });
    let previous;
    for (const [i, name] of ["claude", "codex", "claude"].entries()) {
      const peer = name === "codex" ? "claude" : "codex",
        step = i + 1,
        id = "canary-" + runId + "-" + step;
      const file = path.join(folder, step + ".json"),
        expectReply = step < 3;
      const expected = "RECEIVED_" + randomUUID(),
        final = "DONE_" + randomUUID();
      const row = {
        id,
        from: { app: peer, threadId: threads[peer] },
        to: { app: name, threadId: threads[name] },
        kind: i ? "reply" : "message",
        replyTo: previous?.id ?? null,
        expectReply,
        expected,
        expiresAt,
      };
      const prompt = [
        "Desktop Bridge compatibility test " + runId,
        "Dedicated chat " + threads[name] + ". Message ID " + id + ".",
        previous
          ? "Reply to " + previous.id + " from " + peer + ": " + previous.text
          : "New request from the dedicated Codex validation chat.",
        "Use desktop-bridge MCP bridge_ack with that messageId and fromThreadId " +
          threads[name] +
          ".",
        expectReply
          ? "Then call bridge_reply once with the SAME messageId and exact text " +
            expected +
            "."
          : "This is the final receipt. Do not call bridge_reply.",
        "After the MCP call(s) succeed, output only " +
          final +
          ". Do not modify files or run any other task.",
      ].join("\n");
      protection();
      await assertBuild(candidates[name]);
      if (name === "codex" || i === 0) {
        const listed = await tools.rawCall("list_threads", { limit: 50 });
        if (
          ![...(listed.pinnedThreads ?? []), ...(listed.threads ?? [])].some(
            (t) =>
              t.id === threads.codex &&
              t.hostId === "local" &&
              t.kind === "codex",
          )
        )
          throw Error(
            "Pin or open the dedicated non-archived local Codex chat before validation",
          );
      }
      const snapshot = await read(name);
      idle(snapshot, name);
      if (Date.now() >= expiresAt)
        throw Error("Validation window expired before dispatch");
      const baseline = new Set(snapshot.turns.map((t) => t.id));
      atomicJson(file, row);
      report.stage = "dispatch-" + step;
      save(); // Persist before crossing the write boundary; never replay.
      if (name === "claude") await channels.claude.call("send", prompt);
      else
        await tools.rawCall("send_message_to_thread", {
          threadId: threads.codex,
          hostId: "local",
          prompt,
        });
      report.stage = "await-receipt-" + step;
      save();
      let turnId;
      while (Date.now() < expiresAt) {
        const latest = await read(name),
          receipt = readJson(file);
        turnId = confirmedTurn(latest, baseline, receipt, final);
        if (turnId) {
          previous = { id, text: receipt.replyText };
          receipts.push({
            id,
            to: row.to,
            from: row.from,
            replyTo: row.replyTo,
            turnId,
            acknowledgedAt: receipt.acknowledgedAt,
            repliedAt: receipt.repliedAt,
          });
          save();
          break;
        }
        await sleep(1200);
      }
      if (!turnId)
        throw Error(
          "Validation receipt timed out; inspect the recorded run before starting another",
        );
    }
    for (const c of Object.values(candidates)) await assertBuild(c);
    const packages = {};
    for (const [name, c] of Object.entries(candidates)) {
      const p = c.profile;
      if (adapterDigest(c.adapterRoot, p.adapterFiles) !== p.adapterDigest)
        throw Error("Candidate adapter changed during validation");
      p.id = p.id.replace(/-candidate$/, "-msg-" + runId.slice(0, 8));
      p.capabilities = ["read", "send"];
      p.evidence = {
        baseline:
          "Native probes and three addressed MCP receipts on dedicated desktop chats",
        stage: "messaging-verified",
        runId,
        validated: ["read", "send"],
        seed: p.evidence.seed,
      };
      packages[name] = { folder: c.folder, profileId: p.id };
    }
    for (const c of Object.values(candidates))
      atomicJson(path.join(c.folder, "profile.json"), c.profile);
    const c = candidates[app],
      p = c.profile;
    report.stage = "passed";
    report.packages = packages;
    save();
    return {
      passed: true,
      package: c.folder,
      profileId: p.id,
      packages,
      report: path.join(folder, "report.json"),
      receipts,
    };
  } catch (error) {
    report.failedAt = report.stage;
    report.stage = "failed";
    report.error = error.message;
    save();
    throw Error(
      error.message + " (report: " + path.join(folder, "report.json") + ")",
    );
  } finally {
    fs.rmSync(path.join(folder, "open"), { force: true });
    for (const ch of Object.values(channels)) ch.close();
    tools?.close();
    await coordinator.locked(() => {
      if (readJson(lock, null)?.runId === runId)
        fs.rmSync(lock, { force: true });
    });
  }
}
