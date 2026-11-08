export function certifiedCapabilities(app, checks) {
  const result = ["read", "send"];
  for (const name of ["create", "permissions", "mcp"]) {
    const row = checks?.[name];
    if (row?.status !== "passed") continue;
    const e = row.evidence;
    if (typeof e?.threadId !== "string" || !e.threadId)
      throw Error("Missing native chat ID for " + name);
    if (name === "create" && !e.cwd) throw Error("Missing creation workspace");
    if (
      name === "permissions" &&
      (app !== "codex" ||
        !result.includes("create") ||
        e.threadId !== checks.create.evidence.threadId ||
        e.restored !== "read-only" ||
        e.changed !== "workspace-write")
    )
      throw Error("Missing permission restoration evidence");
    if (
      name === "mcp" &&
      (e.server !== "desktop-bridge" ||
        e.verified !== (app === "codex" ? "tool-call" : "connected"))
    )
      throw Error("Missing MCP reload readback");
    result.push(name);
  }
  return result;
}
export function generated(profile) {
  return ["messaging-verified", "capability-verified"].includes(
    profile?.evidence?.stage,
  );
}
export function checkExecutionOperation(caps, method, input, allowFullAccess = false) {
  if (method === "read") return;
  const permitted =
    method === "set_permissions"
      ? caps.includes("permissions")
      : ["create", "prepare"].includes(method) && caps.includes("create");
  const fullAccess = allowFullAccess && caps.includes("permissions") &&
    input?.sandboxMode === "danger-full-access" && input.approvalPolicy === "never";
  const restricted = input?.approvalPolicy === "on-request" && (
    input.sandboxMode === "read-only" ||
    (input.sandboxMode === "workspace-write" && caps.includes("permissions"))
  );
  if (
    !permitted ||
    !(fullAccess || restricted) ||
    input.writableRoots?.length
  )
    throw Object.assign(
      Error("Execution policy or operation outside the validated profile"),
      { code: "CAPABILITY_UNSUPPORTED", status: 503, dispatchNotStarted: true },
    );
}

export function verifyFullAccess(method, result) {
  const native = method === "create" ? result.execution :
    method === "set_permissions" ? result.nativeExecution : result;
  const permissions = native?.nextTurnPermissions;
  if (permissions?.sandboxMode !== "danger-full-access" ||
      permissions.approvalPolicy !== "never" || permissions.writableRoots?.length) {
    throw Object.assign(Error("Native Codex did not confirm full access with approvals disabled"), {
      code: "EXECUTION_READBACK_MISMATCH",
      status: 503,
      createdThreadId: method === "create" ? result.threadId : undefined,
    });
  }
  return result;
}
export async function probeCapabilities(app, call, checkBuild, save, creationEvidence) {
  const checks = {};
  if (creationEvidence) {
    checks.create = { status: "passed", evidence: creationEvidence };
    certifiedCapabilities(app, checks);
    save(checks);
  }
  for (const capability of ["create", "permissions", "mcp"]) {
    if (capability === "create" && creationEvidence) continue;
    if (
      capability === "permissions" &&
      (app === "claude" || checks.create.status !== "passed")
    ) {
      checks[capability] = {
        status: app === "claude" ? "unsupported" : "skipped",
        reason:
          app === "claude"
            ? "Bridge permission changes require a managed Codex chat"
            : "No verified disposable chat",
      };
    } else {
      await checkBuild();
      checks[capability] = { status: "attempting" };
      save(checks);
      try {
        checks[capability] = {
          status: "passed",
          evidence: await call(capability),
        };
        certifiedCapabilities(app, checks);
      } catch (e) {
        checks[capability] = {
          status: e.message.startsWith("DEFERRED:") ? "deferred" : "failed",
          reason: e.message,
        };
      }
    }
    save(checks);
  }
  return checks;
}
