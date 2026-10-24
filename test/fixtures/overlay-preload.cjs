const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("overlayTest", {
  report: (result) => ipcRenderer.send("overlay-test:result", result),
});
