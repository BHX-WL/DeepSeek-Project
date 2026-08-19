// renderer/preload.js — 上下文桥：只暴露白名单 API，绝不开放 ipcRenderer 本体
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

function on(channel, cb) {
  const listener = (_e, payload) => { try { cb(payload); } catch {} };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("imgocr", {
  pickFiles: () => ipcRenderer.invoke("app:pickFiles"),
  pickFolder: () => ipcRenderer.invoke("app:pickFolder"),
  runOcr: (payload) => ipcRenderer.invoke("ocr:run", payload),
  cancelOcr: () => ipcRenderer.invoke("ocr:cancel"),
  list: (payload) => ipcRenderer.invoke("store:list", payload),
  remove: (id) => ipcRenderer.invoke("store:delete", { id: id }),
  clearAll: () => ipcRenderer.invoke("store:clear"),
  stats: () => ipcRenderer.invoke("store:stats"),
  summarize: (id) => ipcRenderer.invoke("deepseek:summarize", { id: id }),
  getConfig: () => ipcRenderer.invoke("app:config"),
  setKey: (key) => ipcRenderer.invoke("app:setDeepseekKey", { key: key }),
  onProgress: (cb) => on("ocr:progress", cb),
  napcatStatus: () => ipcRenderer.invoke("napcat:status"),
  napcatListGroups: () => ipcRenderer.invoke("napcat:listGroups"),
  napcatSaveConfig: (payload) => ipcRenderer.invoke("napcat:saveConfig", payload),
  napcatFetch: (payload) => ipcRenderer.invoke("napcat:fetch", payload),
  napcatPending: () => ipcRenderer.invoke("napcat:pending"),
  napcatClearPending: () => ipcRenderer.invoke("napcat:clearPending"),
  napcatShowQr: () => ipcRenderer.invoke("napcat:showQr"),
  bridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  openSentinel: () => ipcRenderer.invoke("hub:openSentinel"),
  disclaimerStatus: () => ipcRenderer.invoke("app:disclaimerStatus"),
  disclaimerAccept: () => ipcRenderer.invoke("app:disclaimerAccept"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  onNapcatNewImages: (cb) => on("napcat:newImages", cb)
});