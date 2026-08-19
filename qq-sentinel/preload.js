// preload.js — 安全桥（IPC 统一安全包装：错误归一化，渲染层永不产生未处理拒绝）
const { contextBridge, ipcRenderer } = require("electron");

const ERR = (m) => ({ ok: false, error: String(m) });
const safe = (channel) => async (...args) => {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (e) { console.error(`[preload] IPC ${channel} 失败:`, e?.message || e); return ERR(e?.message || "IPC 调用失败"); }
};

contextBridge.exposeInMainWorld("sentinelApi", {
  configGet: safe("config:get"),
  configSet: safe("config:set"),
  botStatus: safe("bot:status"),
  botConnect: safe("bot:connect"),
  botDisconnect: safe("bot:disconnect"),
  groupsList: safe("groups:list"),
  groupsSetWatched: safe("groups:setWatched"),
  groupsFromRemote: safe("groups:fromRemote"),
  messagesGet: safe("messages:get"),
  eventsGet: safe("events:get"),
  announcementsGet: safe("announcements:get"),
  summaryRun: safe("summary:run"),
  summaryAll: safe("summary:all"),
  summaryLast: safe("summary:last"),
  hotspotsStatus: safe("hotspots:status"),
  backfill: safe("history:backfill"),
  backfillAll: safe("history:backfillAll"),
  announcementsRefresh: safe("announcements:refresh"),
  napcatLaunch: safe("napcat:launch"),
  napcatStop: safe("napcat:stop"),
  napcatStatus: safe("napcat:status"),
  napcatInstall: safe("napcat:install"),
  napcatSelectDir: safe("napcat:selectDir"),
  appStats: safe("app:stats"),
  botsGet: safe("bots:get"),
  botsGetAll: safe("bots:getAll"),
  botsScan: safe("bots:scan"),
  qrShow: safe("qr:show"),
  napcatLogs: safe("napcat:logs"),
  disclaimerStatus: safe("app:disclaimerStatus"),
  disclaimerAccept: safe("app:disclaimerAccept"),
  ocrGroupImages: safe("ocr:groupImages"),
  ocrPing: safe("ocr:ping"),
  hubOpenImgocr: safe("hub:openImgocr"),
  autostartGet: safe("autostart:get"),
  autostartSet: safe("autostart:set"),

  on: (channel, fn) => {
    const valid = ["bot:connected", "bot:disconnected", "bot:connect-failed", "bot:connecting", "bot:event", "groups:updated", "summary:done", "bots:updated"];
    if (!valid.includes(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
