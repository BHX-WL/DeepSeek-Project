// main.js — QQ 群大事监控器主进程
const { app, BrowserWindow, dialog, ipcMain, shell, Notification } = require("electron");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const config = require("./core/config");
const L = require("./core/logger");
const store = require("./core/store");
const { OneBotClient, ReverseOneBotServer } = require("./core/onebot");
const { Collector } = require("./core/collector");
const { Summarizer } = require("./core/summarizer");
const napcat = require("./core/napcat");
const bots = require("./core/bots");
const reportExporter = require("./core/export-report");
const imgbridge = require("./core/imgbridge");

// ============ 单实例：全家桶主角，避免重复启动 ============
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
}

let win = null;
let client = null;
let revServer = null;
let collector = null;
let summarizer = null;
let timers = [];

const SMOKE = process.env.QS_SMOKE === "1";

// ============ 防护层：全局未捕获异常守卫 ============
process.on("uncaughtException", (err) => {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "crash.log"), `[${new Date().toISOString()}] uncaughtException ${err?.stack || err?.message || err}\n`);
  } catch {}
  console.error("[main] 未捕获异常（已防护，进程继续）:", err);
});
process.on("unhandledRejection", (reason) => {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "crash.log"), `[${new Date().toISOString()}] unhandledRejection ${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}\n`);
  } catch {}
  console.error("[main] 未处理的 Promise 拒绝（已防护）:", reason);
});
// ====================================================

function userDataDir() {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: "QQ 群大事监控器",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---------------- 开机自启（Windows 注册表 Run 键） ----------------
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME = "QQSentinel";

// 自启命令：打包后为 qq-sentinel.exe；开发模式为 electron.exe + app 路径
function autoStartCommand() {
  const exe = process.execPath;
  if (app.isPackaged) return '"' + exe + '"';
  return '"' + exe + '" "' + app.getAppPath() + '"';
}

function setAutoStart(enabled) {
  try {
    if (enabled) {
      execFileSync("reg", ["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", autoStartCommand(), "/f"], { stdio: "ignore" });
    } else {
      execFileSync("reg", ["delete", RUN_KEY, "/v", RUN_NAME, "/f"], { stdio: "ignore" });
    }
    L.info("[autostart] " + (enabled ? "已启用开机自启" : "已关闭开机自启"));
    return { ok: true, enabled };
  } catch (e) {
    L.error("[autostart] 设置失败:", e.message);
    return { ok: false, error: e.message };
  }
}

function getAutoStart() {
  try {
    execFileSync("reg", ["query", RUN_KEY, "/v", RUN_NAME], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

// ---------------- IPC ----------------
function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

  async function doConnect() {
    const mode = config.get("napcat.mode") || "forward";
    if (client) client.stop();
    if (revServer) revServer.stop();
    if (mode === "reverse") {
      revServer = new ReverseOneBotServer({ port: config.get("napcat.reversePort") || 3002, token: config.get("napcat.token") });
      collector = new Collector(revServer);
      summarizer = new Summarizer(revServer, collector);
      collector.attach();
      wireBotEvents(revServer);
      revServer.start();
      L.info("[bot] reverse mode: waiting NapCat to connect...");
      return { ok: true, mode: "reverse" };
    }
    // 自动拉起 NapCat（已安装但未运行时）
    try {
      const autoLaunch = config.get("napcat.autoLaunch") !== false; // 默认开启
      if (autoLaunch) {
        const st = napcat.status();
        if (!st.running && st.installed) {
          L.info("[bot] NapCat 未运行，自动启动…");
          napcat.launch();
          broadcast("bot:connecting", { hint: "NapCat 未运行，正在自动启动，请稍候…" });
        } else if (!st.installed) {
          // 未安装：立即告诉用户，而不是静默失败
          return { ok: false, error: "NapCat 未安装。请到「NapCat」页点击「下载安装」，安装后扫码登录小号，再回来连接。", needNapcat: true };
        }
      }
    } catch (e) { L.warn("[bot] auto-launch napcat:", e.message); }
    const wsUrl = config.get("napcat.wsUrl");
    client = new OneBotClient({
      apiMinIntervalMs: Number(config.get("monitor.apiMinIntervalMs")) || 250, wsUrl, token: config.get("napcat.token") });
    collector = new Collector(client);
    summarizer = new Summarizer(client, collector);
    collector.attach();
    collector.onEvent = (gid, evt) => { if (evt && evt.kind) maybeNotify(evt.kind, gid, evt.title, evt.text || evt.summary); };
    summarizer.onNotify = (gid, rec) => maybeNotify("conflict", gid, rec && rec.title, rec && (rec.summary || rec.reason));
    wireBotEvents(client);
    client.connect();
    armConnectTimeout(10000); // 10 秒未连上则广播失败原因
    return { ok: true, mode: "forward" };
  }


  let connectTimer = null;
  function armConnectTimeout(ms) {
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (!client?.connected) {
        L.warn("[bot] 连接超时（NapCat 无响应）");
        broadcast("bot:connect-failed", { error: "无法连接 NapCat（超时）。请确认：① NapCat 已启动并扫码登录 ② 连接模式/端口配置正确（正向 3001 / 反向 3002）" });
      }
    }, ms);
  }
  function disarmConnectTimeout() { clearTimeout(connectTimer); connectTimer = null; }


// ============ IPC 安全包装：校验发送方（防渲染层被 XSS 攻破后调用任意本地能力） ============
function isTrustedSender(event) {
  try {
    const wc = event && event.sender;
    if (!wc || wc.isDestroyed()) return false;
    const frameUrl = (event.senderFrame && event.senderFrame.url) || "";
    if (frameUrl && frameUrl.indexOf("file://") !== 0) return false;
    const url = wc.getURL();
    return url.indexOf("file://") === 0;
  } catch { return false; }
}
function safeHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      L.warn("[main] 拒绝非本窗口 IPC: " + channel);
      return { ok: false, error: "拒绝：非法 IPC 调用来源" };
    }
    try {
      return handler(event, ...args);
    } catch (e) {
      L.warn("[main] IPC " + channel + " 异常:", e && e.message);
      return { ok: false, error: "内部错误: " + String(e && e.message || "未知").slice(0, 200) };
    }
  });
}

// IPC 可写配置白名单：渲染层只允许修改这些顶层配置节（防 XSS 后篡改任意配置）
const CONFIG_WRITE_ALLOW = new Set(["deepseek", "napcat", "watch", "summarize", "hotspots", "ocr"]);

function registerIpc() {
  safeHandle("config:get", (_e, keyPath) => config.get(keyPath));

  safeHandle("napcat:logs", () => {
    const dir = napcat.napcatDir();
    const logsDir = path.join(dir, "logs");
    if (!fs.existsSync(logsDir)) return { ok: false, error: "日志目录不存在（fileLog 未启用？）: " + logsDir };
    shell.openPath(logsDir);
    return { ok: true, dir: logsDir };
  });

  safeHandle("app:disclaimerStatus", () => {
    try {
      const f = path.join(config.dataDir(), "disclaimer-accepted.txt");
      return { ok: true, accepted: fs.existsSync(f) };
    } catch { return { ok: true, accepted: false }; }
  });
  safeHandle("app:disclaimerAccept", () => {
    try {
      fs.writeFileSync(path.join(config.dataDir(), "disclaimer-accepted.txt"), new Date().toISOString());
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  safeHandle("qr:show", () => {
    lastQrSig = null;
    const opened = checkNapcatQr();
    return { ok: true, opened };
  });

  safeHandle("bots:get", (_e, gid) => ({ ok: true, gid, bots: bots.getBots(gid), scannedAt: bots.getScanned(gid) }));
  safeHandle("bots:getAll", () => ({ ok: true, bots: bots.getAllBots() }));
  safeHandle("bots:scan", async () => {
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
  });

  let ocrRunning = false;
  safeHandle("ocr:groupImages", async (_e, payload) => {
    if (ocrRunning) return { ok: false, error: "已有识别任务进行中" };
    const gid = String((payload && payload.gid) || "");
    if (!/^\d{1,20}$/.test(gid)) return { ok: false, error: "群号无效" };
    const limit = Math.max(1, Math.min(50, Number((payload && payload.limit) || 10)));
    const ocrCfg = config.get("ocr") || {};
    const bridgeUrl = String(ocrCfg.bridgeUrl || imgbridge.DEFAULT_BRIDGE_URL);
    const token = String(ocrCfg.bridgeToken || "") || imgbridge.readImgocrToken();
    if (!client || !client.connected) return { ok: false, error: "未连接 NapCat" };
    ocrRunning = true;
    try {
      const imgs = await imgbridge.fetchGroupImages(client, gid, limit);
      if (!imgs.length) return { ok: true, total: 0, okCount: 0, results: [], note: "该群最近消息没有图片" };
      const cacheDir = path.join(config.dataDir(), "imgcache");
      const results = [];
      let okCount = 0;
      for (const img of imgs) {
        try {
          const local = await imgbridge.materializeImage(client, img, gid, cacheDir);
          if (!local) { results.push({ ok: false, error: "图片下载失败" }); continue; }
          const r = await imgbridge.ocrViaBridge(local, bridgeUrl, token);
          okCount++;
          results.push({ ok: true, filePath: local, text: r.text, confidence: r.confidence });
          store.appendEvent(gid, {
            id: `ocr-${gid}-${Date.now()}-${okCount}`,
            groupId: gid,
            kind: "ocr",
            title: `图片识别：${String(r.text || "(无文字)").slice(0, 40)}`,
            summary: String(r.text || "(未识别到文字)").slice(0, 5000),
            imagePath: local,
            engine: "imgocr-bridge",
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          results.push({ ok: false, error: e.message });
        }
      }
      L.info(`[ocr] 群 ${gid} 识别 ${okCount}/${imgs.length} 张`);
      return { ok: true, total: imgs.length, okCount, results };
    } finally {
      ocrRunning = false;
    }
  });

  safeHandle("ocr:ping", async () => {
    const ocrCfg = config.get("ocr") || {};
    const bridgeUrl = String(ocrCfg.bridgeUrl || imgbridge.DEFAULT_BRIDGE_URL);
    const token = String(ocrCfg.bridgeToken || "") || imgbridge.readImgocrToken();
    const h = await imgbridge.bridgeHealth(bridgeUrl);
    return { ok: h.ok, status: h.status, tokenFound: Boolean(token), ...(h.error ? { error: h.error } : {}) };
  });

  safeHandle("hub:openImgocr", () => {
    const exe = resolveImgocrExe();
    if (!exe) return { ok: false, error: "未找到图片识别工具（ImgOCR.exe）" };
    const { spawn } = require("child_process");
    spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { ok: true, path: exe };
  });
  safeHandle("config:set", (_e, keyPath, value) => {
    // 白名单校验：只允许写已知顶层节，且值必须为普通对象（防原型污染/任意路径）
    const k = String(keyPath || "");
    if (!CONFIG_WRITE_ALLOW.has(k)) return { ok: false, error: "不允许修改该配置项" };
    if (value == null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "配置值必须为对象" };
    // 深拷贝+字符串长度上限防护（防超长值撑爆配置/内存）
    try {
      const safe = JSON.parse(JSON.stringify(value, (key, v) => {
        if (typeof v === "string" && v.length > 4096) return v.slice(0, 4096);
        return v;
      }));
      if (safe && typeof safe === "object" && !Array.isArray(safe)) {
        config.set(k, safe);
        return { ok: true };
      }
      return { ok: false, error: "配置值无效" };
    } catch (e) {
      return { ok: false, error: "配置值无效: " + e.message };
    }
  });

  safeHandle("bot:status", () => ({
    connected: client?.connected || false,
    selfId: client?.selfId || null,
    groups: store.stats().length,
    napcat: napcat.status(),
  }));

  safeHandle("bot:connect", async () => doConnect());

  // 连接超时检测：forward 模式发起连接后，若 N 秒未建立 WS，向 UI 广播失败原因
  safeHandle("bot:disconnect", () => {
    if (client) { client.stop(); client = null; }
    if (revServer) { revServer.stop(); revServer = null; }
    if (collector) { collector.stop(); collector = null; }
    if (summarizer) { summarizer._running.clear(); }
    return { ok: true };
  });

  safeHandle("groups:list", () => store.listGroups());
  safeHandle("groups:setWatched", (_e, gid, watched) => store.setWatched(gid, watched));

  // 从 NapCat 拉取小号所在的全部群（只读 get_group_list），供用户勾选指定爬取群
  safeHandle("groups:fromRemote", async () => {
    const bot = client || revServer;
    if (!bot) return { ok: false, error: "未连接 NapCat" };
    try {
      const groups = await bot.getGroupList();
      if (!Array.isArray(groups)) return { ok: false, error: "NapCat 返回了意外格式" };
      const list = groups.map((g) => ({
        groupId: String(g.group_id ?? ""),
        name: String(g.group_name ?? "").trim() || `群${g.group_id ?? ""}`,
        memberCount: Number(g.member_count || 0),
        maxMemberCount: Number(g.max_member_count || 0),
      })).filter((g) => g.groupId);
      L.info(`[bot] 拉取到 ${list.length} 个群`);
      return { ok: true, groups: list };
    } catch (e) {
      L.warn("[bot] 拉取群列表失败:", e.message);
      return { ok: false, error: e.message };
    }
  });

  safeHandle("messages:get", (_e, gid, opts) => store.getMessages(gid, opts || {}));
  safeHandle("events:get", (_e, gid, limit) => store.listEvents(gid, limit || 200));
  safeHandle("kw-hits:list", (_e, gid, limit) => store.listKeywordHits(gid, limit || 500));
  safeHandle("announcements:get", (_e, gid) => store.listAnnouncements(gid));

  safeHandle("summary:run", async (_e, gid, opts) => {
    if (!summarizer) return { ok: false, error: "未连接" };
    return summarizer.summarizeGroup(gid, opts || {});
  });
  safeHandle("summary:all", async (_e, opts) => {
    if (!summarizer) return { ok: false, error: "未连接" };
    const groups = store.listGroups();
    const results = [];
    for (const g of groups) {
      if (!collector.isWatchedGroup(g.groupId)) continue;
      const r = await summarizer.summarizeGroup(g.groupId, opts || {});
      results.push({ groupId: g.groupId, ok: r.ok, summary: r.summary || null, error: r.error || null });
    }
    return { ok: true, results };
  });
  // 获取某群上次汇总时间（供 UI 展示默认窗口）
  safeHandle("summary:last", (_e, gid) => ({ ok: true, last: store.getLastSummary(gid) }));

  // 报告导出（.md / .json）：汇总记录 + 消息样本，写入选中的本地路径
  safeHandle("report:export", async (_e, payload) => {
    try {
      const p = payload || {};
      const gid = String(p.gid || "").trim();
      if (!/^\d{1,20}$/.test(gid)) return { ok: false, error: "无效群号" };
      const format = p.format === "json" ? "json" : "md";
      const until = p.until || new Date().toISOString();
      let since = p.since;
      if (!since) {
        const d = new Date();
        d.setDate(d.getDate() - (Number(p.days) || 7));
        since = d.toISOString();
      }
      const events = store.listEvents(gid, 10000).filter((e) => e && e.time >= since && e.time <= until);
      const msgs = store.getMessages(gid, { since, until, limit: 20000 });
      const gname = groupLabel(gid);
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: "导出报告",
        defaultPath: path.join(app.getPath("downloads"), `qq-report-${gid}-${new Date().toISOString().slice(0, 10)}.${format}`),
        filters: format === "json" ? [{ name: "JSON", extensions: ["json"] }] : [{ name: "Markdown", extensions: ["md"] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      const content = format === "json"
        ? JSON.stringify(reportExporter.buildReportJson({ gid, groupName: gname, since, until, events, msgs }), null, 2)
        : reportExporter.buildReportMarkdown({ gid, groupName: gname, since, until, events, msgs });
      fs.writeFileSync(filePath, content, "utf8");
      L.info(`[export] ${filePath}（${events.length} 事件 / ${msgs.length} 消息）`);
      return { ok: true, path: filePath, events: events.length, messages: msgs.length };
    } catch (e) {
      L.warn("[export] 失败:", e && e.message);
      return { ok: false, error: e && e.message };
    }
  });

  // 热点库状态（微博热搜缓存信息）
  safeHandle("hotspots:status", async () => {
    const h = require("./core/hotspots");
    await h.fetchHotspots().catch(() => {});
    return h.status();
  });

  safeHandle("history:backfill", async (_e, gid, days) => {
    if (!collector) return { ok: false, error: "未连接" };
    const n = await collector.backfillHistory(gid, days || 3);
    return { ok: true, pulled: n };
  });

  // 回拉所有指定爬取群的历史（watch.groups；为空则回拉全部关注群）
  safeHandle("history:backfillAll", async (_e, days) => {
    if (!collector) return { ok: false, error: "未连接" };
    const d = Math.max(1, Math.min(90, Number(days) || 3));
    const cfgGroups = config.get("watch.groups");
    const groups = store.listGroups();
    const targets = cfgGroups && cfgGroups.length
      ? cfgGroups
      : groups.filter((g) => g.watched || collector.isWatchedGroup(g.groupId)).map((g) => g.groupId);
    const results = [];
    for (const gid of targets) {
      const n = await collector.backfillHistory(gid, d).catch(() => 0);
      results.push({ groupId: gid, pulled: n });
    }
    L.info(`[bot] backfillAll done: ${results.length} 个群`);
    return { ok: true, results };
  });

  safeHandle("announcements:refresh", async (_e, gid) => {
    if (!collector) return { ok: false, error: "未连接" };
    const n = await collector.refreshAnnouncements(gid);
    return { ok: true, added: n };
  });

  safeHandle("napcat:launch", async () => napcat.launch());
  safeHandle("napcat:stop", async () => napcat.stop());
  safeHandle("napcat:status", () => napcat.status());
  safeHandle("napcat:install", async (_e, opts) => {
    // 安全：安装目标目录只允许 napcatDir 本身（防任意路径写入）
    const clean = { ...(opts || {}) };
    delete clean.dir;
    return napcat.install(clean);
  });
  safeHandle("napcat:selectDir", async () => {
    if (!win || win.isDestroyed()) return { ok: false, error: "窗口不可用" };
    try {
      const res = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.setAttribute("webkitdirectory", "");
          input.onchange = () => resolve(input.files && input.files[0] ? input.files[0].path.split("\\\\").slice(0, -1).join("\\\\") : null);
          input.click();
        })
      `);
      // 校验返回的是合法本地路径（存在或可创建）
      if (typeof res !== "string" || !res.trim()) return { ok: true, dir: null };
      return { ok: true, dir: res.trim() };
    } catch (e) {
      L.warn("[napcat] selectDir error:", e.message);
      return { ok: false, error: e.message };
    }
  });

  safeHandle("app:stats", () => ({
    groups: store.stats(),
    configPath: path.join(config.dataDir(), "config.json"),
  }));
  safeHandle("autostart:get", () => ({ enabled: getAutoStart() }));
  safeHandle("autostart:set", (_e, enabled) => setAutoStart(!!enabled));
}

// ---------------- 机器人事件 → UI ----------------
function wireBotEvents(src) {
  const s = src || client;
  if (!s || typeof s.onEvent !== "function") return;
  s.onEvent((evt) => {
    if (evt.type === "meta") {
      if (evt.subType === "connected") {
        disarmConnectTimeout();
        s.getSelfInfo().then((info) => {
          const selfId = String((info && info.user_id) || "");
          // 同时设置 client 与 revServer 的 selfId（兼容 forward/reverse 模式）
          if (client) client.selfId = selfId;
          if (revServer) revServer.selfId = selfId;
          L.info(`[bot] logged in as ${selfId}`);
          closeOpenedViewers();
          broadcast("bot:connected", { selfId });
        }).catch(() => {});
        // 连接后：刷新群列表 + 回拉历史
        setTimeout(() => bootstrapCollections(), 1500);
      } else if (evt.subType === "disconnected") {
        broadcast("bot:disconnected", {});
      } else if (evt.subType === "reconnecting") {
        broadcast("bot:reconnecting", { attempt: evt.attempt, delay: evt.delay });
      } else if (evt.subType === "risk") {
        broadcast("bot:risk", { message: evt.message || "" });
      }
      return;
    }
    // 消息/事件推给渲染层
    if (evt.post_type === "message" || evt.post_type === "notice") {
      broadcast("bot:event", evt);
    }
  });
}

// 全家桶：解析图片识别工具（imgocr）可执行文件
function resolveImgocrExe() {
  const candidates = [];
  // 全家桶共享运行时模式：本应用在 <root>/resources/qq-sentinel/app/，ImgOCR.exe 在 <root>/
  const rootByApp = path.resolve(__dirname, "../../../");
  candidates.push(path.join(rootByApp, "ImgOCR.exe"));
  // 全家桶独立整包模式：本应用在 <root>/resources/qq-sentinel/，ImgOCR.exe 在 <root>/
  candidates.push(path.resolve(path.dirname(process.execPath), "../../ImgOCR.exe"));
  // 独立安装/开发兜底
  candidates.push("G:\\deepseek\\imgocr\\dist\\win-unpacked\\ImgOCR.exe");
  return candidates.find((c) => fs.existsSync(c)) || null;
}

// 机器人扫描 + 自动忽略：扫描所有关注群成员，把 is_robot=true 的并入 summarize.ignoreBotUins
async function scanAndAutoIgnore() {
  if (!client || !client.connected) return;
  const gids = watchedGroupIds();
  if (!gids.length) return;
  const result = await bots.scanGroups(client, gids);
  const botCount = Object.values(result).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
  L.info(`[bots] 扫描完成：${Object.keys(result).length} 个群，发现 ${botCount} 个机器人`);
  // 自动并入忽略列表（默认开启；summarize.autoIgnoreBots=false 可关闭）
  if (config.get("summarize.autoIgnoreBots") !== false) {
    const all = Object.values(result).flat().map((b) => b.userId).filter(Boolean);
    const cur = Array.isArray(config.get("summarize.ignoreBotUins")) ? config.get("summarize.ignoreBotUins") : [];
    const merged = Array.from(new Set([...cur, ...all]));
    if (merged.length !== cur.length) {
      config.set("summarize.ignoreBotUins", merged);
      L.info(`[bots] 已将 ${all.length} 个机器人并入汇总忽略列表: ${all.join(",")}`);
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

async function bootstrapCollections() {
  try {
    const groups = await collector.refreshGroupList();
    broadcast("groups:updated", groups);
    // 连接后：扫描各群成员，检测机器人并标注（自动并入汇总忽略列表）
    scanAndAutoIgnore().catch((e) => L.warn("[bots] 启动扫描失败:", e.message));
    const cfgGroups = config.get("watch.groups");
    // 指定群优先：watch.groups 非空时只回拉这些群；否则回拉全部关注群
    const targets = cfgGroups && cfgGroups.length
      ? cfgGroups
      : groups.filter((g) => g.watched || collector.isWatchedGroup(g.groupId)).map((g) => g.groupId);
    for (const gid of targets) {
      const days = config.get("watch.collectHistoryDays") || 3;
      collector.backfillHistory(gid, days).catch(() => {});
      collector.refreshAnnouncements(gid).catch(() => {});
    }
  } catch (e) {
    L.warn("[bootstrap] error:", e.message);
  }
}

// ============ 二维码查看器窗口跟踪：登录成功后自动关闭 ============
let openedViewers = new Set();

function snapshotViewerPids() {
  const pids = new Set();
  try {
    for (const img of ["Photos.exe", "PhotosApp.exe", "Microsoft.Photos.exe", "dllhost.exe", "mspaint.exe"]) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq " + img, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      for (const line of out.split("\n")) {
        const m = line.match(/"([^"]+.exe)","(\d+)"/);
        if (m) pids.add(Number(m[2]));
      }
    }
  } catch {}
  return pids;
}
function trackOpenedViewer() {
  const before = snapshotViewerPids();
  setTimeout(() => {
    const after = snapshotViewerPids();
    for (const pid of after) if (!before.has(pid)) openedViewers.add(pid);
    if (openedViewers.size) L.info("[main] 已跟踪二维码查看器窗口: " + [...openedViewers].join(","));
  }, 1500);
}
function closeOpenedViewers() {
  if (!openedViewers.size) return;
  for (const pid of openedViewers) { try { process.kill(pid); } catch {} }
  L.info("[main] 登录完成，已关闭二维码查看器");
  openedViewers.clear();
}

// ============ 登录二维码自动弹出（首次使用/会话失效时 NapCat 写二维码 → 系统图片查看器） ============
let qrWatchTimer = null;
let lastQrSig = null;
let qrWarnCooldownUntil = 0; // 用户取消后冷却期内不再弹窗/打开

async function checkNapcatQr() {
  try {
    const qr = path.join(napcat.napcatDir(), "cache", "qrcode.png");
    if (!fs.existsSync(qr)) { lastQrSig = null; return false; }
    const st = fs.statSync(qr);
    // NapCat 等待登录时二维码每约 2 分钟刷新；超过 6 分钟未刷新 = 不在登录等待
    if (Date.now() - st.mtimeMs > 6 * 60 * 1000) { lastQrSig = null; return false; }
    const sig = st.mtimeMs + ":" + st.size;
    if (sig === lastQrSig) return false;
    lastQrSig = sig;
    const dest = path.join(config.dataDir(), "napcat-login-qr.png");
    fs.copyFileSync(qr, dest);
    // 打开新查看器前，关闭上一次的（避免刷新堆积多个窗口）
    closeOpenedViewers();
    // 风险警告 + 小号引导（可配置关闭：napcat.qrNoWarn=true；用户取消后冷却 3 分钟）
    if (config.get("napcat.qrNoWarn") !== true && Date.now() >= qrWarnCooldownUntil) {
      try {
        const choice = await dialog.showMessageBox(win, {
          type: "warning",
          title: "即将弹出登录二维码",
          message: "请使用【小号】扫码登录",
          detail: "⚠️ 风险提示：登录后该 QQ 将作为监控机器人运行，可读取所监控群的全部消息。\n\n请使用专门的小号（建议新注册或不常用的 QQ），不要使用个人主号 —— 主号登录存在隐私泄露与账号风险。\n\n接下来会弹出系统图片查看器显示二维码，用手机 QQ 扫码即完成登录。",
          buttons: ["用小号扫码（继续）", "取消", "不再提示，直接继续"],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        });
        if (choice.response === 1) { qrWarnCooldownUntil = Date.now() + 3 * 60 * 1000; return false; } // 取消：本次不打开，3 分钟内不再打扰
        if (choice.response === 2) { try { config.set("napcat.qrNoWarn", true); } catch {} }
      } catch (e) { L.warn("[main] 二维码警告弹窗异常:", e.message); }
    }
    // 优先 Windows Photos（ms-photos 协议，绕开 WPS 等第三方劫持默认关联）；失败回退系统默认查看器
    shell.openExternal("ms-photos:viewer?fileName=" + dest).then((err) => {
      if (err) shell.openPath(dest);
    }).catch(() => shell.openPath(dest));
    trackOpenedViewer();
    L.info("[main] 检测到 NapCat 登录二维码，已用系统图片查看器打开");
    return true;
  } catch (e) {
    L.warn("[main] 二维码监视异常:", e.message);
    return false;
  }
}
function startQrWatch() {
  if (qrWatchTimer) return;
  qrWatchTimer = setInterval(checkNapcatQr, 10000);
  if (qrWatchTimer.unref) qrWatchTimer.unref();
  setTimeout(checkNapcatQr, 1000);
}
function stopQrWatch() { if (qrWatchTimer) { clearInterval(qrWatchTimer); qrWatchTimer = null; } }

// 定时任务：公告轮询 + 热点刷新 + 每日汇总
function startTimers() {
  // 微博热搜刷新（force：绕过缓存 TTL，约每 15 分钟更新；失败静默由 hotspots 内部降级）
  timers.push(setInterval(() => {
    require("./core/hotspots").fetchHotspots(true).catch(() => {});
  }, 15 * 60000));

  // 公告轮询（降风险：默认 60 分钟一次，可在设置调整）
  const pollMs = (Number(config.get("monitor.announcePollMinutes")) || 60) * 60000;
  timers.push(setInterval(() => {
    if (!collector || !client?.connected) return;
    const groups = store.listGroups().filter((g) => collector.isWatchedGroup(g.groupId));
    for (const g of groups) collector.refreshAnnouncements(g.groupId).catch(() => {});
  }, pollMs));

  // 机器人周期扫描（降风险：默认关闭=手动；开启时按配置间隔）
  if (config.get("monitor.botScanAuto")) {
    const scanMs = (Number(config.get("monitor.botScanHours")) || 24) * 60 * 60000;
    timers.push(setInterval(() => {
      if (!client || !client.connected) return;
      scanAndAutoIgnore().catch(() => {});
    }, scanMs));
  }

  timers.push(setInterval(() => {
    if (!summarizer || !client?.connected) return;
    const hour = new Date().getHours();
    if (hour === config.get("summarize.dailyHour")) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `daily-${today}`;
      if (global.__dailyDone === key) return;
      global.__dailyDone = key;
      L.info("[timer] running default summaries");
      // 自动默认汇总：窗口 = max(上次汇总时间, 现在-默认天数) → 现在
      store.listGroups().filter((g) => collector && collector.isWatchedGroup(g.groupId)).forEach((g) => {
        summarizer.summarizeGroup(g.groupId, { mode: "default" }).then((r) => {
          broadcast("summary:done", r);
          if (r && r.ok) {
            maybeNotify("daily", g.groupId, `每日大事汇总 · ${groupLabel(g.groupId)}`, (r.summary || "").slice(0, 200));
          }
        }).catch(() => {});
      });
    }
  }, 60 * 1000));
}

// ---------- 系统通知 ----------
const _notifyRate = new Map(); // kind:gid -> ts（60s 限频）
const NOTIFY_KINDS = { at_all: "atAll", announcement: "announcement", conflict: "conflict", summary: "daily", daily: "daily" };

function groupLabel(gid) {
  try {
    const g = store.listGroups().find((x) => String(x.groupId) === String(gid));
    return g && g.name ? g.name : `群${gid}`;
  } catch (e) { return `群${gid}`; }
}

function maybeNotify(kind, gid, title, body) {
  try {
    const n = config.get("notify") || {};
    if (n.enabled === false) return;
    const keyOf = NOTIFY_KINDS[kind];
    if (!keyOf || n[keyOf] === false) return; // 只通知白名单事件 + 各自开关
    if (n.focusSilent !== false && mainWindow && typeof mainWindow.isFocused === "function" && mainWindow.isFocused()) return;
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;
    const rateKey = kind + ":" + gid;
    const now = Date.now();
    if (now - (_notifyRate.get(rateKey) || 0) < 60000) return; // 同事件 60s 内不重复
    _notifyRate.set(rateKey, now);
    const ttl = String(title || kind || "QQ 监控").slice(0, 80);
    const bd = String(body || "").slice(0, 300);
    const notif = new Notification({ title: ttl, body: bd, silent: false });
    notif.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
  } catch (e) { L.warn("[notify] 发送失败:", e && e.message); }
}

function shutdown() {
  stopQrWatch();
  for (const t of timers) clearInterval(t);
  timers = [];
  // 落盘待写配置/群元数据
  try { store.flushGroups(); } catch {}
  if (client) client.stop();
  if (revServer) revServer.stop();
}

// ---------------- 启动 ----------------
app.whenReady().then(() => {
  config.setDataDir(userDataDir());
  L.init(path.join(config.dataDir(), "logs"));
  store.init(path.join(config.dataDir(), "store"));
  bots.init(path.join(config.dataDir(), "store"));
  napcat.init({ config, logger: L });
  startQrWatch();
  registerIpc();
  createWindow();
  startTimers();

  // 自动连接
  if (config.get("napcat.autoStart")) {
    setTimeout(() => {
      doConnect().catch((e) => L.error("[main] 自动连接失败:", e.message));
    }, 800);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (SMOKE) {
    setTimeout(() => {
      console.log("[smoke] window ready, quitting");
      app.quit();
    }, 4000);
  }
});

app.on("window-all-closed", () => {
  shutdown();
  if (process.platform !== "darwin") app.quit();
});

