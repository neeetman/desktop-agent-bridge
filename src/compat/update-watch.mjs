// Automatic follow-up after desktop updates. The console owns the timer and the
// notification surface; everything here is injected so it can run against fakes.
import { unknownPair } from "./canary-watch.mjs";

export const WATCH_POLICY = Object.freeze({
  retryAfterMs: 30 * 60000,
  maxAttempts: 3,
});

// Failures a person can clear (a click, an open window, a restart that settled)
// are retried; a layout the discovery no longer recognises needs a code change.
const CLASSES = [
  { kind: "structural", pattern: /Manual analysis required|found \d+ matches for/i,
    hint: "新版本的内部结构变了，需要修改适配代码，自动验收不会再重试。" },
  { kind: "user", pattern: /no Node-API callback|callback timed out/i,
    hint: "Codex 没有确认授权。下次自动验收开始时，请在 Codex 窗口里点允许。" },
  { kind: "user", pattern: /test chat unavailable or archived/i,
    hint: "专用测试会话不可用（可能被归档）。下次自动验收会重新创建。" },
  { kind: "user", pattern: /Expected one Claude session renderer/i,
    hint: "Claude 当前打开了多个会话窗口或没有会话窗口。只保留一个 Claude 主窗口。" },
  { kind: "user", pattern: /window is closed|CODEX_WINDOW_CLOSED|window closed/i,
    hint: "Codex 窗口已关闭。打开 Codex 窗口。" },
  { kind: "user", pattern: /Desktop changed|changed during validation/i,
    hint: "验收期间桌面重启或更新了，稍后会自动重试。" },
];

export function classify(message = "") {
  const found = CLASSES.find((c) => c.pattern.test(message));
  return found ?? { kind: "unknown", hint: "未归类的失败，稍后会自动重试；反复失败请查看报告。" };
}

// The pair gate only fires when both desktops have readable builds. Say why when
// one desktop is unsupported but the other blocks the automatic run.
export function blockedUnknown(apps) {
  const names = ["codex", "claude"];
  const unknown = names.find((n) => apps[n]?.code === "BUILD_UNSUPPORTED");
  if (!unknown) return null;
  const other = names.find((n) => n !== unknown);
  const row = apps[other];
  if (!apps[unknown]?.runningBuild?.hashes) return { app: unknown, reason: `${unknown} 的构建信息读取不到` };
  if (!row?.runningBuild?.hashes) return { app: unknown, reason: `${other} 没有运行或构建信息读取不到` };
  if (row.code && row.code !== "BUILD_UNSUPPORTED") return { app: unknown, reason: `${other} 当前状态 ${row.code}` };
  return null;
}

function due(attempt, now, policy) {
  if (!attempt) return true;
  if (!attempt.kind) return false; // record from before classification: leave it alone
  if (attempt.kind === "structural" || attempt.kind === "activation" || attempt.done) return false;
  if ((attempt.count ?? 1) >= policy.maxAttempts) return false;
  return now >= (attempt.nextAt ?? 0);
}

/**
 * One tick of the unknown-build watcher.
 * deps: doctor() -> {apps}, certify(app) -> result, importPackage(folder),
 *       activate(app, profileId) -> result, notify(title, body), save(prefs), now()
 */
export async function watchUnknownBuilds(prefs, deps, policy = WATCH_POLICY) {
  const now = deps.now();
  const apps = (await deps.doctor()).apps;
  const pair = unknownPair(apps);
  if (!pair) {
    const blocked = blockedUnknown(apps);
    prefs.blocked ??= {};
    if (blocked && !prefs.blocked[blocked.app + ":" + blocked.reason]) {
      prefs.blocked[blocked.app + ":" + blocked.reason] = new Date(now).toISOString();
      deps.save(prefs);
      deps.notify(`${blocked.app} 新构建暂不能自动验收`, blocked.reason + "。恢复后会自动开始。");
    }
    return { action: "none" };
  }
  prefs.attempts ??= {};
  const previous = prefs.attempts[pair.key];
  if (!due(previous, now, policy)) return { action: "skip", attempt: previous };
  const attempt = { at: new Date(now).toISOString(), status: "验收中", count: (previous?.count ?? 0) + 1, unknown: pair.unknown };
  prefs.attempts[pair.key] = attempt;
  prefs.latest = pair.key;
  // Persist before the first native dispatch, including across console restarts.
  deps.save(prefs);
  deps.notify(`开始自动验收 ${pair.unknown.join("、")} 新构建`,
    "最长约 17 分钟。验收会连接 Codex，请在 Codex 弹出授权时点允许。");
  let result;
  try {
    result = await deps.certify(pair.unknown[0]);
  } catch (e) {
    const c = classify(e.message);
    Object.assign(attempt, { status: "需要检查", kind: c.kind, error: e.message, hint: c.hint });
    const retry = c.kind !== "structural" && attempt.count < policy.maxAttempts;
    if (retry) attempt.nextAt = now + policy.retryAfterMs;
    deps.save(prefs);
    deps.notify(`自动验收失败（${pair.unknown.join("、")}）`,
      c.hint + (retry ? ` 将于 ${Math.round(policy.retryAfterMs / 60000)} 分钟后重试（第 ${attempt.count}/${policy.maxAttempts} 次）。` : ""));
    return { action: "failed", attempt };
  }
  attempt.packages = result.packages;
  attempt.activation = {};
  // Only the desktops that were unknown get a new profile. The partner's package
  // was certified alongside but its running profile stays untouched.
  try {
    for (const name of pair.unknown) {
      const pkg = result.packages?.[name];
      if (!pkg) throw Error(`Certification returned no package for ${name}`);
      await deps.importPackage(pkg.folder);
      const activated = await deps.activate(name, pkg.profileId);
      attempt.activation[name] = { profileId: pkg.profileId, phase: activated?.phase ?? activated?.status ?? "requested" };
    }
  } catch (e) {
    Object.assign(attempt, { status: "激活失败", kind: "activation", error: e.message, hint: "验收已通过但导入或激活失败，需要人工检查；不会自动恢复。" });
    deps.save(prefs);
    deps.notify(`新构建已验收，但激活失败`, e.message.slice(0, 200));
    return { action: "activation-failed", attempt };
  }
  Object.assign(attempt, { status: "已验收并激活", done: true });
  delete attempt.nextAt;
  deps.save(prefs);
  deps.notify(`${pair.unknown.join("、")} 新构建已自动适配`,
    Object.entries(attempt.activation).map(([n, a]) => `${n}: ${a.phase}`).join("；") + "。空闲时生效。");
  return { action: "activated", attempt };
}

// Expected waits never count: a busy recipient, a closed Codex window, an update gate.
const EXPECTED_WAIT = /waits for the current turn|CODEX_WINDOW_CLOSED|window is closed/i;

/**
 * Report messages the router keeps retrying on the same unexpected error.
 * rows: router queue rows; alerts: {key: {since, count}} persisted by the caller.
 * One notification per (route, error text) and one when it clears.
 */
export function stalledDeliveries(rows, alerts, deps, { minMs = 5 * 60000 } = {}) {
  const now = deps.now(), current = new Map();
  for (const row of rows) {
    if (!row.faultSince || !["queued", "dispatching"].includes(row.jobStatus)) continue;
    if (EXPECTED_WAIT.test(row.reason ?? "") || row.faultCode === "CODEX_WINDOW_CLOSED") continue;
    if (now - Date.parse(row.faultSince) < minMs) continue;
    const key = `${row.from?.app}->${row.to?.app}|${row.reason}`;
    const entry = current.get(key) ?? { since: row.faultSince, ids: [], reason: row.reason, route: `${row.from?.app} → ${row.to?.app}` };
    entry.ids.push(row.id);
    current.set(key, entry);
  }
  let changed = false;
  for (const [key, entry] of current) {
    if (alerts[key]) continue;
    alerts[key] = { since: entry.since, notifiedAt: new Date(now).toISOString() };
    changed = true;
    deps.notify(`消息投递受阻（${entry.route}）`,
      `${entry.ids.length} 条消息自 ${entry.since.slice(11, 16)} 起一直失败：${String(entry.reason).slice(0, 160)}。常见原因是桌面应用更新后接口变了。`);
  }
  for (const key of Object.keys(alerts)) {
    if (current.has(key)) continue;
    const route = key.split("|")[0].replace("->", " → ");
    delete alerts[key];
    changed = true;
    deps.notify(`消息投递已恢复（${route}）`, "之前受阻的消息已经发出或不再重试。");
  }
  return { changed, stalled: [...current.values()] };
}

const READ_ONLY_CHECKS = ["list", "inspect", "models", "workspaces"];

/**
 * Exercise the DeepSeek plugin's read-only methods once per plugin activation.
 * deps: imported() -> activation record or null, rpc(method, args), notify, now()
 * state is persisted by the caller.
 */
export async function deepseekSelfTest(state, deps) {
  const imported = deps.imported();
  if (!imported) return { action: "none" };
  const key = `${imported.pid}:${imported.time}:${imported.source}`;
  if (state.key === key && state.done) return { action: "skip" };
  const checks = [];
  let failure = null;
  for (const method of READ_ONLY_CHECKS) {
    if (method === "inspect" && !state.sessionId) { checks.push({ method, ok: true, skipped: "no session" }); continue; }
    try {
      const value = await deps.rpc(method, method === "inspect" ? { sessionId: state.sessionId } : {});
      if (method === "list") state.sessionId = value?.items?.find((i) => !i.blank && i.formatStatus !== "migration-required")?.sessionId ?? value?.items?.[0]?.sessionId ?? null;
      if (method === "inspect" && !Array.isArray(value?.events)) throw Error("inspect returned no events array");
      checks.push({ method, ok: true });
    } catch (e) {
      failure ??= { method, error: e.message };
      checks.push({ method, ok: false, error: e.message });
    }
  }
  // A plugin that is still starting answers nothing; try again on the next tick.
  const unreachable = failure?.method === "list" && !/is not a function|Unsupported native method/i.test(failure.error);
  if (unreachable) return { action: "pending", checks };
  Object.assign(state, { key, done: true, checkedAt: new Date(deps.now()).toISOString(), checks, failure, source: imported.source });
  if (failure) deps.notify("DeepSeek 更新后接口自检失败", `${failure.method}: ${failure.error}`.slice(0, 220) + "。DeepSeek 消息收发会受影响，需要修改插件。");
  return { action: failure ? "failed" : "passed", checks };
}
