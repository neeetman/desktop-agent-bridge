"use strict";
const $ = (id) => document.getElementById(id);
const loginStartup = $("login-startup");
async function syncLoginStartup(requested) {
  loginStartup.disabled = true;
  try {
    const actual = await window.bridge.loginStartup(requested);
    loginStartup.checked = actual;
    $("startup-note").textContent = actual ? "　已启用" : "　已关闭";
    if (requested !== undefined && requested !== actual) throw Error("Windows 启动项状态未生效");
  } catch (error) {
    $("startup-note").textContent = error.message;
  } finally { loginStartup.disabled = false; }
}
loginStartup.onchange = () => syncLoginStartup(loginStartup.checked);
syncLoginStartup();
const maximize = document.querySelector('[data-window="toggleMaximize"]');
function syncWindowState(flag) {
  maximize.classList.toggle("is-maximized", flag);
  maximize.title = flag ? "还原" : "最大化";
  maximize.setAttribute("aria-label", maximize.title);
}
window.bridge.onMaximized(syncWindowState);
window.bridge.windowAction("state").then(syncWindowState);
document.querySelector(".caption-controls").addEventListener("click", event => {
  const button = event.target.closest("button[data-window]");
  if (button) window.bridge.windowAction(button.dataset.window);
});
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
const icons = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  messages: '<path d="M4 4h16v12H9l-5 4z"/><path d="M8 8h8m-8 4h5"/>',
  sliders:
    '<path d="M4 6h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="17" r="2"/>',
  monitor:
    '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8m-4-3v3"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8m2-14v6h-6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  check: '<path d="m3 12 4 4 10-11m-5 10 2 2 8-9"/>',
  issue: '<path d="M12 3 2 20h20L12 3zm0 6v5m0 2v1"/>',
};
const icon = (name) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  icons[name] +
  "</svg>";
document
  .querySelectorAll("i[data-icon]")
  .forEach((i) => (i.innerHTML = icon(i.dataset.icon)));
const labels = { home: "通信总览", queue: "消息队列", adapters: "适配管理" };
const stages = {
  queued: "已入队",
  waiting_for_adapter: "等待适配",
  dispatching: "投递中",
  delivered: "已投递",
  acknowledged: "已读",
  replied: "已回复",
  unknown: "结果未知",
  failed: "失败",
  expired: "已过期",
  interrupted: "已中断",
  completed: "已完成",
  awaiting_ack: "等待确认",
};
const kinds = {
  message: "消息",
  reply: "回复",
  health: "健康通知",
  decision_answer: "决策答复",
  decision_request: "决策请求",
};
const apps = {
  codex: "Codex",
  claude: "Claude",
  deepseek: "DeepSeek",
  bridge: "Bridge",
};
const names = ["codex", "claude", "deepseek"];
const symbols = { codex: "⌁", claude: "✳", deepseek: "≈" };
const state = {
  page: "home",
  rows: [],
  apps: {},
  profiles: [],
  index: 0,
  selected: null,
  busy: false,
  deepseek: null,
  queueError: "",
  adapterError: "",
};
function group(stage) {
  if (["unknown", "failed", "interrupted"].includes(stage)) return "issue";
  if (["acknowledged", "replied"].includes(stage)) return "read";
  if (
    ["queued", "waiting_for_adapter", "dispatching", "awaiting_ack"].includes(
      stage,
    )
  )
    return "pending";
  return stage;
}
function pill(stage) {
  return (
    '<span class="pill ' +
    esc(group(stage)) +
    '">' +
    esc(stages[stage] || stage) +
    "</span>"
  );
}
function tag(name) {
  return (
    '<span class="tag ' +
    (names.includes(name) ? name : "") +
    '">' +
    esc(apps[name] || name) +
    "</span>"
  );
}
function symbol(name) {
  return '<span class="symbol ' + name + '">' + symbols[name] + "</span>";
}
const time = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
function phase(name) {
  if (name === "deepseek")
    return state.deepseek === null
      ? "检查中"
      : state.deepseek
        ? "服务在线"
        : "离线";
  const row = state.apps[name];
  return (
    {
      attached: "已附着",
      ready: "已就绪",
      blocked: "等待适配",
      selected: "已匹配",
      notAttached: "待连接",
    }[row?.phase] ||
    row?.phase ||
    "待检查"
  );
}
function phaseTone(name) {
  if (name === 'deepseek') return state.deepseek === true ? 'read' : state.deepseek === false ? 'issue' : 'neutral';
  const phase = state.apps[name]?.phase;
  if (phase === 'ready' || phase === 'attached') return 'read';
  return phase === 'blocked' ? 'issue' : 'neutral';
}
function version(row) {
  return (
    row?.runningBuild?.packageVersion || row?.installedBuild?.version || "—"
  );
}
function workerSummary(app) {
  const workers = (state.workers || []).filter(worker => worker.app === app);
  if (state.unverifiedWorkerApps?.includes(app)) return '<p class="meta">暂时无法核验 MCP 进程，请刷新后再查看。</p>';
  if (!workers.length) return '<p class="meta">暂无已核实的 MCP 进程</p>';
  const rows = workers.map(worker => {
    const status = !worker.revision ? '版本未知' : worker.revision === state.installedRevision ? '当前版本' : '建议重载';
    return '<li>' + esc(worker.threadId || '进程 ' + worker.pid) + ' · ' + status + '</li>';
  });
  const stale = workers.filter(worker => worker.revision && worker.revision !== state.installedRevision).length;
  const hint = app === 'claude' ? '空闲时可重连指定会话。' : '在空闲且无受保护会话时全局重载。';
  return '<details><summary>MCP 进程 · ' + workers.length + ' 个，' + stale + ' 个建议重载' +
    '</summary><ul>' + rows.join('') + '</ul><p>' + hint + '</p></details>';
}
function renderDesktops() {
  $("endpoints").innerHTML = names
    .map(
      (n) =>
        '<div class="endpoint">' +
        symbol(n) +
        "<b>" +
        apps[n] +
        "</b><small>" +
        esc(n === "deepseek" ? "Harness" : version(state.apps[n])) +
        '</small><span class="state ' + phaseTone(n) + '">' +
        esc(phase(n)) +
        "</span></div>",
    )
    .join("");
  const previous = Object.fromEntries(
    [...$("packages").querySelectorAll("select")].map((e) => [
      e.dataset.app,
      { value: e.options.length > 1 ? e.value : undefined, expanded: e.closest("article").querySelector("details")?.open },
    ]),
  );
  $("packages").innerHTML = names
    .slice(0, 2)
    .map((n) => {
      const row = state.apps[n] || {},
        profiles = state.profiles.filter((p) => p.app === n),
        selected = previous[n]?.value ?? row.profileId;
      const button = (action, title, primary = false) =>
        '<button data-app="' + n + '" data-action="' + action + '" class="' +
        (primary ? 'primary' : 'secondary') + '"' + (state.busy ? ' disabled' : '') + '>' + title + '</button>';
      const options = profiles.map(profile => '<option value="' + esc(profile.id) + '"' +
        (profile.id === selected ? ' selected' : '') + '>' + esc(profile.id) + '</option>').join('');
      const tone = phaseTone(n);
      return '<article class="package"><div class="package-head">' + symbol(n) + '<h2>' + apps[n] +
        '</h2><span class="pill ' + tone + '">' + esc(phase(n)) + '</span></div>' +
        '<div class="package-info"><div><span>运行版本</span><b>' + esc(version(row)) +
        '</b></div><div><span>匹配配置</span><code>' + esc(row.profileId || row.code || '尚未匹配') +
        '</code></div></div><div class="worker-info">' + workerSummary(n) + '</div>' +
        '<div class="package-actions">' + button('probe','检查连接') + button('upstream','检查 GitHub') +
        button('local','导入本机包') + button('discover','生成候选') + '</div><div class="activation"><label for="profile-' + n +
        '">激活配置</label><div><select id="profile-' + n + '" data-app="' + n +
        '"><option value="">自动匹配</option>' + options + '</select>' + button('activate','空闲时激活',true) +
        '</div></div></article>';
    })
    .join("");
  for (const select of $("packages").querySelectorAll("select")) {
    const details = select.closest("article").querySelector("details");
    if (details && previous[select.dataset.app]?.expanded) details.open = true;
  }
}
function queueGroup(row) {
  return row.review ? "reviewed" : group(row.stage);
}
function renderRows() {
  const q = $("search").value.trim().toLowerCase(),
    f = $("filter").value;
  const filtered = state.rows.filter(
    (r) =>
      (!f || queueGroup(r) === f) &&
      (!q || JSON.stringify(r).toLowerCase().includes(q)),
  );
  const size = state.page === "home" ? 5 : 20;
  state.index = Math.min(
    state.index,
    Math.max(0, Math.ceil(filtered.length / size) - 1),
  );
  const start = state.index * size;
  $("rows").innerHTML =
    filtered
      .slice(start, start + size)
      .map(
        (r) =>
          '<tr tabindex="0" data-id="' +
          esc(r.id) +
          '"><td><span class="msg-title">' +
          esc(r.callerId || kinds[r.kind] || r.kind) +
          '</span><small class="uid">' +
          esc(r.id) +
          '</small></td><td><span class="route">' +
          tag(r.from.app) +
          '<span class="arrow">→</span>' +
          tag(r.to.app) +
          "</span></td><td>" +
          pill(r.stage) +
          "</td><td><time>" +
          time(r.createdAt) +
          '</time></td><td class="arrow">›</td></tr>',
      )
      .join("") ||
    '<tr><td colspan="5" class="empty">' +
      (state.queueError ? "队列暂不可用" : "没有匹配的消息") +
      "</td></tr>";
  $("range").textContent = filtered.length
    ? start +
      1 +
      "–" +
      Math.min(start + size, filtered.length) +
      " / " +
      filtered.length +
      " 条消息"
    : "0 条消息";
  $("prev").disabled = start === 0;
  $("next").disabled = start + size >= filtered.length;
  $("stats").innerHTML = [
    ["", "全部消息", "messages"],
    ["pending", "待处理", "clock"],
    ["read", "已读或已回复", "check"],
    ["issue", "需检查", "issue"],
  ]
    .map(
      ([key, label, glyph]) =>
        '<button class="stat" data-status="' +
        key +
        '"><span>' +
        label +
        "</span><b>" +
        (key
          ? state.rows.filter((r) => queueGroup(r) === key).length
          : state.rows.length) +
        "</b><i>" +
        icon(glyph) +
        "</i></button>",
    )
    .join("");
}
function page(name) {
  state.page = name;
  state.index = 0;
  $("overview").hidden = name !== "home";
  $("messages").hidden = name === "adapters";
  $("adapters").hidden = name !== "adapters";
  $("see-all").hidden = name !== "home";
  $("heading").textContent = labels[name];
  $("crumb").textContent = "工作空间　/　" + labels[name];
  $("eyebrow").textContent = {
    home: "OVERVIEW",
    queue: "DELIVERY MONITOR",
    adapters: "COMPATIBILITY",
  }[name];
  $("table-heading").textContent = name === "home" ? "最近消息" : "投递记录";
  document
    .querySelectorAll(".nav")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  renderRows();
  window.scrollTo(0, 0);
}
function details(id) {
  const r = state.rows.find((x) => x.id === id);
  if (!r) return;
  state.selected = id;
  const timeline = [
    ["已入队", r.createdAt],
    ["桌面接受", r.deliveredAt],
    ["对方确认读取", r.acknowledgedAt],
  ].filter((x) => x[1]);
  const fields = [
    ["消息 ID", r.id],
    ["调用方 ID", r.callerId],
    ["来源会话", r.from.app + " / " + r.from.threadId],
    ["目标会话", r.to.app + " / " + r.to.threadId],
    ["队列状态", r.jobStatus],
    ...(r.review ? [["复核记录", r.review]] : []),
  ];
  $("detail-body").innerHTML =
    "<h2>投递详情　" +
    pill(r.stage) +
    '</h2><ol class="timeline">' +
    timeline
      .map(([label, t]) => "<li>" + label + "<time>" + time(t) + "</time></li>")
      .join("") +
    "</ol><dl>" +
    fields
      .map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v || "—") + "</dd>")
      .join("") +
    "</dl>" +
    (r.reason ? '<p class="detail-error">' + esc(r.reason) + "</p>" : "") +
    '<div class="detail-actions"><button class="quiet" data-copy>复制消息 ID</button>' +
    (r.replyId
      ? '<button class="quiet" data-reply="' +
        esc(r.replyId) +
        '">查看关联回复 →</button>'
      : "") +
    "</div>";
  if (!$("detail").open) $("detail").showModal();
}
$("detail-body").onclick = async (e) => {
  if (e.target.hasAttribute("data-copy")) {
    await window.bridge.copy(state.selected);
    e.target.textContent = "已复制";
  }
  if (e.target.dataset.reply) details(e.target.dataset.reply);
};
$("close").onclick = () => $("detail").close();
$("rows").onclick = (e) => {
  const row = e.target.closest("tr[data-id]");
  if (row) details(row.dataset.id);
};
$("rows").onkeydown = (e) => {
  if (e.key === "Enter") e.target.closest("tr")?.click();
};
document
  .querySelectorAll(".nav")
  .forEach((b) => (b.onclick = () => page(b.dataset.page)));
$("see-all").onclick = () => page("queue");
$("stats").onclick = (e) => {
  const b = e.target.closest("button");
  if (b) {
    $("filter").value = b.dataset.status;
    page("queue");
  }
};
$("search").oninput = $("filter").onchange = () => {
  state.index = 0;
  renderRows();
};
$("prev").onclick = () => {
  state.index--;
  renderRows();
};
$("next").onclick = () => {
  state.index++;
  renderRows();
};
function errors() {
  const msg = [state.queueError, state.adapterError]
    .filter(Boolean)
    .join(" · ");
  $("alert").hidden = !msg;
  $("alert").textContent = msg;
}
let fetching = false,
  inspecting = false;
async function queue() {
  if (fetching) return;
  fetching = true;
  try {
    const { messages } = await window.bridge.queue();
    const changed = JSON.stringify(messages) !== JSON.stringify(state.rows);
    state.rows = messages;
    state.queueError = "";
    if (changed) {
      renderRows();
      if ($("detail").open) details(state.selected);
    }
  } catch (e) {
    state.queueError = "无法读取队列。" + e.message;
  } finally {
    fetching = false;
    errors();
    $("network").textContent = state.queueError ? "路由离线" : "路由在线";
    $("network").classList.toggle("online", !state.queueError);
    $("router-state").textContent = state.queueError ? "离线" : "在线";
  }
}
async function desktops() {
  if (inspecting) return;
  inspecting = true;
  try {
    const data = await window.bridge.desktops();
    Object.assign(state, data);
    state.adapterError = "";
    renderDesktops();
  } catch (e) {
    state.adapterError = "桌面检查失败。" + e.message;
  } finally {
    inspecting = false;
    errors();
  }
}
$("packages").onclick = async (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b || state.busy) return;
  const id = b.closest("article").querySelector("select").value;
  state.busy = true;
  renderDesktops();
  $("result").hidden = false;
  $("result").textContent = "正在处理…";
  try {
    const result = await window.bridge.update(
      b.dataset.action,
      b.dataset.app,
      id,
    );
    $("result").textContent = result?.message ?? result;
    await desktops();
    if (result?.profileId)
      $("packages").querySelector(
        'select[data-app="' + b.dataset.app + '"]',
      ).value = result.profileId;
  } catch (err) {
    $("result").textContent = err.message;
  } finally {
    state.busy = false;
    renderDesktops();
    $("result").hidden = !$("result").textContent;
  }
};
$("refresh").onclick = () => {
  queue();
  desktops();
};
$("certify-form").onsubmit=async event=>{
  event.preventDefault();
  if(state.busy)return;
  state.busy=true;
  const form=event.currentTarget,button=form.querySelector("button");
  button.disabled=true;
  $("certify-result").textContent="正在检查原生接口并等待两端消费回执…";
  try {
    $("certify-result").textContent=await window.bridge.certify($("certify-app").value,$("certify-codex").value.trim(),$("certify-claude").value.trim());
  } catch(e){$("certify-result").textContent=e.message;}
  finally {button.disabled=false;state.busy=false;await desktops();}
};
async function watchStatus(change=false){
  const toggle=$("canary-watch");
  toggle.disabled=true;
  try{
    const prefs=await window.bridge.canaryWatch(change?toggle.checked:undefined,{codex:$("certify-codex").value.trim(),claude:$("certify-claude").value.trim()});
    toggle.checked=prefs.enabled;
    for(const name of ["codex","claude"])if(!change&&!$("certify-"+name).value)$("certify-"+name).value=prefs.threads?.[name]||"";
    const last=prefs.attempts[prefs.latest];
    $("canary-watch-status").textContent=last?[last.status,last.error,...Object.entries(last.packages||{}).map(([app,p])=>app+" "+(p.capabilities||[]).join(", ")+" · "+p.folder)].filter(Boolean).join(" · "):"";
  }catch(e){if(change)toggle.checked=!toggle.checked;$("canary-watch-status").textContent=e.message;}
  finally{toggle.disabled=false;}
}
$("canary-watch").onchange=()=>watchStatus(true);
void watchStatus();
setInterval(()=>{if(!document.hidden&&!$("canary-watch").disabled)void watchStatus();},30000);
renderDesktops();
page("home");
queue();
desktops();
setInterval(queue, 3000);
setInterval(() => {
  if (!document.hidden && !state.busy) desktops();
}, 60000);
