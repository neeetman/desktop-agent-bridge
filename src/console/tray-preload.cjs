const { ipcRenderer } = require("electron");
const NAMES = { codex: "Codex", claude: "Claude", deepseek: "DeepSeek", antigravity: "Antigravity" };
// Short per-app line for the tray: the full diagnosis lives in the console overview.
// Health samples older than 15 minutes are history (probes run only on bridge_health).
const fresh = (at) => !!at && Date.now() - new Date(at).getTime() < 15 * 60 * 1000;
function summary(row) {
  if (row.service !== undefined) return !row.service ? ["bad", "服务离线"] : row.desktop ? ["ok", "服务在线"] : ["idle", "服务在线 · 桌面未打开"];
  if (row.phase === "blocked") return ["bad", "未知构建"];
  if (row.phase === "not_installed") return ["idle", "未安装"];
  if (row.phase === "contract_mismatch") return ["bad", "接口契约不符"];
  if (row.phase === "app_not_running") return ["idle", "未运行"];
  if (row.bridgeService === false) return ["warn", "桥接服务未就绪"];
  if (row.bridgeService === true && row.phase === "ready") return ["ok", "已连接"];
  if (["incompatible", "attachment_error"].includes(row.monitor)) return ["warn", "已匹配 · 未附着"];
  if (["waiting_for_native_callback", "awaiting_native_callback"].includes(row.monitor)) return ["warn", "等待原生回调"];
  if (fresh(row.healthAt) && row.health === "unhealthy") return ["bad", "探测失败"];
  if (fresh(row.healthAt) && row.health === "degraded") return ["warn", "健康降级"];
  if (["attached", "ready"].includes(row.phase) || row.monitor === "installed") return ["ok", "已附着"];
  if (row.phase === "selected") return ["warn", "已匹配 · 未附着"];
  return ["idle", "未附着"];
}
window.addEventListener("DOMContentLoaded", () => {
  for (const id of ["open", "quit"])
    document.getElementById(id).onclick = () =>
      ipcRenderer.send("tray:action", id);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ipcRenderer.send("tray:action", "hide");
  });
  ipcRenderer.on("tray:status", (_event, status) => {
    for (const id of ["pending", "read", "issues", "label"])
      document.getElementById(id).textContent = status[id] ?? "—";
    document.getElementById("label").classList.toggle("off", !status.apps && status.pending === undefined);
    document.getElementById("issues").classList.toggle("hot", status.issues > 0);
    const list = document.getElementById("apps");
    list.replaceChildren(...(status.apps ?? []).map((row) => {
      const [tone, text] = summary(row), item = document.createElement("li");
      item.className = tone;
      item.append(document.createElement("i"));
      const name = document.createElement("span"), note = document.createElement("small");
      name.textContent = NAMES[row.app] ?? row.app;
      note.textContent = text;
      item.append(name, note);
      return item;
    }));
  });
});
