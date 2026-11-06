const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bridge", {
  windowAction: (action) => ipcRenderer.invoke("bridge:window", action),
  onMaximized: (update) => ipcRenderer.on("bridge:maximized", (_, flag) => update(flag)),
  loginStartup: enabled => ipcRenderer.invoke("bridge:login-startup", enabled),
  queue: () => ipcRenderer.invoke("bridge:queue"),
  desktops: () => ipcRenderer.invoke("bridge:desktops"),
  certify: (app) => ipcRenderer.invoke("bridge:certify",app),
  canaryWatch: (enabled) => ipcRenderer.invoke("bridge:canary-watch",enabled),
  update: (action, app, profile) =>
    ipcRenderer.invoke("bridge:update", action, app, profile),
  copy: (value) => ipcRenderer.invoke("bridge:copy", value),
});
