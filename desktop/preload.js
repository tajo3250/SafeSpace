const { contextBridge, process: electronProcess } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
});
