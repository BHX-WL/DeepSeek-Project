"use strict";
const fs = require("fs");
const p = "G:/deepseek/qq-sentinel/main.js";
let c = fs.readFileSync(p, "utf8");
const rep = (old, neu, tag) => {
  const n = c.split(old).length - 1;
  if (n !== 1) { console.log("MISS(" + n + "): " + tag); return; }
  c = c.replace(old, neu); console.log("OK: " + tag);
};

// 1) require bots（在 require("./core/hotspots") 之后）
rep(
  '  require("./core/hotspots").fetchHotspots(true).catch(() => {});',
  '  require("./core/hotspots").fetchHotspots(true).catch(() => {});',
  "anchor1"); // no-op marker, replaced below properly
// 真正插入 require：找 main.js 顶部 require 区
rep(
  'const napcat = require("./core/napcat");',
  'const napcat = require("./core/napcat");\nconst bots = require("./core/bots");',
  "require bots");

// 2) whenReady 初始化 bots
rep(
  '  store.init(path.join(config.dataDir(), "store"));',
  '  store.init(path.join(config.dataDir(), "store"));\n  bots.init(path.join(config.dataDir(), "store"));',
  "init bots");

// 3) bootstrapCollections 里加扫描（在 for targets 回拉之前）
rep(
  `    const groups = await collector.refreshGroupList();
    broadcast("groups:updated", groups);`,
  `    const groups = await collector.refreshGroupList();
    broadcast("groups:updated", groups);
    // 连接后：扫描各群成员，检测机器人并标注（自动并入汇总忽略列表）
    scanAndAutoIgnore().catch((e) => L.warn("[bots] 启动扫描失败:", e.message));`,
  "hook scan in bootstrap");

// 4) 新增 scanAndAutoIgnore + watchedGroupIds（插在 bootstrapCollections 之前）
rep(
  'async function bootstrapCollections() {',
  `// 机器人扫描 + 自动忽略：扫描所有关注群成员，把 is_robot=true 的并入 summarize.ignoreBotUins
async function scanAndAutoIgnore() {
  if (!client || !client.connected) return;
  const gids = watchedGroupIds();
  if (!gids.length) return;
  const result = await bots.scanGroups(client, gids);
  const botCount = Object.values(result).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
  L.info(\`[bots] 扫描完成：\${Object.keys(result).length} 个群，发现 \${botCount} 个机器人\`);
  // 自动并入忽略列表（默认开启；summarize.autoIgnoreBots=false 可关闭）
  if (config.get("summarize.autoIgnoreBots") !== false) {
    const all = Object.values(result).flat().map((b) => b.userId).filter(Boolean);
    const cur = Array.isArray(config.get("summarize.ignoreBotUins")) ? config.get("summarize.ignoreBotUins") : [];
    const merged = Array.from(new Set([...cur, ...all]));
    if (merged.length !== cur.length) {
      config.set("summarize.ignoreBotUins", merged);
      L.info(\`[bots] 已将 \${all.length} 个机器人并入汇总忽略列表: \${all.join(",")}\`);
      broadcast("bots:updated", bots.getAllBots());
    }
  }
  broadcast("bots:updated", bots.getAllBots());
}

function watchedGroupIds() {
  const w = config.get("watch.groups");
  if (Array.isArray(w) && w.length) return w.map(String).filter(Boolean);
  return store.listGroups().map((g) => String(g.groupId)).filter(Boolean);
}

async function bootstrapCollections() {`,
  "scan helpers");

// 5) IPC handlers（插在 groups:fromRemote 附近 —— 用 config:get 作为锚点前插入）
rep(
  '  ipcMain.handle("config:get", (_e, keyPath) => config.get(keyPath));',
  `  ipcMain.handle("config:get", (_e, keyPath) => config.get(keyPath));

  ipcMain.handle("bots:get", (_e, gid) => ({ ok: true, gid, bots: bots.getBots(gid), scannedAt: bots.getScanned(gid) }));
  ipcMain.handle("bots:getAll", () => ({ ok: true, bots: bots.getAllBots() }));
  ipcMain.handle("bots:scan", async () => {
    if (!client || !client.connected) return { ok: false, error: "未连接 NapCat" };
    const result = await bots.scanGroups(client, watchedGroupIds());
    // 与启动扫描一致：自动并入忽略列表
    if (config.get("summarize.autoIgnoreBots") !== false) {
      const all = Object.values(result).flat().map((b) => b.userId).filter(Boolean);
      const cur = Array.isArray(config.get("summarize.ignoreBotUins")) ? config.get("summarize.ignoreBotUins") : [];
      const merged = Array.from(new Set([...cur, ...all]));
      if (merged.length !== cur.length) config.set("summarize.ignoreBotUins", merged);
    }
    broadcast("bots:updated", bots.getAllBots());
    return { ok: true, result, all: bots.getAllBots() };
  });`,
  "IPC handlers");

// 6) 定时重扫（6h）—— 插在 startTimers 里公告轮询定时器之后
rep(
  `  }, 30 * 60000)); // 每 30 分钟查公告`,
  `  }, 30 * 60000)); // 每 30 分钟查公告

  timers.push(setInterval(() => {
    if (!client || !client.connected) return;
    // 每 6 小时重扫机器人（成员变动/新机器人）
    scanAndAutoIgnore().catch(() => {});
  }, 6 * 60 * 60000));`,
  "rescan timer");

fs.writeFileSync(p, c, "utf8");
console.log("main.js done");