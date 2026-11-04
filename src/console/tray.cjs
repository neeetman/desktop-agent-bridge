const {
  app,
  BrowserWindow,
  Tray,
  screen,
  ipcMain,
  nativeTheme,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function previewBounds(area, point, width = 320, height = 190) {
  return {
    x: Math.max(area.x, Math.min(point.x - width, area.x + area.width - width)),
    y: Math.max(
      area.y,
      Math.min(point.y - height, area.y + area.height - height),
    ),
    width,
    height,
  };
}
function installTray(main, loadStatus) {
  const tray = new Tray(path.join(__dirname, "bridge.ico"));
  let preview,
    quitting = false,
    request = 0;
  let loading;
  const url = pathToFileURL(path.join(__dirname, "tray.html")).href;
  function show() {
    preview?.hide();
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }
  async function showPreview() {
    if (!preview) {
      preview = new BrowserWindow({
        width: 320,
        height: 190,
        frame: false,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors
          ? "#222738"
          : "#f7f8fc",
        webPreferences: {
          preload: path.join(__dirname, "tray-preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      preview.removeMenu();
      preview.on("blur", () => {
        const generation=request;
        setTimeout(()=>{
          if(generation===request && preview?.isVisible() && !preview.isFocused()) preview.hide();
        },120);
      });
      preview.on("closed", () => {
        preview = null;
      });
      preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      preview.webContents.on("will-navigate", (e) => e.preventDefault());
      loading = preview.loadURL(url);
    }
    await loading;
    if (quitting || !preview) return;
    const point = screen.getCursorScreenPoint();
    preview.setBounds(
      previewBounds(screen.getDisplayNearestPoint(point).workArea, point),
    );
    preview.show();
    preview.focus();
    const id = ++request;
    preview.webContents.send("tray:status", { label: "正在读取路由状态…" });
    let status;
    try {
      status = await loadStatus();
    } catch {
      status = { label: "路由暂时不可用" };
    }
    if (id === request && preview?.isVisible())
      preview.webContents.send("tray:status", status);
  }
  ipcMain.on("tray:action", (e, action) => {
    if (
      !preview ||
      e.sender !== preview.webContents ||
      e.senderFrame !== preview.webContents.mainFrame ||
      e.senderFrame.url !== url
    )
      return;
    if (action === "open") show();
    if (action === "quit") app.quit();
    if (action === "hide") preview.hide();
  });
  tray.setToolTip("Desktop Agent Bridge · 右键查看状态");
  tray.on("click", show);
  tray.on(
    "right-click",
    () => void showPreview().catch(() => preview?.hide()),
  );
  app.on("before-quit", () => {
    quitting = true;
  });
  main.on("query-session-end", () => {
    quitting = true;
  });
  main.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    main.hide();
  });
  app.on("will-quit", () => tray.destroy());
  return { show };
}
module.exports = { installTray, previewBounds };
