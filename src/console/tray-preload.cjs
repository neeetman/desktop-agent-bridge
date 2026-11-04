const { ipcRenderer } = require("electron");
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
  });
});
