const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bridge", {
  queue: () => ipcRenderer.invoke("bridge:queue"),
  desktops: () => ipcRenderer.invoke("bridge:desktops"),
  update: (action, app, profile) =>
    ipcRenderer.invoke("bridge:update", action, app, profile),
  copy: (value) => ipcRenderer.invoke("bridge:copy", value),
});
