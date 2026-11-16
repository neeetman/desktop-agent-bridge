"use strict";
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/* ---------- Static vocabulary ---------- */
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  messages: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8m-8 3h5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4m0 3v.5"/>',
  minus: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  plug: '<path d="M9 3v5m6-5v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
};
const icon = (name) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + "</svg>";
document.querySelectorAll("i[data-icon]").forEach((i) => (i.innerHTML = icon(i.dataset.icon)));

// Known apps. Anything else reported by the bridge is shown with a neutral style.
const APP_META = {
  codex: { name: "Codex", mono: "Cx", hue: "#3f6f63", kind: "desktop" },
  claude: { name: "Claude", mono: "Cl", hue: "#c2683f", kind: "desktop" },
  deepseek: { name: "DeepSeek", sub: "Harness", mono: "Ds", hue: "#4361c9", kind: "service" },
  antigravity: { name: "Antigravity", mono: "Ag", hue: "#7c4ad6", kind: "desktop" },
  bridge: { name: "Bridge", mono: "Br", hue: "#64748b", kind: "internal" },
};
const ORDER = ["codex", "claude", "deepseek", "antigravity"];
const meta = (id) => APP_META[id] ?? { name: id.charAt(0).toUpperCase() + id.slice(1), mono: id.slice(0, 2), hue: "#6b7280", kind: "desktop" };
const appName = (id) => meta(id).name;

const CAPS = [
  ["read", "读取"], ["send", "发送"], ["create", "创建会话"], ["permissions", "权限切换"], ["fullAccess", "完全访问"], ["mcp", "MCP"],
];
const CODEX_ONLY = ["permissions", "fullAccess"];
const capLabel = (name) => CAPS.find(([key]) => key === name)?.[1] ?? name;
const CHECK_STATUS = { passed: "已通过", deferred: "已推迟", unsupported: "不支持", failed: "未通过" };
const CHECK_VERB = { deferred: "推迟了", unsupported: "判定不支持", failed: "未通过" };
// Probes run only when a session calls bridge_health; older samples are history, not current state.
const STALE_MS = 15 * 60 * 1000;
const fresh = (h) => !!h?.checkedAt && Date.now() - new Date(h.checkedAt).getTime() < STALE_MS;
const healthStep = (h) => (!h || !fresh(h) ? "off" : h.status === "healthy" ? "done" : h.status === "unhealthy" ? "fail" : "wait");
const REASONS = [
  [/protected desktop chat/i, "存在受保护会话，全局 MCP 重载测试被跳过"],
  [/requires Connect/i, "需要在 Claude 界面中手动连接 desktop-bridge 服务器"],
  [/busy|not idle/i, "有会话正在运行，重载测试被推迟"],
  [/managed Codex chat/i, "该能力只适用于桥接托管的 Codex 会话"],
];
const reasonZh = (reason) => {
  if (!reason) return "";
  const hit = REASONS.find(([pattern]) => pattern.test(reason));
  return hit ? hit[1] : reason.replace(/^DEFERRED:\s*/, "");
};
const CODES = {
  CAPABILITY_UNSUPPORTED: "当前适配包没有验证这项能力",
  BUILD_UNSUPPORTED: "没有与正在运行的桌面字节匹配的已验证适配包",
  IDENTITY_MISMATCH: "运行中的桌面与适配包身份不一致，桌面可能刚刚更新",
  CONTRACT_MISMATCH: "原生接口与适配包契约不符",
  REFRESH_DEFERRED_BUSY: "桌面正忙，附着推迟到空闲时",
  ADAPTER_STALE: "附着中的适配包已过期，需要空闲时激活或重启桌面",
  ATTACHMENT_ERROR: "附着过程出错",
  ENOENT: "原生管道不存在，桌面可能未运行或尚未附着",
  ECONNREFUSED: "后端服务拒绝连接",
  TIMEOUT: "探测超时",
};
const SERVICES = {
  router: "消息路由", codex: "Codex 后端", "codex-mcp": "Codex MCP 附着", claude: "Claude 后端",
  "claude-relay": "Claude 中继", "claude-attach": "Claude 附着", deepseek: "DeepSeek 后端",
};
const SERVICE_STATES = {
  healthy: ["运行正常", "ok"], starting: ["启动中", "info"], waiting: ["等待", "idle"], waiting_for_native: ["等待桌面", "idle"],
  incompatible: ["版本不兼容", "warn"], attachment_error: ["附着失败", "bad"], awaiting_native_callback: ["等待原生回调", "warn"],
  waiting_for_native_callback: ["等待原生回调", "warn"], closed_by_user: ["用户已关闭", "idle"], running: ["运行中", "ok"],
};
const STEP_NAMES = { service_http: "服务 HTTP", native_threads: "原生会话查询" };
const stages = {
  queued: "已入队", waiting_for_adapter: "等待版本适配", waiting_for_contract: "接口验证待恢复", waiting_for_connection: "等待连接恢复",
  dispatching: "投递中", delivered: "已投递", acknowledged: "已读", replied: "已回复", unknown: "结果未知", failed: "失败",
  expired: "已过期", interrupted: "已中断", completed: "已完成", awaiting_ack: "等待确认",
};
const kinds = { message: "消息", reply: "回复", health: "健康通知", decision_answer: "决策答复", decision_request: "决策请求" };
const PENDING = ["queued", "waiting_for_adapter", "waiting_for_contract", "waiting_for_connection", "dispatching", "awaiting_ack"];
const FILTERS = [["", "全部"], ["pending", "待处理"], ["delivered", "已投递"], ["read", "已读 / 已回复"], ["issue", "需检查"], ["reviewed", "已复核"]];
const PAGES = {
  overview: ["总览", "桌面连接、适配与消息的当前状态"],
  messages: ["消息", "跨会话投递记录与回执"],
  compat: ["适配", "桌面构建与适配包、能力验收"],
  health: ["健康", "健康探测与后台服务"],
  setup: ["接入", "各应用的 MCP 配置与 desktop-bridge skill"],
  settings: ["设置", "外观与启动偏好"],
};

const state = {
  page: "overview", rows: [], index: 0, selected: null, filter: "", busy: false,
  snapshot: null, queueError: "", adapterError: "", certifyApp: null, maintenance: null,
  setup: null, setupError: "", setupLoading: false,
};
let watching = false;
// Console maintenance (manual or automatic validation, imports, activation) runs one at a time in
// the main process; while any runs, conflicting controls are disabled and the owner is shown.
const locked = () => state.busy || !!state.maintenance;
const NAV_ACTIONS = ["certify", "health"];

/* ---------- Formatting helpers ---------- */
const time = (value) => value
  ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  : "—";
function ago(value) {
  if (!value) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return Math.round(seconds / 60) + " 分钟前";
  if (seconds < 86400) return Math.round(seconds / 3600) + " 小时前";
  return time(value);
}
const badge = (tone, text) => '<span class="badge ' + esc(tone) + '">' + esc(text) + "</span>";
const monogram = (id) => '<span class="monogram" data-hue="' + esc(meta(id).hue) + '">' + esc(meta(id).mono) + "</span>";
const tag = (id) => '<span class="tag" data-hue="' + esc(meta(id).hue) + '">' + esc(appName(id)) + "</span>";
function group(stage) {
  if (["unknown", "failed", "interrupted"].includes(stage)) return "issue";
  if (["acknowledged", "replied"].includes(stage)) return "read";
  if (PENDING.includes(stage)) return "pending";
  return stage;
}
const queueGroup = (row) => (row.review ? "reviewed" : group(row.stage));
const STAGE_TONE = { issue: "bad", pending: "info", read: "ok", delivered: "ok", reviewed: "idle" };
const stagePill = (row) => badge(row.review ? "idle" : STAGE_TONE[group(row.stage)] ?? "idle", row.review ? "已复核" : stages[row.stage] ?? row.stage);

/* ---------- Diagnosis: one clear state per app ---------- */
function appIds() {
  const snap = state.snapshot ?? {};
  const ids = new Set([...Object.keys(snap.apps ?? {}), "deepseek", ...Object.keys(snap.supervisor?.apps ?? {})]);
  return [...ids].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}
function capabilityStates(id) {
  const snap = state.snapshot ?? {}, row = snap.apps?.[id] ?? {}, cert = snap.certifications?.[id];
  const granted = new Set(row.capabilities ?? []), tripped = Object.keys(row.circuits ?? {});
  // Permission switching and full access manage Codex sandbox policy; other apps
  // have their own permission model, so the chips do not apply to them at all.
  const applies = (name) => id === "codex" || !CODEX_ONLY.includes(name) || granted.has(name);
  const names = [...new Set([...CAPS.map(([key]) => key), ...granted, ...Object.keys(cert?.checks ?? {})])].filter(applies);
  return names.map((name) => {
    const check = cert?.checks?.[name];
    if (tripped.includes(name)) return { name, status: "tripped", note: "契约不符，已熔断" };
    if (granted.has(name)) return { name, status: "ok", note: "已验证" };
    if (check) return { name, status: check.status === "passed" ? "none" : check.status, note: (CHECK_STATUS[check.status] ?? check.status) + (check.reason ? "：" + reasonZh(check.reason) : "") };
    return { name, status: "none", note: "未验证" };
  });
}
// Apps gated by live contract probes (Antigravity) report `contract` instead of a compatibility profile.
const probeGated = (id) => !!state.snapshot?.apps?.[id]?.contract;
function diagnose(id) {
  const snap = state.snapshot;
  const m = meta(id);
  if (!snap) return { tone: "idle", label: "检查中", steps: [], issue: null };
  if (m.kind === "service" || (!snap.apps?.[id] && id === "deepseek")) return diagnoseService(id, snap);
  if (probeGated(id)) return diagnoseProbe(id, snap);
  const row = snap.apps?.[id] ?? null, sup = snap.supervisor?.apps?.[id], mon = snap.monitors?.[id];
  const health = snap.health?.[id], cert = snap.certifications?.[id];
  const running = !!(row?.runningBuild?.pid || sup?.pid);
  const matched = !!(row && row.phase !== "blocked" && row.profileId);
  const attachedPhase = ["attached", "ready"].includes(row?.phase);
  const monitorBlocked = mon && ["incompatible", "attachment_error"].includes(mon.state);
  const monitorWaiting = mon && ["attaching", "waiting_for_native_callback", "awaiting_native_callback"].includes(mon.state);
  const attached = matched && !monitorBlocked && !monitorWaiting && (attachedPhase || mon?.state === "installed");
  const steps = [
    { label: "运行", s: running ? "done" : sup?.state === "closed_by_user" ? "off" : "fail" },
    { label: "匹配适配包", s: !running ? "off" : matched ? "done" : "fail" },
    { label: "附着", s: !matched ? "off" : attached ? "done" : monitorBlocked ? "fail" : "wait" },
    { label: "健康探测", s: healthStep(health) },
  ];
  const goCertify = { label: "重新验收", kind: "certify", primary: true };
  const probe = { label: "检查连接", kind: "probe" };

  if (!running) {
    const byUser = sup?.state === "closed_by_user" || sup?.closedByUser;
    return { tone: "idle", label: byUser ? "已关闭" : "未运行", steps, issue: {
      tone: "idle", title: m.name + (byUser ? " 已由用户关闭" : " 没有在运行"),
      lines: [byUser ? "监督器不会自动重新打开它。需要投递消息时，请手动打开桌面应用。" : "启动桌面应用后，控制台会自动匹配适配包并附着。"] } };
  }
  if (!matched) {
    const code = row?.code ?? "BUILD_UNSUPPORTED";
    return { tone: "bad", label: "未知构建", steps, issue: {
      tone: "bad", title: "未知构建：版本 " + version(row) + " 没有可用的适配包",
      lines: [CODES[code] ?? row?.error ?? code, "<code>" + esc(code) + "</code>" + (row?.error ? " " + esc(row.error) : "")],
      next: "在「适配」页检查 GitHub 上的适配包，或运行验收生成新适配包。",
      actions: [goCertify, { label: "检查 GitHub", kind: "upstream" }] } };
  }
  if (row?.transition) {
    return { tone: "info", label: "切换适配包中", steps, issue: { tone: "info", title: "正在切换到 " + (row.transition.to ?? "新适配包"),
      lines: ["阶段：" + (row.transition.phase === "waitingIdle" ? "等待所有会话空闲" : row.transition.phase) + (row.transition.error ? "（" + row.transition.error + "）" : "")] } };
  }
  if (monitorBlocked) {
    const code = mon.code ?? "ATTACHMENT_ERROR";
    if (code === "CAPABILITY_UNSUPPORTED" || /not validated/i.test(mon.error ?? "")) {
      const capName = /^(\w+) is not validated/.exec(mon.error ?? "")?.[1] ?? "mcp";
      const check = cert?.checks?.[capName];
      const granted = (row.capabilities ?? []).map(capLabel).join(" · ");
      const lines = [];
      if (check) lines.push("验收 <code>" + esc((cert.runId ?? "").slice(0, 8)) + "</code> " + esc(CHECK_VERB[check.status] ?? check.status) + " " + esc(capLabel(capName)) + " 检查：" + esc(reasonZh(check.reason) || "未给出原因") + "。");
      else lines.push("当前适配包没有包含 " + esc(capLabel(capName)) + " 能力。");
      lines.push("已验证的能力（" + esc(granted || "无") + "）照常可用；" + esc(m.name) + " 会话暂时不能调用 desktop-bridge MCP 工具。");
      lines.push("<code>" + esc(code) + "</code> " + esc(mon.error ?? ""));
      return { tone: "warn", label: "已匹配 · 未附着", steps, issue: { tone: "warn", raw: true,
        title: "MCP 未附着：当前适配包未验证 " + capLabel(capName) + " 能力", lines,
        next: check?.reason && /protected/i.test(check.reason)
          ? "让所有 " + m.name + " 会话空闲、解除受保护会话后重新运行验收，通过后导入新适配包。"
          : "满足验收条件后重新运行验收，通过后导入新适配包。",
        actions: [goCertify, probe] } };
    }
    return { tone: mon.state === "attachment_error" ? "bad" : "warn", label: mon.state === "attachment_error" ? "附着失败" : "已匹配 · 未附着", steps, issue: {
      tone: mon.state === "attachment_error" ? "bad" : "warn", title: "附着被阻止：" + (CODES[code] ?? code),
      lines: ["<code>" + esc(code) + "</code> " + esc(mon.error ?? "")], raw: true,
      next: code === "IDENTITY_MISMATCH" ? "桌面可能刚更新。检查 GitHub 适配包或重新验收。" : "空闲时检查连接；仍失败时到「健康」页查看服务状态。",
      actions: code === "IDENTITY_MISMATCH" ? [goCertify, probe] : [probe, { label: "查看健康", kind: "health" }] } };
  }
  if (monitorWaiting) {
    const waiting = mon.state !== "attaching";
    return { tone: waiting ? "warn" : "info", label: waiting ? "等待原生回调" : "正在附着", steps, issue: {
      tone: waiting ? "warn" : "info", title: waiting ? "附着在等待桌面的原生回调" : "正在附着到 " + m.name,
      lines: waiting ? ["在 " + m.name + " 中打开或切换到任意会话即可唤醒回调。" + (mon.error ? " " + mon.error : "")] : ["附着完成后状态会自动更新。"],
      actions: waiting ? [probe] : [] } };
  }
  const circuits = Object.keys(row.circuits ?? {});
  if (circuits.length) {
    return { tone: "warn", label: "能力熔断", steps, issue: { tone: "warn", title: "已暂停：" + circuits.map(capLabel).join("、"),
      lines: ["运行中发现原生契约与适配包不符，相关能力已自动停用。其他能力不受影响。"], next: "重新验收或导入新适配包后恢复。", actions: [goCertify] } };
  }
  if (!attached) {
    return { tone: "warn", label: "已匹配 · 未附着", steps, issue: { tone: "warn", title: "适配包已匹配，附着进程还没有报告就绪",
      lines: ["适配包 <code>" + esc(row.profileId) + "</code>"], raw: true, next: "检查连接以确认原生接口是否就绪。", actions: [probe] } };
  }
  if (fresh(health) && health.status !== "healthy") return healthIssue(id, health, steps);
  return { tone: "ok", label: "已附着", steps, issue: null };
}
function healthIssue(id, health, steps) {
  const bad = health.status === "unhealthy";
  return { tone: bad ? "bad" : "warn", label: bad ? "探测失败" : "健康降级", steps, issue: {
    tone: bad ? "bad" : "warn", title: (bad ? "健康探测已确认失败" : "最近一次健康探测失败") + (health.failedStep ? "：" + (STEP_NAMES[health.failedStep] ?? health.failedStep) : ""),
    lines: [(CODES[health.errorCode] ?? "") + (health.errorCode ? " <code>" + esc(health.errorCode) + "</code>" : ""), esc(health.error ?? "")].filter(Boolean), raw: true,
    next: bad ? "到「健康」页查看各步骤耗时。" : "单次失败不代表断开，等待下一次独立探测。",
    actions: [{ label: "查看健康", kind: "health" }] } };
}
function diagnoseService(id, snap) {
  const sup = snap.supervisor?.apps?.[id], health = snap.health?.[id];
  const online = id === "deepseek" ? snap.deepseek : health?.ok;
  const desktopClosed = sup && !sup.pid;
  const steps = [
    { label: "桥接服务", s: online ? "done" : online === false ? "fail" : "off" },
    { label: "桌面", s: sup ? (sup.pid ? "done" : "off") : "off" },
    { label: "健康探测", s: healthStep(health) },
  ];
  if (!online) return { tone: "bad", label: "服务离线", steps, issue: { tone: "bad", title: meta(id).name + " 桥接服务没有响应",
    lines: ["监督器会自动重启后台服务。持续离线时到「健康」页查看服务状态。"], actions: [{ label: "查看健康", kind: "health" }] } };
  if (desktopClosed) return { tone: "idle", label: "服务在线 · 桌面未打开", steps, issue: { tone: "idle",
    title: "桥接服务在线，" + (meta(id).name + " " + (meta(id).sub ?? "")).trim() + " 桌面未打开",
    lines: [sup.closedByUser || sup.state === "closed_by_user" ? "桌面由用户关闭，监督器不会自动重新打开。需要投递消息时请打开它。" : "桌面没有运行。"] } };
  if (fresh(health) && health.status !== "healthy") return healthIssue(id, health, steps);
  return { tone: "ok", label: "服务在线", steps, issue: null };
}
function diagnoseProbe(id, snap) {
  const row = snap.apps[id], m = meta(id), health = snap.health?.[id];
  const failed = (row.contract?.checks ?? []).filter((check) => !check.ok);
  const steps = [
    { label: "已安装", s: row.installed ? "done" : "off" },
    { label: "接口契约", s: !row.installed ? "off" : row.contract?.ok ? "done" : "fail" },
    { label: "应用运行", s: !row.contract?.ok ? "off" : row.hub ? "done" : "off" },
    { label: "桥接服务", s: !row.hub ? "off" : row.service?.ok ? "done" : "wait" },
  ];
  if (!row.installed) return { tone: "idle", label: "未安装", steps, issue: { tone: "idle", title: "没有检测到 " + m.name,
    lines: ["安装后控制台会自动检测。"] } };
  if (!row.contract?.ok) return { tone: "bad", label: "接口契约不符", steps, issue: { tone: "bad", raw: true,
    title: m.name + " 的原生接口与适配器不一致",
    lines: failed.map((check) => "<code>" + esc(check.check) + "</code> " + esc(check.error ?? "未通过")),
    next: m.name + " 可能已更新。适配器更新前，桥接会拒绝向它投递。" } };
  if (!row.hub) return { tone: "idle", label: "未运行", steps, issue: { tone: "idle", title: m.name + " 没有在运行",
    lines: ["打开 " + m.name + " 后，桥接会自动连接到它的 hub。"] } };
  if (!row.service?.ok) return { tone: "warn", label: "桥接服务未就绪", steps, issue: { tone: "warn", raw: true,
    title: m.name + " 桥接服务" + ({ initializing: "正在初始化", not_started: "尚未启动", unreachable: "无法连接" }[row.service?.state] ?? "未就绪"),
    lines: [row.service?.error ? "<code>" + esc(row.service.state ?? "") + "</code> " + esc(row.service.error) : "监督器会自动启动后台服务。"],
    actions: [{ label: "查看健康", kind: "health" }] } };
  if (fresh(health) && health.status !== "healthy") return healthIssue(id, health, steps);
  return { tone: "ok", label: "已连接", steps, issue: null };
}
function version(row) {
  return row?.runningBuild?.packageVersion || row?.installedBuild?.version || "—";
}

/* ---------- Rendering ---------- */
function stepsHtml(steps) {
  return '<div class="steps" data-n="' + steps.length + '">' + steps.map((step) => '<span class="step ' + step.s + '">' + esc(step.label) + "</span>").join("") + "</div>";
}
function actionButtons(id, actions) {
  return (actions ?? []).map((action) => '<button class="' + (action.primary ? "primary" : "secondary") + '" data-kind="' + esc(action.kind) + '" data-app="' + esc(id) + '"' +
    (locked() && !NAV_ACTIONS.includes(action.kind) ? " disabled" : "") + ">" + esc(action.label) + "</button>").join("");
}
function issueHtml(id, issue) {
  if (!issue) return "";
  const lines = issue.lines.map((line) => "<p>" + (issue.raw ? line : esc(line)) + "</p>").join("");
  return '<div class="issue ' + esc(issue.tone) + '"><b>' + esc(issue.title) + "</b>" + lines +
    (issue.next ? '<p class="next">下一步：' + esc(issue.next) + "</p>" : "") +
    (issue.actions?.length ? '<div class="actions">' + actionButtons(id, issue.actions) + "</div>" : "") + "</div>";
}
function capsHtml(id) {
  if (meta(id).kind === "service" || !state.snapshot?.apps?.[id]) return "";
  if (probeGated(id)) return '<div class="caps">' + (state.snapshot.apps[id].contract.checks ?? []).map((check) =>
    '<span class="cap ' + (check.ok ? "ok" : "failed") + '" title="' + esc(check.error ?? "接口检查通过") + '">' + esc(check.check) + "</span>").join("") + "</div>";
  return '<div class="caps">' + capabilityStates(id).map((cap) =>
    '<span class="cap ' + esc(cap.status) + '" title="' + esc(cap.note) + '">' + esc(capLabel(cap.name)) + "</span>").join("") + "</div>";
}
function subtitle(id) {
  const row = state.snapshot?.apps?.[id];
  if (row && probeGated(id)) return "LS " + (row.hub?.lsVersion ?? "—");
  if (row) return version(row);
  return meta(id).sub ?? "";
}
function appCard(id) {
  const d = diagnose(id);
  return '<article class="app-card ' + esc(d.tone) + '"><div class="app-head">' + monogram(id) +
    '<div class="names"><b>' + esc(appName(id)) + "</b><small>" + esc(subtitle(id)) + "</small></div>" + badge(d.tone, d.label) + "</div>" +
    stepsHtml(d.steps) + issueHtml(id, d.issue) + capsHtml(id) + "</article>";
}
function counts() {
  const by = (key) => state.rows.filter((row) => queueGroup(row) === key).length;
  return { all: state.rows.length, pending: by("pending"), issue: by("issue"), read: by("read"), delivered: by("delivered"), reviewed: by("reviewed") };
}
function renderOverview() {
  const ids = appIds(), diagnoses = ids.map((id) => [id, diagnose(id)]);
  const attention = diagnoses.filter(([, d]) => ["warn", "bad"].includes(d.tone));
  const okCount = diagnoses.filter(([, d]) => d.tone === "ok").length, c = counts();
  const worst = diagnoses.some(([, d]) => d.tone === "bad") ? "bad" : attention.length ? "warn" : state.snapshot ? "ok" : "idle";
  const headline = !state.snapshot ? ["正在检查桌面…", "首次检查需要几秒"]
    : attention.length ? [attention.length + " 个应用需要处理", attention.map(([id, d]) => appName(id) + "：" + d.label).join(" · ")]
    : ["所有应用运行正常", ids.length + " 个应用已接入本机路由"];
  $("summary").innerHTML =
    '<div class="headline ' + worst + '"><span class="glyph">' + icon(worst === "ok" ? "check" : worst === "idle" ? "minus" : "alert") + "</span><div><b>" + esc(headline[0]) + "</b><small>" + esc(headline[1]) + "</small></div></div>" +
    '<div class="kpi"><span>应用状态</span><b>' + okCount + "<small> / " + ids.length + " 正常</small></b></div>" +
    '<button class="kpi" data-filter="pending"><span>待投递</span><b>' + c.pending + "</b></button>" +
    '<button class="kpi ' + (c.issue ? "bad" : "") + '" data-filter="issue"><span>需检查消息</span><b>' + c.issue + "</b></button>";
  $("app-grid").innerHTML = ids.map(appCard).join("");
  const items = attention.map(([id, d]) => '<li><span class="sev ' + d.tone + '"></span><div><b>' + esc(appName(id) + " · " + (d.issue?.title ?? d.label)) + "</b><small>" + esc(d.issue?.next ?? "") + "</small></div>" +
    (d.issue?.actions?.[0] ? actionButtons(id, [{ ...d.issue.actions[0], primary: false }]) : "") + "</li>");
  if (c.issue) items.push('<li><span class="sev bad"></span><div><b>' + c.issue + " 条消息结果未知或失败</b><small>核对目标会话后在复核记录中说明，不会自动重放。</small></div>" +
    '<button class="secondary" data-filter="issue">查看</button></li>');
  if (state.queueError) items.push('<li><span class="sev bad"></span><div><b>消息路由不可用</b><small>' + esc(state.queueError) + "</small></div></li>");
  $("attention").innerHTML = items.join("") || '<li class="all-clear"><span class="sev"></span><div><b>没有需要处理的事项</b><small>新的问题会显示在这里。</small></div></li>';
  const recent = state.rows.slice(0, 6);
  $("recent").innerHTML = recent.length
    ? '<table class="table compact"><tbody>' + recent.map(rowHtml).join("") + "</tbody></table>"
    : '<p class="empty">' + (state.queueError ? "队列暂不可用" : "还没有消息") + "</p>";
}
function rowHtml(r) {
  return '<tr tabindex="0" data-id="' + esc(r.id) + '"><td><span class="msg-title">' + esc(r.callerId || kinds[r.kind] || r.kind) + '</span><span class="uid">' + esc(r.id.slice(0, 18)) + "</span></td>" +
    '<td><span class="route">' + tag(r.from.app) + '<span class="to">→</span>' + tag(r.to.app) + "</span></td><td>" + stagePill(r) + "</td><td><time>" + time(r.createdAt) + '</time></td><td class="chev">›</td></tr>';
}
function renderMessages() {
  const c = counts(), map = { "": c.all, pending: c.pending, delivered: c.delivered, read: c.read, issue: c.issue, reviewed: c.reviewed };
  $("filters").innerHTML = FILTERS.map(([key, label]) => '<button role="tab" data-filter="' + key + '" class="' + (state.filter === key ? "active" : "") + '">' + label + "<b>" + map[key] + "</b></button>").join("");
  const q = $("search").value.trim().toLowerCase();
  const filtered = state.rows.filter((r) => (!state.filter || queueGroup(r) === state.filter) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
  const size = 20;
  state.index = Math.min(state.index, Math.max(0, Math.ceil(filtered.length / size) - 1));
  const start = state.index * size;
  $("rows").innerHTML = filtered.slice(start, start + size).map(rowHtml).join("") ||
    '<tr><td colspan="5" class="empty">' + (state.queueError ? "队列暂不可用" : "没有匹配的消息") + "</td></tr>";
  $("range").textContent = filtered.length ? start + 1 + "–" + Math.min(start + size, filtered.length) + " / " + filtered.length + " 条" : "0 条";
  $("prev").disabled = start === 0;
  $("next").disabled = start + size >= filtered.length;
}
function workerSummary(id) {
  const snap = state.snapshot ?? {}, workers = (snap.workers ?? []).filter((w) => w.app === id);
  if (snap.unverifiedWorkerApps?.includes(id)) return '<div class="workers">暂时无法核验 MCP 进程，请刷新后再查看。</div>';
  if (!workers.length) return '<div class="workers">暂无已核实的 MCP 进程</div>';
  const stale = workers.filter((w) => w.revision && w.revision !== snap.installedRevision).length;
  const rows = workers.map((w) => "<li>" + esc(w.threadId || "进程 " + w.pid) + " · " + (!w.revision ? "版本未知" : w.revision === snap.installedRevision ? "当前版本" : "建议重载") + "</li>");
  const hint = id === "claude" ? "空闲时可重连指定会话。" : "在空闲且无受保护会话时全局重载。";
  return '<details class="workers"><summary>MCP 进程 ' + workers.length + " 个，" + stale + " 个建议重载</summary><ul>" + rows.join("") + "</ul>" + hint + "</details>";
}
function renderCompat() {
  const snap = state.snapshot ?? {}, ids = Object.keys(snap.apps ?? {}).filter((id) => !probeGated(id));
  const gated = Object.keys(snap.apps ?? {}).filter(probeGated);
  const previous = Object.fromEntries([...$("packages").querySelectorAll("select[data-app]")].map((e) => [e.dataset.app, e.options.length > 1 ? e.value : undefined]));
  const openWorkers = new Set([...$("packages").querySelectorAll("details.workers[open]")].map((e) => e.closest("[data-card]").dataset.card));
  $("packages").innerHTML = ids.map((id) => {
    const row = snap.apps[id] ?? {}, d = diagnose(id), cert = snap.certifications?.[id];
    const profiles = (snap.profiles ?? []).filter((p) => p.app === id), selected = previous[id] ?? "";
    const button = (action, title, primary = false) => '<button data-kind="' + action + '" data-app="' + id + '" class="' + (primary ? "primary" : "secondary") + '"' + (locked() ? " disabled" : "") + ">" + title + "</button>";
    return '<article class="app-card compat-card ' + d.tone + '" data-card="' + esc(id) + '"><div class="app-head">' + monogram(id) + '<div class="names"><b>' + esc(appName(id)) + "</b><small>" + esc(version(row)) + "</small></div>" + badge(d.tone, d.label) + "</div>" +
      '<div class="package-grid"><div class="field"><span>当前适配包</span><code>' + esc(row.profileId || row.code || "尚未匹配") + "</code></div>" +
      '<div class="field"><span>最近验收</span><b>' + (cert ? esc(cert.runId.slice(0, 8)) + " · " + esc(cert.stage === "passed" ? "通过" : cert.stage) : "—") + "</b></div>" +
      '<div class="field"><span>附着阶段</span><b>' + esc({ attached: "已附着", ready: "已就绪", selected: "已匹配", notAttached: "未附着", blocked: "已阻止" }[row.phase] ?? row.phase ?? "—") + "</b></div></div>" +
      issueHtml(id, d.issue) + workerSummary(id) + capsHtml(id) +
      '<div class="compat-actions">' + button("probe", "检查连接") + button("upstream", "检查 GitHub") + button("local", "导入本机包") + button("discover", "生成候选") +
      '<span class="spacer"></span><label>激活<select data-app="' + esc(id) + '"><option value="">自动匹配</option>' +
      profiles.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === selected ? " selected" : "") + ">" + esc(p.id) + "</option>").join("") + "</select></label>" + button("activate", "空闲时激活", true) + "</div></article>";
  }).join("") + gated.map((id) => appCard(id).replace("</article>", '<p class="workers">' + esc(appName(id)) + " 不使用适配包：每次连接前实时探测原生接口契约，上方列出各项检查。</p></article>")).join("") ||
    '<p class="empty">没有检测到桌面应用</p>';
  for (const id of openWorkers) $("packages").querySelector('[data-card="' + id + '"] details.workers')?.setAttribute("open", "");
  const select = $("certify-app"), current = state.certifyApp ?? select.value;
  select.innerHTML = ids.map((id) => '<option value="' + esc(id) + '"' + (id === current ? " selected" : "") + ">" + esc(appName(id)) + "</option>").join("");
  const profiles = snap.profiles ?? [];
  $("profile-count").textContent = profiles.length + " 个";
  $("profiles").innerHTML = profiles.map((p) => "<tr" + (snap.apps?.[p.app]?.profileId === p.id ? ' class="current"' : "") + '><td><code>' + esc(p.id) + "</code>" + (snap.apps?.[p.app]?.profileId === p.id ? " " + badge("ok", "使用中") : "") + "</td><td>" + tag(p.app) + "</td><td>" + esc(p.version ?? "—") + '</td><td class="err">' + esc((p.capabilities ?? []).map(capLabel).join(" · ") || "—") + "</td></tr>").join("") ||
    '<tr><td colspan="4" class="empty">没有已安装的适配包</td></tr>';
}
function renderHealth() {
  const snap = state.snapshot ?? {}, sup = snap.supervisor;
  const services = Object.entries(sup?.services ?? {});
  const unhealthy = services.filter(([, s]) => s.state !== "healthy").length;
  $("supervisor").innerHTML =
    '<div class="headline ' + (!sup ? "bad" : unhealthy ? "warn" : "ok") + '"><span class="glyph">' + icon(!sup || unhealthy ? "alert" : "check") + "</span><div><b>" +
    (!sup ? "监督器不可用" : unhealthy ? unhealthy + " 个后台服务不在正常状态" : "后台服务运行正常") + "</b><small>" +
    (sup ? "监督器启动于 " + time(sup.startedAt) + "，最近巡检 " + ago(sup.lastTickAt) + (sup.paused ? " · 已暂停" : "") : "无法读取监督器状态") + "</small></div></div>" +
    '<div class="kpi"><span>后台服务</span><b>' + (services.length - unhealthy) + "<small> / " + services.length + " 正常</small></b></div>" +
    '<div class="kpi"><span>累计自动恢复</span><b>' + (sup?.recoveries ?? "—") + "</b></div>" +
    '<div class="kpi"><span>消息路由</span><b>' + (state.queueError ? "离线" : "在线") + "</b></div>";
  $("services").innerHTML = services.map(([name, s]) => {
    const [label, tone] = SERVICE_STATES[s.state] ?? [s.state ?? "未知", "idle"];
    return "<tr><td><b>" + esc(SERVICES[name] ?? name) + '</b> <span class="uid">' + esc(name) + "</span></td><td>" + badge(tone, label) + '</td><td class="mono">' + esc(s.pid ?? "—") + "</td><td>" + esc(s.restarts ?? 0) + '</td><td class="err">' + esc(s.lastError ?? "") + "</td></tr>";
  }).join("") || '<tr><td colspan="5" class="empty">没有服务数据</td></tr>';
  const ids = appIds().filter((id) => snap.health?.[id] || ORDER.includes(id));
  $("probes").innerHTML = ids.map((id) => {
    const h = snap.health?.[id];
    if (!h) return '<article class="app-card idle"><div class="app-head">' + monogram(id) + '<div class="names"><b>' + esc(appName(id)) + "</b><small>尚无探测记录</small></div>" + badge("idle", "无数据") + "</div></article>";
    const stale = !fresh(h);
    const tone = stale ? "idle" : { healthy: "ok", degraded: "warn", unhealthy: "bad" }[h.status] ?? "info";
    const label = (stale ? "过期 · " : "") + ({ healthy: "健康", degraded: "降级", unhealthy: "故障", checking: "检查中" }[h.status] ?? h.status);
    const stepRows = (h.steps ?? []).map((step) => {
      const pct = step.timeoutMs ? Math.min(100, (step.elapsedMs / step.timeoutMs) * 100) : 0;
      return '<div class="probe-step"><span>' + esc(STEP_NAMES[step.step] ?? step.step) + '</span><span class="bar' + (step.ok ? "" : " bad") + '"><i data-w="' + pct.toFixed(1) + '"></i></span><span>' + esc(step.elapsedMs) + " ms" + (step.ok ? "" : " ✕") + "</span></div>";
    }).join("");
    const issue = h.status === "healthy" ? null : { tone: stale ? "idle" : tone, title: (stale ? "上次结果：" : "") + (STEP_NAMES[h.failedStep] ?? h.failedStep ?? "探测") + " 失败" + (h.consecutiveFailures ? "（连续 " + h.consecutiveFailures + " 次）" : ""),
      lines: [(h.errorCode ? "<code>" + esc(h.errorCode) + "</code> " : "") + esc(h.error ?? ""), h.repair ? esc(h.repair) : "",
        stale ? "这是 " + esc(ago(h.checkedAt)) + "的结果，不代表当前状态。探测只在会话调用 bridge_health 时运行。" : ""].filter(Boolean), raw: true };
    return '<article class="app-card ' + tone + '"><div class="app-head">' + monogram(id) + '<div class="names"><b>' + esc(appName(id)) + "</b><small>" + esc(ago(h.checkedAt)) + " · 共 " + esc(h.elapsedMs ?? "—") + " ms</small></div>" + badge(tone, label) + "</div>" +
      '<div class="probe-steps">' + stepRows + "</div>" + issueHtml(id, issue) + "</article>";
  }).join("");
}
/* ---------- MCP + skill setup ---------- */
const short = (rev) => (rev ? String(rev).slice(0, 8) : "—");
// Paths under the user's home are shown as ~\...; the full path stays in the tooltip.
const tilde = (file) => {
  const home = state.setup?.home;
  return home && file && String(file).toLowerCase().startsWith(home.toLowerCase()) ? "~" + String(file).slice(home.length) : String(file ?? "");
};
const pathCode = (file) => '<code title="' + esc(file) + '">' + esc(tilde(file)) + "</code>";
const MCP_STATES = {
  current: ["已是当前版本", "ok"], outdated: ["需要更新", "warn"], missing: ["未配置", "warn"], unreadable: ["无法读取", "bad"],
  "not-installed": ["插件未安装", "idle"], "not-applicable": ["不适用", "idle"],
};
const SKILL_STATES = {
  current: ["已是当前版本", "ok"], outdated: ["需要更新", "warn"], missing: ["未安装", "warn"], modified: ["被改动", "warn"], unmanaged: ["同名 skill 非本项目", "bad"],
};
const SKILL_TARGETS = { claude: "~/.claude/skills", agents: "~/.agents/skills（Codex 与 DeepSeek 共用）", antigravity: "Antigravity 插件 skills/" };
const CHANGE_TITLES = {
  "mcp-config": (c) => appName(c.app) + " MCP 配置",
  "cc-switch": () => "cc-switch 登记",
  "antigravity-plugin": () => "Antigravity 插件（MCP 与 skill）",
  skill: (c) => "desktop-bridge skill · " + (SKILL_TARGETS[c.target] ?? c.target),
};
function setupPending(plan) {
  return (plan?.changes ?? []).length;
}
function versionCell(states, row, configured, current) {
  const [label, tone] = states[row?.state] ?? [row?.state ?? "未知", "idle"];
  const pending = row?.pending && row.state === "current" ? badge("warn", "路径待更新") : "";
  const versions = configured || row?.state === "outdated" || row?.state === "current"
    ? '<div class="setup-versions"><code>' + esc(short(configured)) + "</code> → <code>" + esc(short(current)) + "</code></div>" : "";
  return badge(tone, label) + pending + (row?.ccSwitchPending ? badge("warn", "cc-switch 待同步") : "") + versions +
    (row?.error ? '<div class="err">' + esc(row.error) + "</div>" : "") + (row?.note ? '<div class="muted small">' + esc(row.note) + "</div>" : "");
}
function diffHtml(diff) {
  const lines = String(diff ?? "").replace(/\n$/, "").split(/\r?\n/).map((line) => {
    const cls = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    return '<span class="' + cls + '">' + esc(cls === "meta" ? line.slice(0, 4) + tilde(line.slice(4)) : line) + "</span>";
  });
  return '<pre class="diff">' + lines.join("\n") + "</pre>";
}
function changeHtml(change) {
  const title = (CHANGE_TITLES[change.kind] ?? (() => change.kind))(change);
  let body = "";
  if (change.kind === "skill") {
    body = '<p class="muted small">' + esc({ create: "新建", "backup-and-replace": "备份后替换" }[change.action] ?? change.action) + " · " +
      esc(SKILL_STATES[change.state]?.[0] ?? change.state) + " · <code>" + esc(short(change.installedRevision)) + "</code> → <code>" + esc(short(change.revision)) + "</code><br>" + pathCode(change.path) + "</p>";
  } else {
    body = (change.summary ? '<p class="muted small">' + esc(change.summary) + "</p>" : "") + diffHtml(change.diff);
  }
  return '<details class="setup-change"' + (change.kind === "skill" ? "" : " open") + "><summary><b>" + esc(title) + '</b> <span class="muted small">' + esc(tilde(change.path)) + "</span></summary>" + body + "</details>";
}
function renderSetup() {
  const plan = state.setup;
  const pending = setupPending(plan), errorsList = plan?.errors ?? [];
  const tone = state.setupError || errorsList.length ? "bad" : !plan ? "idle" : pending ? "warn" : "ok";
  const title = state.setupError ? "无法检查接入配置" : !plan ? (state.setupLoading ? "正在检查接入配置…" : "尚未检查") :
    errorsList.length ? "有配置无法自动处理" : pending ? pending + " 项待安装或更新" : "MCP 配置与 skill 均为当前版本";
  const apps = plan ? Object.values(plan.apps) : [];
  const mcpCurrent = apps.filter((a) => a.mcp.state === "current" && !a.mcp.pending).length, mcpTotal = apps.filter((a) => !["not-applicable", "not-installed"].includes(a.mcp.state)).length;
  const skillCurrent = apps.filter((a) => a.skill.state === "current").length;
  $("setup-summary").innerHTML =
    '<div class="headline ' + tone + '"><span class="glyph">' + icon(tone === "ok" ? "check" : tone === "idle" ? "minus" : "alert") + "</span><div><b>" + esc(title) + "</b><small>" +
    esc(state.setupError || (plan ? "检查于 " + time(plan.checkedAt) : "打开本页时检查")) + "</small></div></div>" +
    '<div class="kpi"><span>当前客户端版本</span><b class="mono">' + esc(short(plan?.clientRevision)) + "</b></div>" +
    '<div class="kpi"><span>当前 skill 版本</span><b class="mono">' + esc(short(plan?.skillRevision)) + "</b></div>" +
    '<div class="kpi' + (plan && (mcpCurrent < mcpTotal || skillCurrent < apps.length) ? " warn" : "") + '"><span>已是当前版本</span><b>' +
    (plan ? mcpCurrent + "<small> / " + mcpTotal + " MCP</small> · " + skillCurrent + "<small> / " + apps.length + " skill</small>" : "—") + "</b></div>";
  const order = ORDER.filter((id) => plan?.apps?.[id]);
  $("setup-rows").innerHTML = order.map((id) => {
    const row = plan.apps[id];
    const where = [row.mcp.file, row.skill.path].filter(Boolean).map(pathCode).join("<br>");
    const skillVersions = { ...row.skill, pending: false };
    return "<tr><td>" + monogram(id) + " <b>" + esc(appName(id)) + "</b></td><td>" + versionCell(MCP_STATES, row.mcp, row.mcp.configuredRevision, row.mcp.currentRevision) +
      "</td><td>" + versionCell(SKILL_STATES, skillVersions, row.skill.installedRevision, row.skill.revision) +
      (row.skill.action === "skip" ? '<div class="muted small">' + esc(row.skill.reason ?? "") + "</div>" : "") + '</td><td class="setup-where">' + where + "</td></tr>";
  }).join("") || '<tr><td colspan="4" class="empty">' + (state.setupLoading ? "正在检查…" : "没有数据") + "</td></tr>";
  $("setup-changes").innerHTML = errorsList.map((e) => '<p class="detail-error">' + esc(e) + "</p>").join("") +
    ((plan?.changes ?? []).map(changeHtml).join("") || (plan ? '<p class="empty">没有需要改动的内容。</p>' : ""));
  $("setup-apply").disabled = locked() || state.setupLoading || !pending || errorsList.length > 0;
  $("setup-apply").textContent = pending ? "全部安装 / 更新（" + pending + " 项）" : "全部安装 / 更新";
  $("setup-reload-codex").disabled = locked();
  $("setup-check").disabled = state.setupLoading || locked();
}
async function loadSetup() {
  if (state.setupLoading) return;
  state.setupLoading = true;
  renderSetup();
  try {
    const plan = await window.bridge.setup("plan");
    state.setup = { ...plan, checkedAt: new Date().toISOString() };
    state.setupError = "";
  } catch (e) {
    state.setupError = e.message;
  } finally {
    state.setupLoading = false;
    render();
  }
}
$("setup-check").onclick = () => { $("setup-result").textContent = ""; loadSetup(); };
$("setup-apply").onclick = async () => {
  if (locked() || !state.setup) return;
  state.busy = true;
  syncMaintenanceControls();
  render();
  $("setup-result").textContent = "正在写入配置与 skill…";
  try {
    const result = await window.bridge.setup("apply", state.setup.planId);
    state.setup = { ...result.status, checkedAt: new Date().toISOString() };
    const backups = [result.results?.mcp?.backupDirectory, result.results?.antigravity?.backupDirectory].filter(Boolean);
    $("setup-result").textContent = "已应用 " + result.applied + " 项改动。" + (backups.length ? "备份：" + backups.map(tilde).join("、") + "。" : "") +
      (result.status.changes.length ? "仍有 " + result.status.changes.length + " 项未完成，请检查。" : "下一步：让已运行的会话加载新配置。");
    if (result.results?.mcp) $("setup-reload").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    $("setup-result").textContent = e.message;
    state.setup = null;
    void loadSetup();
  } finally {
    state.busy = false;
    syncMaintenanceControls();
    render();
  }
};
$("setup-reload-codex").onclick = async () => {
  if (locked()) return;
  state.busy = true;
  syncMaintenanceControls();
  render();
  $("setup-reload-result").textContent = "正在请求 Codex 全局重载 MCP…";
  try {
    const result = await window.bridge.setup("reload-codex");
    $("setup-reload-result").textContent = "Codex 已重新加载 MCP" + (result?.reloads ? "（第 " + result.reloads + " 次）" : "") + "。各会话下一次调用 bridge_self 时可核验新的客户端版本。";
  } catch (e) {
    $("setup-reload-result").textContent = "未能重载：" + e.message + "。有会话运行中、待审批或存在受保护会话时会推迟，空闲后再试。";
  } finally {
    state.busy = false;
    syncMaintenanceControls();
    render();
  }
};

function renderNav() {
  const ids = appIds(), diagnoses = ids.map(diagnose);
  const appIssues = diagnoses.filter((d) => ["warn", "bad"].includes(d.tone));
  const setBadge = (id, count, tone) => { const el = $(id); el.textContent = count || ""; el.className = count ? tone : ""; };
  setBadge("nav-overview", appIssues.length, appIssues.some((d) => d.tone === "bad") ? "bad" : "warn");
  const c = counts();
  setBadge("nav-messages", c.issue || c.pending, c.issue ? "bad" : "info");
  const compatIssues = Object.keys(state.snapshot?.apps ?? {}).map(diagnose).filter((d) => ["warn", "bad"].includes(d.tone)).length;
  setBadge("nav-compat", compatIssues, "warn");
  const svc = Object.values(state.snapshot?.supervisor?.services ?? {}).filter((s) => s.state !== "healthy").length;
  setBadge("nav-health", svc, "warn");
  setBadge("nav-setup", setupPending(state.setup), state.setup?.errors?.length ? "bad" : "warn");
  $("router-dot").className = "dot " + (state.queueError ? "bad" : state.rows ? "ok" : "");
  $("router-label").textContent = state.queueError ? "路由离线" : "路由在线";
  $("router-meta").textContent = state.queueError ? "无法读取消息队列" : c.all + " 条消息 · 本机";
  $("checked-at").textContent = state.snapshot?.checkedAt ? "桌面检查于 " + ago(state.snapshot.checkedAt) : "";
}
function renderAbout() {
  const snap = state.snapshot ?? {};
  $("about").innerHTML = [
    ["控制台", "Desktop Agent Bridge Console"],
    ["已安装 MCP 版本", snap.installedRevision ?? "—"],
    ["已接入应用", appIds().map(appName).join("、") || "—"],
    ["监督器启动", snap.supervisor ? time(snap.supervisor.startedAt) : "—"],
  ].map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("");
}
// The page CSP forbids inline style attributes; apply data-driven styles through CSSOM.
function hydrate() {
  document.querySelectorAll("[data-hue]").forEach((el) => el.style.setProperty("--hue", el.dataset.hue));
  document.querySelectorAll("[data-n]").forEach((el) => el.style.setProperty("--n", el.dataset.n));
  document.querySelectorAll("[data-w]").forEach((el) => (el.style.width = el.dataset.w + "%"));
}
function render() {
  renderNav();
  renderOverview();
  renderMessages();
  renderCompat();
  renderHealth();
  renderSetup();
  renderAbout();
  hydrate();
}
function page(name, options = {}) {
  state.page = name;
  state.index = 0;
  if (options.filter !== undefined) state.filter = options.filter;
  document.querySelectorAll("[data-view]").forEach((section) => (section.hidden = section.dataset.view !== name));
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  $("page-title").textContent = PAGES[name][0];
  $("page-sub").textContent = PAGES[name][1];
  render();
  document.querySelector("main").scrollTo(0, 0);
  if (name === "setup" && !state.setupLoading) void loadSetup();
}

/* ---------- Message detail drawer ---------- */
function details(id) {
  const r = state.rows.find((x) => x.id === id);
  if (!r) return;
  state.selected = id;
  const timeline = [["已入队", r.createdAt], ["桌面接受", r.deliveredAt], ["对方确认读取", r.acknowledgedAt]].filter((x) => x[1]);
  const fields = [["消息 ID", r.id], ["调用方 ID", r.callerId], ["来源会话", appName(r.from.app) + " / " + r.from.threadId], ["目标会话", appName(r.to.app) + " / " + r.to.threadId], ["队列状态", r.jobStatus], ...(r.review ? [["复核记录", r.review]] : [])];
  $("detail-body").innerHTML = "<div>" + stagePill(r) + " " + esc(kinds[r.kind] ?? r.kind) + '</div><ol class="timeline">' +
    timeline.map(([label, t]) => "<li><span>" + label + "</span><time>" + time(t) + "</time></li>").join("") + '</ol><dl class="facts">' +
    fields.map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v || "—") + "</dd>").join("") + "</dl>" +
    (r.reason ? '<p class="detail-error">' + esc(r.reason) + "</p>" : "") +
    '<div class="detail-actions"><button class="secondary" data-copy>复制消息 ID</button>' + (r.replyId ? '<button class="secondary" data-reply="' + esc(r.replyId) + '">查看关联回复 →</button>' : "") + "</div>";
  hydrate();
  if (!$("detail").open) $("detail").showModal();
}
$("detail-body").onclick = async (e) => {
  if (e.target.hasAttribute("data-copy")) { await window.bridge.copy(state.selected); e.target.textContent = "已复制"; }
  if (e.target.dataset.reply) details(e.target.dataset.reply);
};
$("close").onclick = () => $("detail").close();
$("detail").onclick = (e) => { if (e.target === $("detail")) $("detail").close(); };

/* ---------- Events ---------- */
let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = !text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => ($("toast").hidden = true), 9000);
}
async function runAction(kind, id) {
  if (kind === "certify") { state.certifyApp = id; page("compat"); $("certify-panel").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  if (kind === "health") return page("health");
  if (locked()) return;
  const profile = $("packages").querySelector('select[data-app="' + id + '"]')?.value || undefined;
  state.busy = true;
  syncMaintenanceControls();
  render();
  toast("正在处理…");
  try {
    const result = await window.bridge.update(kind, id, kind === "activate" ? profile : undefined);
    toast(result?.message ?? result ?? "");
    await desktops();
    if (result?.profileId) { const select = $("packages").querySelector('select[data-app="' + id + '"]'); if (select) select.value = result.profileId; }
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
    syncMaintenanceControls();
    render();
  }
}
document.addEventListener("click", (e) => {
  const nav = e.target.closest(".nav");
  if (nav) return page(nav.dataset.page);
  const goto = e.target.closest("[data-goto]");
  if (goto) return page(goto.dataset.goto);
  const filter = e.target.closest("[data-filter]");
  if (filter) { state.filter = filter.dataset.filter; if (state.page !== "messages") page("messages"); else { state.index = 0; render(); } return; }
  const action = e.target.closest("button[data-kind]");
  if (action) return void runAction(action.dataset.kind, action.dataset.app);
  const row = e.target.closest("tr[data-id]");
  if (row) details(row.dataset.id);
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches?.("tr[data-id]")) details(e.target.dataset.id); });
$("search").oninput = () => { state.index = 0; render(); };
$("prev").onclick = () => { state.index--; render(); };
$("next").onclick = () => { state.index++; render(); };
$("certify-app").onchange = () => (state.certifyApp = $("certify-app").value);

/* ---------- Window chrome ---------- */
const maximize = document.querySelector('[data-window="toggleMaximize"]');
function syncWindowState(flag) {
  maximize.classList.toggle("is-maximized", flag);
  maximize.title = flag ? "还原" : "最大化";
  maximize.setAttribute("aria-label", maximize.title);
}
window.bridge.onMaximized(syncWindowState);
window.bridge.windowAction("state").then(syncWindowState);
document.querySelector(".caption-controls").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-window]");
  if (button) window.bridge.windowAction(button.dataset.window);
});

/* ---------- Settings ---------- */
function readTheme() { try { return localStorage.getItem("theme") || "system"; } catch { return "system"; } }
async function applyTheme(value) {
  document.querySelectorAll("#theme button").forEach((b) => { b.classList.toggle("active", b.dataset.theme === value); b.setAttribute("aria-checked", String(b.dataset.theme === value)); });
  try { localStorage.setItem("theme", value); } catch {}
  try { await window.bridge.theme(value); } catch (e) { toast(e.message); }
}
$("theme").onclick = (e) => { const b = e.target.closest("button[data-theme]"); if (b) applyTheme(b.dataset.theme); };
void applyTheme(readTheme());
const loginStartup = $("login-startup");
async function syncLoginStartup(requested) {
  loginStartup.disabled = true;
  try {
    const actual = await window.bridge.loginStartup(requested);
    loginStartup.checked = actual;
    $("startup-note").textContent = actual ? "已注册当前用户登录启动项" : "进入 Windows 后显示本机工作区";
    if (requested !== undefined && requested !== actual) throw Error("Windows 启动项状态未生效");
  } catch (error) {
    $("startup-note").textContent = error.message;
  } finally { loginStartup.disabled = false; }
}
loginStartup.onchange = () => syncLoginStartup(loginStartup.checked);
syncLoginStartup();

/* ---------- Certification ---------- */
$("certify-form").onsubmit = async (event) => {
  event.preventDefault();
  if (locked()) return;
  state.busy = true;
  syncMaintenanceControls();
  $("certify-result").textContent = "正在准备测试会话并验收两端回执…";
  try { $("certify-result").textContent = await window.bridge.certify($("certify-app").value); }
  catch (e) { $("certify-result").textContent = e.message; }
  finally { state.busy = false; syncMaintenanceControls(); await desktops(); }
};
function syncMaintenanceControls() {
  const operation = state.maintenance, status = $("maintenance-status");
  status.hidden = !operation;
  status.textContent = operation ? "正在" + operation.label + "，开始于 " +
    new Date(operation.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) + "。完成后可继续操作。" : "";
  $("certify-form").querySelector("button").disabled = locked();
  $("canary-watch").disabled = !!(watching || locked());
}
async function maintenanceStatus() {
  try {
    const operation = await window.bridge.maintenance();
    const changed = JSON.stringify(operation) !== JSON.stringify(state.maintenance);
    state.maintenance = operation;
    syncMaintenanceControls();
    if (changed) render();
  } catch (e) { $("maintenance-status").hidden = false; $("maintenance-status").textContent = "无法读取维护状态。" + e.message; }
}
async function watchStatus(change = false) {
  if (watching) return;
  watching = true;
  const toggle = $("canary-watch");
  toggle.disabled = true;
  try {
    const prefs = await window.bridge.canaryWatch(change ? toggle.checked : undefined);
    toggle.checked = prefs.enabled;
    const last = prefs.attempts?.[prefs.latest];
    $("canary-watch-status").textContent = last
      ? "最近一次：" + [last.status, time(last.at), last.error, ...Object.entries(last.packages || {}).map(([app, p]) => appName(app) + " " + (p.capabilities || []).map(capLabel).join("、"))].filter(Boolean).join(" · ")
      : "尚未自动验收过构建";
  } catch (e) { if (change) toggle.checked = !toggle.checked; $("canary-watch-status").textContent = e.message; }
  finally { watching = false; syncMaintenanceControls(); }
}
$("canary-watch").onchange = () => watchStatus(true);
void watchStatus();
void maintenanceStatus();
setInterval(() => { if (!document.hidden) void maintenanceStatus(); }, 1000);
setInterval(() => { if (!document.hidden && !$("canary-watch").disabled) void watchStatus(); }, 30000);

/* ---------- Data loading ---------- */
function errors() {
  const msg = [state.queueError, state.adapterError].filter(Boolean).join(" · ");
  $("alert").hidden = !msg;
  $("alert").textContent = msg;
}
let fetching = false, inspecting = false;
async function queue() {
  if (fetching) return;
  fetching = true;
  try {
    const { messages } = await window.bridge.queue();
    const changed = JSON.stringify(messages) !== JSON.stringify(state.rows) || state.queueError;
    state.rows = messages;
    state.queueError = "";
    if (changed) { render(); if ($("detail").open) details(state.selected); }
  } catch (e) {
    state.queueError = "无法读取队列。" + e.message;
    render();
  } finally { fetching = false; errors(); }
}
async function desktops() {
  if (inspecting) return;
  inspecting = true;
  $("refresh").classList.add("spinning");
  try {
    state.snapshot = await window.bridge.desktops();
    state.adapterError = "";
  } catch (e) {
    state.adapterError = "桌面检查失败。" + e.message;
  } finally {
    inspecting = false;
    $("refresh").classList.remove("spinning");
    errors();
    render();
  }
}
$("refresh").onclick = () => { queue(); desktops(); if (state.page === "setup") loadSetup(); };
page("overview");
queue();
desktops();
void loadSetup();
setInterval(queue, 3000);
setInterval(() => { if (!document.hidden && !locked()) desktops(); }, 60000);
setInterval(() => { if (!document.hidden) renderNav(); }, 30000);
