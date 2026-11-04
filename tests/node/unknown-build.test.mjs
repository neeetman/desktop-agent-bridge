import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { locate, discover } from "../../src/compat/discover.mjs";
import {
  Compatibility,
  adapterDigest,
  validateProfile,
} from "../../src/compat/compatibility.mjs";
import { canaryReceipt } from "../../src/compat/canary-receipts.mjs";
import { checkThreads, confirmedTurn } from "../../src/compat/certify.mjs";
import { unknownPair } from "../../src/compat/canary-watch.mjs";

const webpack =
  "exports.modules={104(a){class Q{sendAppServerRequest(){} registerInternalNotificationHandler(){} readThread(){}}},207(){class Renamed{addConversationStateCallback(){} getConversation(){} startConversation(){} resumeConversation(){} addApprovalRequestListener(){}}}}";
test("renamed classes, module numbers and chunk paths are extracted without executing desktop code", () => {
  const file = ".vite/build/new.js",
    source = 'throw Error("must never execute");' + webpack;
  assert.deepEqual(locate("codex", [[file, source]]), {
    connectionModule: file,
    connectionModuleId: 104,
    managerModuleId: 207,
    managerClass: "Renamed",
  });
  assert.throws(
    () =>
      locate("codex", [
        [file, source],
        ["second", source],
      ]),
    /2 matches/,
  );
  assert.throws(
    () =>
      locate("codex", [
        [file, source.replace("startConversation", "startSomethingElse")],
      ]),
    /0 matches/,
  );
  assert.throws(
    () =>
      locate("claude", [
        [file, 'const cliPid="exports.claudeCodeSessionManager"'],
      ]),
    /0 matches/,
  );
});
test("a previously unknown installed build becomes a quarantined candidate without entering the catalog", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-candidate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(
    root,
    "Claude_9.8.7.0_x64__test",
    "app",
    "resources",
  );
  fs.mkdirSync(resources, { recursive: true });
  const source =
    "let manager,cliPid; exports.claudeCodeSessionManager=manager;";
  const header = Buffer.from(
    JSON.stringify({
      files: {
        ".vite": {
          files: {
            build: {
              files: { "new.js": { offset: "0", size: source.length } },
            },
          },
        },
      },
    }),
  );
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(header.length + 8, 4);
  prefix.writeUInt32LE(header.length, 12);
  fs.writeFileSync(
    path.join(resources, "app.asar"),
    Buffer.concat([prefix, header, Buffer.from(source)]),
  );
  fs.writeFileSync(path.join(resources, "../Claude.exe"), "fixture");
  fs.mkdirSync(path.join(root, "compat"));
  const baseline = new Compatibility()
    .profiles()
    .filter((x) => x.profile.app === "claude" && !x.profile.revoked)
    .at(-1);
  const seed = baseline.profile;
  fs.writeFileSync(path.join(root, "compat/seed.json"), JSON.stringify(seed));
  fs.writeFileSync(
    path.join(root, "compat/catalog.json"),
    JSON.stringify({ schemaVersion: 1, profiles: ["compat/seed.json"] }),
  );
  for (const name of seed.adapterFiles) {
    const { sourcePath } = await import("../../src/lib/paths.mjs");
    fs.copyFileSync(
      sourcePath(baseline.adapterRoot, name),
      path.join(root, name),
    );
  }
  const inventory = async () => ({
    installed: [],
    processes: [
      {
        app: "claude",
        executable: path.join(resources, "../Claude.exe"),
        pid: 1,
        createdAt: "fixture",
      },
    ],
  });
  const service = new Compatibility(root, { inventory });
  const candidate = await discover("claude", { service, root });
  assert.equal(candidate.profile.packageVersion, "9.8.7.0");
  assert.equal(
    candidate.profile.manifests.claude.sessionModule,
    ".vite/build/new.js",
  );
  assert.equal(
    adapterDigest(candidate.adapterRoot, seed.adapterFiles),
    seed.adapterDigest,
  );
  assert.equal(
    (await service.doctor("claude")).apps.claude.code,
    "BUILD_UNSUPPORTED",
  );
  assert.equal(
    fs.existsSync(path.join(candidate.folder, "profile.json")),
    false,
  );
  assert.throws(() => validateProfile(candidate.profile), /live validation/);
});
test("validation receipt requires the addressed chat, open run, unexpired nonce and explicit ack before reply", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "validation-receipt-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = randomUUID(),
    folder = path.join(directory, "canary", run),
    id = "canary-" + run + "-1";
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "open"), "1");
  const to = { app: "claude", threadId: "local_" + randomUUID() },
    row = {
      id,
      to,
      expected: "r",
      expectReply: true,
      expiresAt: Date.now() + 60000,
    };
  const file = path.join(folder, "1.json");
  fs.writeFileSync(file, JSON.stringify(row));
  const call = (route, data) =>
    canaryReceipt(directory, "/v1/" + route, {
      messageId: id,
      from: to,
      text: "r",
      ...data,
    });
  assert.throws(
    () => call("ack", { from: { ...to, threadId: "other" } }),
    /addressed/,
  );
  assert.throws(() => call("reply"), /acknowledged/);
  assert.equal(call("ack").acknowledgedAt, call("ack").acknowledgedAt);
  assert.throws(() => call("reply", { text: "wrong" }), /match/);
  assert.equal(call("reply").messageId, id);
  assert.equal(JSON.parse(fs.readFileSync(file)).replyText, "r");
  fs.writeFileSync(file, JSON.stringify({ ...row, expiresAt: 0 }));
  assert.throws(() => call("ack"), /closed/);
  fs.unlinkSync(path.join(folder, "open"));
  assert.throws(() => call("message", { id }), /closed/);
  assert.equal(call("ack", { messageId: "regular-message" }), null);
});
test("only one new completed native turn with exact marker and all required MCP receipts passes", () => {
  const turns = [
    {
      id: "new",
      status: "completed",
      items: [{ type: "agentMessage", phase: "final_answer", text: "marker" }],
    },
  ];
  const row = { acknowledgedAt: "now", expectReply: true, repliedAt: "now" },
    baseline = new Set(["old"]);
  const check = (t, r = row) =>
    confirmedTurn({ turns: t }, baseline, r, "marker");
  assert.equal(check(turns), "new");
  assert.equal(check([{ ...turns[0], id: "old" }]), null);
  assert.throws(() => check([...turns, { id: "unrelated" }]), /concurrent/);
  assert.throws(() => check(turns, { ...row, repliedAt: null }), /receipt/);
  assert.throws(() => check([{ ...turns[0], items: [] }]), /marker/);
  const ids = { codex: randomUUID(), claude: "local_" + randomUUID() };
  checkThreads(ids, []);
  assert.throws(() => checkThreads(ids, [ids.claude]), /unprotected/);
});
test("automatic validation only runs with two available builds and at least one unsupported fingerprint", () => {
  const runningBuild = { hashes: { a: "hash" } },
    ready = { runningBuild },
    unknown = { runningBuild, code: "BUILD_UNSUPPORTED" };
  assert.equal(unknownPair({ codex: ready, claude: ready }), null);
  assert.equal(
    unknownPair({ codex: unknown, claude: { code: "DESKTOP_NOT_RUNNING" } }),
    null,
  );
  assert.equal(
    unknownPair({
      codex: unknown,
      claude: { ...ready, code: "PROFILE_REVOKED" },
    }),
    null,
  );
  assert.deepEqual(unknownPair({ codex: unknown, claude: ready }).unknown, [
    "codex",
  ]);
});
