const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kiconDesktop", {
  isOverlay: true,
  close: () => ipcRenderer.send("caption:close"),
  resize: (width, height) => ipcRenderer.send("caption:resize", width, height),
});
