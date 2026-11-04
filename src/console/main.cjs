const { app, BrowserWindow, ipcMain, dialog, clipboard } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const page = pathToFileURL(path.join(__dirname, "index.html")).href;
let window,
  updating = false;
app.setName("Desktop Agent Bridge");
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
function checkedApp(v) {
  if (!["codex", "claude"].includes(v)) throw Error("Invalid desktop");
  return v;
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
  if (updating) throw Error("已有维护操作正在运行");
  updating = true;
  let dir;
  try {
    if (action === "probe") {
      const result = await cli("doctor", "--app", desktop, "--probe");
      return result.probe.ready ? "原生接口已就绪。" : "原生接口正在等待连接。";
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
        message: "已验证适配包 " + result.profileId,
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
        message: "已验证适配包 " + imported.profileId,
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
    updating = false;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
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
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    bind("queue", async () => {
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
    });
    bind("desktops", async () => {
      const [result, deepseek, profiles] = await Promise.all([
        cli("doctor"),
        local("runtime/deepseek/connection.json", "/health").catch(() => null),
        cli("compat", "list"),
      ]);
      return {
        apps: result.apps,
        deepseek: !!deepseek?.ok,
        profiles: profiles.profiles
          .filter((p) => !p.revoked)
          .map((p) => ({ id: p.id, app: p.app })),
      };
    });
    bind("update", (action, desktop, id) => {
      if (id && (typeof id !== "string" || !/^[a-z0-9._-]{1,96}$/.test(id)))
        throw Error("Invalid profile ID");
      return update(action, desktop, id);
    });
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
      backgroundColor: "#f3f6fa",
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
