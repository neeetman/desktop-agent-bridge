import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "acorn";
import { ancestor, simple } from "acorn-walk";
import { sourcePath } from "../lib/paths.mjs";
import {
  adapterDigest,
  atomicJson,
  coordinator,
  ROOT,
} from "./compatibility.mjs";

function* chunks(file) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, "r");
  try {
    if (fs.readSync(fd, header, 0, 16, 0) !== 16)
      throw Error("Invalid ASAR header");
    const length = header.readUInt32LE(12),
      base = 8 + header.readUInt32LE(4);
    if (!length || length > 32 * 1024 * 1024 || base < 16 + length)
      throw Error("Unsupported ASAR header");
    const read = (position, size) => {
      const data = Buffer.alloc(size);
      if (fs.readSync(fd, data, 0, size, position) !== size)
        throw Error("Truncated ASAR");
      return data.toString("utf8");
    };
    const files = JSON.parse(read(16, length)).files?.[".vite"]?.files?.build
      ?.files;
    if (!files) throw Error("Unsupported desktop bundle layout");
    for (const [name, entry] of Object.entries(files)) {
      if (!/^[\w.-]+\.js$/.test(name) || entry.offset === undefined) continue;
      if (
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > 96 * 1024 * 1024
      )
        throw Error("Unsupported chunk size");
      yield [
        ".vite/build/" + name,
        read(base + Number(entry.offset), entry.size),
      ];
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function locate(app, files) {
  const hits = { connection: [], manager: [], session: [] };
  for (const [file, source] of files) {
    if (
      app === "claude"
        ? !source.includes("claudeCodeSessionManager")
        : !source.includes("sendAppServerRequest") &&
          !source.includes("addConversationStateCallback")
    )
      continue;
    const tree = parse(source, {
      ecmaVersion: "latest",
      sourceType: "commonjs",
    });
    if (app === "claude") {
      simple(tree, {
        AssignmentExpression(n) {
          if (
            n.operator === "=" &&
            n.left.object?.name === "exports" &&
            n.left.property?.name === "claudeCodeSessionManager" &&
            n.right.type === "Identifier" &&
            /\bcliPid\b/.test(source)
          )
            hits.session.push(file);
        },
      });
    } else {
      ancestor(tree, {
        Class(n, parents) {
          const methods = new Set(
            n.body.body
              .filter((m) => m.type === "MethodDefinition" && !m.static)
              .map((m) => m.key.name),
          );
          const module = parents.findLast(
            (p) =>
              p.type === "Property" &&
              Number.isSafeInteger(p.key.value) &&
              p.value.type === "FunctionExpression",
          );
          if (!module) return;
          const row = { file, id: module.key.value, name: n.id?.name };
          if (
            [
              "sendAppServerRequest",
              "registerInternalNotificationHandler",
              "readThread",
            ].every((k) => methods.has(k))
          )
            hits.connection.push(row);
          if (
            row.name &&
            [
              "addConversationStateCallback",
              "getConversation",
              "startConversation",
              "resumeConversation",
              "addApprovalRequestListener",
            ].every((k) => methods.has(k))
          )
            hits.manager.push(row);
        },
      });
    }
  }
  function one(key) {
    if (hits[key].length !== 1)
      throw Error(
        "Manual analysis required: found " +
          hits[key].length +
          " matches for " +
          key,
      );
    return hits[key][0];
  }
  if (app === "claude")
    return { sessionModule: one("session"), workerPidField: "cliPid" };
  const connection = one("connection"),
    manager = one("manager");
  return {
    connectionModule: connection.file,
    connectionModuleId: connection.id,
    managerModuleId: manager.id,
    managerClass: manager.name,
  };
}

export async function discover(
  app,
  { service = coordinator, root = ROOT } = {},
) {
  const { apps } = await service.doctor(app),
    observed = apps[app],
    build = observed.runningBuild;
  if (!build || (observed.code && observed.code !== "BUILD_UNSUPPORTED"))
    throw Error(observed.error || "No running build");
  const version = build.executable.match(/_(\d+(?:\.\d+){3})_x64__/i)?.[1];
  if (!version)
    throw Error("Manual analysis required: unknown running package version");
  const profiles = service.profiles().filter((row) => row.profile.app === app);
  if (
    profiles.some(
      ({ profile: p }) =>
        p.revoked && p.hashes.asarSha256 === build.hashes.asarSha256,
    )
  )
    throw Error("Revoked build");
  const seed = profiles
    .filter(
      ({ profile: p }) =>
        !p.revoked &&
        p.evidence.stage !== "messaging-verified" &&
        (app === "codex"
          ? p.manifests.execution?.connectionModuleId
          : p.manifests.claude?.transport === "main-renderer-rpc"),
    )
    .sort((a, b) =>
      b.profile.packageVersion.localeCompare(a.profile.packageVersion, "en", {
        numeric: true,
      }),
    )[0];
  if (!seed) throw Error("No compatible baseline adapter available");
  const asar = path.join(path.dirname(build.executable), "resources/app.asar");
  const contract = locate(app, chunks(asar));
  const p = structuredClone(seed.profile);
  p.packageVersion = version;
  p.hashes = build.hashes;
  p.id =
    app +
    "-" +
    version +
    "-" +
    build.hashes.asarSha256.slice(0, 16) +
    "-candidate";
  for (const [kind, m] of Object.entries(p.manifests)) {
    Object.assign(m, build.hashes);
    if (app === "claude")
      Object.assign(m, contract, {
        desktopVersion: version.replace(/\.0$/, ""),
      });
    else {
      Object.assign(m, {
        version,
        connectionModule: contract.connectionModule,
        connectionModuleId: contract.connectionModuleId,
      });
      if (kind === "execution") Object.assign(m, contract);
    }
  }
  p.evidence = {
    baseline: "Unverified structural candidate",
    stage: "candidate",
    seed: seed.profile.id,
  };
  const folder = path.join(
    root,
    "runtime/candidates",
    app,
    crypto.randomUUID(),
  );
  const adapterRoot = path.join(folder, "adapter");
  fs.mkdirSync(adapterRoot, { recursive: true });
  for (const name of p.adapterFiles)
    fs.copyFileSync(
      sourcePath(seed.adapterRoot, name),
      path.join(adapterRoot, name),
    );
  if (adapterDigest(adapterRoot, p.adapterFiles) !== p.adapterDigest)
    throw Error("Baseline adapter digest changed");
  atomicJson(path.join(folder, "candidate.json"), p);
  return { folder, profile: p, adapterRoot, build, contract };
}
