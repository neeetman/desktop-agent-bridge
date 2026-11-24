const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, Notification } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = app.isPackaged
  ? require("./package.json").bridgeRoot
  : path.resolve(__dirname, "../..");
// The console is often started without a usable stdout/stderr (from a shell
// that has exited, or a packaged build with no console). A failed write to them
// must never surface as an uncaught "write EPIPE" dialog.
for (const stream of [process.stdout, process.stderr]) stream?.on?.("error", () => {});
const logFile = path.join(root, "runtime/console/console.log");
function logLine(...parts) {
  const line = new Date().toISOString() + " " + parts.map(String).join(" ") + "\n";
  fs.mkdir(path.dirname(logFile), { recursive: true })
    .then(() => fs.appendFile(logFile, line))
    .catch(() => {});
}
const page = pathToFileURL(path.join(__dirname, "index.html")).href;
const compatModule = (file) => import(pathToFileURL(path.join(root, "src/compat", file)).href);
let window,
  trayControl,
  updating = null;
function maintenanceMessage() {
  return `正在${updating.label}（开始于 ${new Date(updating.startedAt).toLocaleTimeString("zh-CN", {hour12:false})}），请等待完成后再操作。`;
}
function beginMaintenance(label) {
  if (updating) throw Error(maintenanceMessage());
  updating = {label, startedAt:new Date().toISOString()};
}
app.setName("Desktop Agent Bridge");
nativeTheme.themeSource="system";
app.setPath(
  "userData",
  path.join(
    app.getPath("appData"),
    "Desktop Agent Bridge",
    "console-" + createHash("sha256").update(root).digest("hex").slice(0, 12),
  ),
);

async function read(file) {
  return JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
}
async function local(file, route) {
  const c = await read(file);
  const base = new URL(c.baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1")
    throw Error("Invalid local endpoint");
  const res = await fetch(new URL(route, base), {
    headers: { Authorization: "Bearer " + c.token },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw Error("HTTP " + res.status);
  return res.json();
}
function run(executable, args, input, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd: root, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(Error(stderr.trim() || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(Error("Invalid response from bridge command"));
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
async function config() {
  return read("runtime/supervisor/config.json").catch(() => ({}));
}
async function cli(...args) {
  return run(
    process.env.DESKTOP_BRIDGE_NODE || (await config()).node || "node",
    [path.join(root, "bin/desktop-agent-bridge.mjs"), ...args],
  );
}
async function queueWithReviews() {
      const queue = await local("runtime/router/connection.json", "/v1/queue");
      const reviews = await read("runtime/console-reviews.json").catch(error => {
        if (error.code === "ENOENT") return {};
        throw error;
      });
      for (const row of queue.messages) {
        const review = reviews[row.id];
        if (review && review.stage === row.stage && review.jobStatus === row.jobStatus && review.reason === row.reason)
          row.review = review.note;
      }
      return queue;
}

// Read-only operator context for the console: native monitor files, supervisor
// service state, the latest health sample per app and the certification report
// behind each selected profile. Every source is optional.
async function optionalJson(file) {
  return read(file).catch(() => null);
}
function monitorRow(value) {
  if (!value) return null;
  const rows = Array.isArray(value.processes) && value.processes.length ? value.processes : [value];
  const row = rows.find(item => item?.state && item.state !== "installed") ?? rows[0];
  return row ? {state: row.state ?? null, code: row.code ?? null, error: row.error ?? row.detail ?? null,
    time: typeof row.time === "number" ? new Date(row.time * 1000).toISOString() : null} : null;
}
// The router persists the latest probe result per app. Probes run only when a
// session calls bridge_health, so the console shows the sample's age and never
// starts a probe itself. Only health fields leave this function.
async function latestHealth() {
  const saved = (await optionalJson("runtime/router/state.json"))?.health ?? {};
  return Object.fromEntries(Object.entries(saved).filter(([, row]) => row && typeof row === "object").map(([app, row]) => [app, {
    status: row.status, ok: row.ok, checkedAt: row.checkedAt, elapsedMs: row.elapsedMs,
    failedStep: row.failedStep, errorCode: row.errorCode, error: row.error, repair: row.repair,
    consecutiveFailures: row.consecutiveFailures, lastSuccessAt: row.lastSuccessAt,
    steps: (row.steps ?? []).map(({step, elapsedMs, timeoutMs, ok, errorCode}) => ({step, elapsedMs, timeoutMs, ok, errorCode})),
  }]));
}
async function certification(profileId) {
  const run = /-caps-([0-9a-f]{8})$/.exec(profileId ?? "")?.[1];
  if (!run) return null;
  const directory = path.join(root, "runtime/router/canary");
  const folder = (await fs.readdir(directory).catch(() => [])).find(name => name.startsWith(run));
  const report = folder && await optionalJson(path.join("runtime/router/canary", folder, "report.json"));
  if (!report) return null;
  const app = profileId.split("-")[0];
  const checks = Object.fromEntries(Object.entries(report[app]?.checks ?? {}).map(([name, check]) =>
    [name, {status: check.status, reason: check.reason ?? null}]));
  return {runId: report.runId, stage: report.stage, checks};
}
async function supervisorStatus() {
  const status = await local("runtime/supervisor/connection.json", "/status").catch(() => null);
  if (!status) return null;
  return {
    startedAt: status.startedAt, lastTickAt: status.lastTickAt, paused: status.paused, recoveries: status.recoveries,
    services: Object.fromEntries(Object.entries(status.services ?? {}).map(([name, row]) =>
      [name, {pid: row.pid, state: row.state, restarts: row.restarts, failures: row.failures, lastError: row.lastError}])),
    apps: Object.fromEntries(Object.entries(status.apps ?? {}).map(([name, row]) =>
      [name, {pid: row.pid, state: row.state, updatePending: row.updatePending, closedByUser: row.closedByUser}])),
  };
}
let lastSnapshot = null;

function checkedApp(v) {
  if (!["codex", "claude"].includes(v)) throw Error("Invalid desktop");
  return v;
}
function runCertification(app,config) {
  return run(config.node||"node",[path.join(root,"bin/desktop-agent-bridge.mjs"),"compat","certify","--app",app],undefined,1020000);
}
const watchFile=path.join(root,"runtime/candidates/console-watch.json");
async function watchSettings() {
  const {readJson}=await compatModule("compatibility.mjs");
  return readJson(watchFile,{enabled:false,attempts:{}});
}
async function checkUnknown() {
  if(updating)return;
  beginMaintenance("检查未知桌面构建");
  try {
    const prefs=await watchSettings();
    if(!prefs.enabled)return;
    const {watchUnknownBuilds}=await compatModule("update-watch.mjs");
    const {atomicJson}=await compatModule("compatibility.mjs");
    const cfg=await config();
    await watchUnknownBuilds(prefs,{
      doctor:()=>cli("doctor"),
      certify:app=>{updating.label="自动验收未知构建（最长约 17 分钟）";return runCertification(app,cfg);},
      importPackage:folder=>cli("compat","import",folder),
      activate:(app,profileId)=>cli("compat","activate","--app",app,"--profile",profileId,"--when-idle"),
      notify,save:value=>atomicJson(watchFile,value),now:Date.now,
    });
  } finally {updating=null;}
}
function notify(title,body){
  logLine("Notification:",title,body);
  try{if(Notification.isSupported())new Notification({title:"桌面桥接："+title,body}).show();}catch(e){logLine("Notification failed:",e.message);}
}
const stalledFile=path.join(root,"runtime/candidates/stalled-alerts.json");
async function checkStalled() {
  const {stalledDeliveries}=await compatModule("update-watch.mjs");
  const {readJson,atomicJson}=await compatModule("compatibility.mjs");
  const queue=await local("runtime/router/connection.json","/v1/queue");
  const alerts=readJson(stalledFile,{});
  const {changed}=stalledDeliveries(queue.messages??[],alerts,{notify,now:Date.now});
  if(changed)atomicJson(stalledFile,alerts);
}
const deepseekFile=path.join(root,"runtime/candidates/deepseek-selftest.json");
async function checkDeepseek() {
  const {deepseekSelfTest}=await compatModule("update-watch.mjs");
  const {readJson,atomicJson}=await compatModule("compatibility.mjs");
  const native=path.join(root,"runtime/deepseek-native");
  const state=readJson(deepseekFile,{});
  const result=await deepseekSelfTest(state,{
    imported:()=>readJson(path.join(native,"imported.json"),null),
    rpc:async(method,args)=>{
      const c=readJson(path.join(native,"connection.json"));
      const response=await fetch(c.baseUrl+"/rpc",{method:"POST",headers:{Authorization:"Bearer "+c.token,"Content-Type":"application/json"},body:JSON.stringify({method,args}),signal:AbortSignal.timeout(20000)});
      const value=await response.json();if(!response.ok)throw Error(value.error??("HTTP "+response.status));return value.result;
    },
    notify,now:Date.now,
  });
  if(["passed","failed"].includes(result.action))atomicJson(deepseekFile,state);
}
async function confirm(title, detail) {
  const result = await dialog.showMessageBox(window, {
    type: "question",
    title,
    message: title,
    detail,
    buttons: ["取消", "确认"],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}
async function update(action, value, chosenProfile) {
  const desktop = checkedApp(value);
  beginMaintenance(({
    probe:"检查 " + desktop + " 连接", discover:"生成 " + desktop + " 候选包",
    local:"导入本机适配包", upstream:"检查 GitHub 适配包", activate:"激活适配包",
  })[action] || "处理适配包");
  let dir;
  try {
    if (action === "probe") {
      const result = await cli("doctor", "--app", desktop, "--probe");
      return result.probe.ready ? "原生接口已就绪。" : "原生接口正在等待连接。";
    }
    if (action === "discover") {
      const result = await cli("compat","discover","--app",desktop);
      return "候选包已生成，尚待验收。 "+result.folder;
    }
    if (action === "local") {
      const choice = await dialog.showOpenDialog(window, {
        title: "选择可信适配包目录",
        properties: ["openDirectory"],
      });
      if (choice.canceled) return "";
      const folder = choice.filePaths[0],
        profile = JSON.parse(
          await fs.readFile(path.join(folder, "profile.json"), "utf8"),
        );
      if (profile.app !== desktop) throw Error("该适配包与所选桌面不匹配");
      if (!(await confirm("导入本机适配包？", profile.id + "\n" + folder)))
        return "";
      const result = await cli("compat", "import", folder);
      return {
        message: "已导入适配包 " + result.profileId + "。请选择“空闲时激活”以附着并检查就绪状态。",
        profileId: result.profileId,
      };
    }
    if (action === "upstream") {
      const data = await cli("doctor", "--app", desktop);
      dir = await fs.mkdtemp(path.join(tmpdir(), "desktop-bridge-profile-"));
      const result = await run(
        (await config()).python || "python",
        [path.join(root, "scripts/runtime/console_upstream.py"), desktop, dir],
        JSON.stringify(data.apps[desktop]?.runningBuild?.hashes ?? null),
      );
      if (
        !(await confirm(
          "导入匹配的 GitHub 适配包？",
          result.id + "\nneeetman/desktop-agent-bridge @ " + result.revision,
        ))
      )
        return "";
      const imported = await cli("compat", "import", dir);
      return {
        message: "已导入适配包 " + imported.profileId + "。请选择“空闲时激活”以附着并检查就绪状态。",
        profileId: imported.profileId,
      };
    }
    if (action === "activate") {
      const profile = await cli(
        "compat",
        "plan",
        "--app",
        desktop,
        ...(chosenProfile ? ["--profile", chosenProfile] : []),
      );
      if (!(await confirm("空闲时激活适配包？", profile.to))) return "";
      await cli(
        "compat",
        "activate",
        "--app",
        desktop,
        "--profile",
        profile.to,
        "--when-idle",
      );
      return "已激活 " + profile.to;
    }
    throw Error("Unknown operation");
  } finally {
    try {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    } finally { updating = null; }
  }
}

function bind(name, fn) {
  ipcMain.handle("bridge:" + name, (event, ...args) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== page
    )
      throw Error("Invalid console sender");
    return fn(...args);
  });
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if(trayControl)return trayControl.show();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    bind("login-startup", enabled => {
      if (process.platform !== "win32") throw Error("Windows login startup requires Windows");
      const options = {path:process.execPath, args:app.isPackaged ? [] : [__filename]};
      const name = "DesktopAgentBridgeConsole";
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") throw Error("Invalid startup setting");
        app.setLoginItemSettings({...options, name, openAtLogin:enabled, enabled});
      }
      return app.getLoginItemSettings(options).launchItems.some(item =>
        item.scope === "user" && item.name === name && item.enabled &&
        path.resolve(item.path).toLowerCase() === process.execPath.toLowerCase() &&
        item.args.length === options.args.length && options.args.every((arg, i) =>
          path.resolve(item.args[i]).toLowerCase() === arg.toLowerCase()));
    });
    bind("queue",queueWithReviews);
    bind("maintenance", () => updating && {...updating});
    bind("desktops", async () => {
      const [result, deepseek, profiles, supervisor, health, codexMonitor, claudeMonitor] = await Promise.all([
        cli("doctor"),
        local("runtime/deepseek/connection.json", "/health").catch(() => null),
        cli("compat", "list"),
        supervisorStatus(),
        latestHealth(),
        optionalJson("runtime/codex-mcp/monitor-status.json"),
        optionalJson("runtime/claude-attach/status.json"),
      ]);
      const certifications = Object.fromEntries(await Promise.all(Object.entries(result.apps)
        .map(async ([name, row]) => [name, await certification(row.profileId)])));
      lastSnapshot = {
        apps: result.apps,
        monitors: {codex: monitorRow(codexMonitor), claude: monitorRow(claudeMonitor)},
        certifications,
        supervisor,
        health,
        checkedAt: new Date().toISOString(),
        unverifiedWorkerApps: result.workers.filter(worker => worker.alive === null).map(worker => worker.app),
        workers: result.workers.filter(worker => worker.alive === true).map(worker => ({
          app:worker.app, pid:worker.pid, threadId:worker.threadId, revision:worker.clientRevision
        })),
        installedRevision: createHash('sha256').update(Buffer.concat(await Promise.all(
          ['peer-client.mjs','peer-catalog.mjs','peer-call.mjs','delegations.mjs'].map(file => fs.readFile(path.join(root,'src/mcp',file)))
        ))).digest('hex').slice(0,16),
        deepseek: !!deepseek?.ok,
        profiles: profiles.profiles
          .filter((p) => !p.revoked)
          .map((p) => ({ id: p.id, app: p.app, version: p.version, capabilities: p.capabilities })),
      };
      return lastSnapshot;
    });
    bind("theme", value => {
      if (value !== undefined) {
        if (!["system", "light", "dark"].includes(value)) throw Error("Invalid theme");
        nativeTheme.themeSource = value;
      }
      return {source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors};
    });
    bind("update", (action, desktop, id) => {
      if (id && (typeof id !== "string" || !/^[a-z0-9._-]{1,96}$/.test(id)))
        throw Error("Invalid profile ID");
      return update(action, desktop, id);
    });
    bind("certify",async (app)=>{
      checkedApp(app);
      beginMaintenance("验收桌面能力（最长约 17 分钟）");
      try {
        if(!await confirm("运行桌面能力验收？","会在隔离目录自动创建 Codex 和 Claude 测试会话，检查消息回执，并在保护规则允许时测试权限与 MCP 重载。"))return "";
        const result=await runCertification(app,await config());
        const summary=result.packages[app].capabilities.join(" · ");
        if(!await confirm("导入按能力验收的适配包？",summary+"\n"+result.profileId+"\n"+result.package))return "已验证 "+summary+"。适配包 "+result.package;
        await cli("compat","import",result.package);
        return "已导入 "+result.profileId+"（"+summary+"）。请选择“空闲时激活”以附着并检查就绪状态。报告 "+result.report;
      } finally {updating=null;}
    });
    // MCP + skill setup. Every config write happens in scripts/install/setup-apps.py, run
    // here in the main process: "plan" previews exact diffs, "apply" writes them (with
    // backups) only if the plan still matches the previewed planId.
    bind("setup", async (action, planId) => {
      const settings = await config();
      const setup = (...args) => run(settings.python || "python",
        [path.join(root, "scripts/install/setup-apps.py"), ...args, ...(settings.node ? ["--node", settings.node] : [])]);
      if (action === "plan") return setup("plan");
      if (action === "apply") {
        if (typeof planId !== "string" || !/^[0-9a-f]{16}$/.test(planId)) throw Error("Invalid plan ID");
        beginMaintenance("安装/更新 MCP 配置与 skill");
        try { return await setup("apply", "--plan-id", planId); }
        finally { updating = null; }
      }
      if (action === "reload-codex") {
        beginMaintenance("重新加载 Codex MCP");
        try { return await cli("compat", "refresh-mcp", "--app", "codex"); }
        finally { updating = null; }
      }
      throw Error("Unknown setup action");
    });
    bind("canary-watch",async (enabled)=>{
      const prefs=await watchSettings();
      if(enabled!==undefined){
        if(typeof enabled!=="boolean")throw Error("Invalid automatic validation setting");
        beginMaintenance("设置自动验收");
        try {
          if(enabled){
            if(!await confirm("自动验收未知构建？","控制台运行期间，每组新构建会自动创建一对专用测试会话并检查回执。"))return prefs;
          }
          prefs.enabled=enabled;
          delete prefs.threads;
          const {atomicJson}=await compatModule("compatibility.mjs");
          atomicJson(watchFile,prefs);
        } finally {updating=null;}
      }
      return prefs;
    });
    const watchTick=()=>{
      checkUnknown().catch(e=>logLine("Automatic compatibility check:",e.message));
      checkDeepseek().catch(e=>logLine("DeepSeek self-test:",e.message));
      checkStalled().catch(e=>logLine("Stalled delivery check:",e.message));
    };
    setInterval(watchTick,60000).unref();
    void watchTick();
    bind("copy", (value) => {
      if (typeof value === "string" && value.length <= 1024)
        clipboard.writeText(value);
    });
    bind("window", (action) => {
      switch (action) {
        case "state": return window.isMaximized();
        case "minimize": return window.minimize();
        case "toggleMaximize":
          return window.isMaximized() ? window.unmaximize() : window.maximize();
        case "close": return window.close();
        default: throw Error("Invalid window action");
      }
    });
    window = new BrowserWindow({
      frame: false,
      width: 1320,
      height: 860,
      icon: path.join(__dirname, "bridge.ico"),
      minWidth: 820,
      minHeight: 600,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#14161c" : "#f6f7f9",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const notifySize = () => window.webContents.send("bridge:maximized", window.isMaximized());
    trayControl=require("./tray.cjs").installTray(window,async()=>{
      const {messages}=await queueWithReviews();
      const apps=Object.entries(lastSnapshot?.apps??{}).map(([app,row])=>({app,phase:row.phase,
        monitor:lastSnapshot.monitors?.[app]?.state??null,health:lastSnapshot.health?.[app]?.status??null,
        healthAt:lastSnapshot.health?.[app]?.checkedAt??null,bridgeService:row.contract?!!row.service?.ok:undefined}));
      if(lastSnapshot)apps.push({app:"deepseek",service:lastSnapshot.deepseek===true,desktop:!!lastSnapshot.supervisor?.apps?.deepseek?.pid});
      return {label:"路由在线",apps,pending:messages.filter(m=>["queued","waiting_for_adapter","waiting_for_contract","waiting_for_connection","dispatching","awaiting_ack"].includes(m.stage)).length,
        read:messages.filter(m=>["acknowledged","replied"].includes(m.stage)).length,
        issues:messages.filter(m=>["unknown","failed","interrupted"].includes(m.stage)&&!m.review).length};
    });
    window.on("maximize", notifySize);
    window.on("unmaximize", notifySize);
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_w, _p, done) =>
      done(false),
    );
    window.once("ready-to-show", () => window.show());
    await window.loadFile(path.join(__dirname, "index.html"));
  });
  app.on("window-all-closed", () => app.quit());
}
