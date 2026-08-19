// main.js — 图片识别工具 (ImgOCR) 主进程
// 原则：只读图片源、结果只写应用自己的 userData、所有 IPC 过 safeHandle 校验发送方、
// 所有外发数据经长度/类型校验、任何未捕获异常不导致崩溃退出。
"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const { OcrEngine, DEFAULT_LANGS } = require("./core/ocr");
const { Store } = require("./core/store");
const { summarizeText } = require("./core/deepseek");
const { NapCatClient, DEFAULT_WS, validateWsUrl } = require("./core/napcat");
const { BridgeServer } = require("./core/bridge");
const {
  safeString, safeInt, isPlainObject, sanitizeForLog, newId, safePath, isImagePath, MAX_LIST_LEN
} = require("./core/safe");

// ============ 全局守卫：不因未捕获异常退出 ============
function crashLogPath() {
  return path.join(app.getPath("userData"), "imgocr-crash.log");
}
function recordCrash(kind, err) {
  try {
    const s = err instanceof Error ? (err.stack || err.message) : String(err);
    fs.appendFileSync(crashLogPath(), new Date().toISOString() + " [" + kind + "] " + sanitizeForLog(s) + "\n");
  } catch {}
}
process.on("uncaughtException", (err) => {
  recordCrash("uncaught", err);
  console.error("[main] uncaught:", sanitizeForLog(err && err.stack));
});
process.on("unhandledRejection", (reason) => {
  recordCrash("unhandledRejection", reason);
  console.error("[main] unhandledRejection:", sanitizeForLog(reason));
});

// ============ 单实例 + 后台运行 ============
let win = null;
let isQuitting = false;
let tray = null;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 再次启动/双击快捷方式 → 显示窗口（用户主动打开）
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  });
}

function trayIcon() {
  try {
    const p = path.join(__dirname, "resources", "icon.png");
    if (fs.existsSync(p)) return nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  } catch {}
  return nativeImage.createEmpty();
}
function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip("图片识别工具（全家桶）");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示窗口", click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } },
      { label: "打开大事汇总器", click: () => {
        const r = resolveSentinelLaunch();
        if (!r) return;
        if (r.exe) shell.openPath(r.exe);
        else try { spawn(r.runner, [r.appDir], { cwd: r.appDir, detached: true, stdio: "ignore", windowsHide: false }).unref(); } catch {}
      } },
      { type: "separator" },
      { label: "退出", click: () => { isQuitting = true; app.quit(); } }
    ]));
    console.log("[main] 托盘已创建（应用后台运行，点击托盘图标可显示窗口）");
  } catch (e) { console.warn("[main] 托盘创建失败:", sanitizeForLog(e && e.message)); }
}

// ============ 状态 ============
let engine = null;
let store = null;
let config = { deepseekApiKey: "", napcat: null };
let napcat = null;          // NapCatClient 实例（懒创建）
let napcatPending = [];     // 监听模式收集的待识别图片（本机路径）
let napcatUnlisten = null;  // 监听注销函数
let bridge = null;            // 本地 OCR 服务（全家桶互调桥）
let queueCancel = null; // AbortController，取消当前批次
let batchRunning = false;
const NAPCAT_PENDING_MAX = 500;

const OCR_BATCH_MAX = 200;
const FOLDER_WALK_MAX = 2000;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

// ============ 配置读写（用户目录） ============
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const j = JSON.parse(raw);
    if (isPlainObject(j)) {
      if (typeof j.deepseekApiKey === "string") config.deepseekApiKey = j.deepseekApiKey.slice(0, 512);
      if (isPlainObject(j.napcat)) config.napcat = normalizeNapcatConfig(j.napcat);
    }
  } catch {}
}
function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ deepseekApiKey: config.deepseekApiKey, napcat: config.napcat || null }), "utf8");
  } catch (err) {
    console.warn("[main] 保存配置失败:", sanitizeForLog(err && err.message));
  }
}

// ============ 本地 tessdata 目录解析（离线优先） ============
function resolveTessdataPath() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, "tessdata"));
  } else {
    candidates.push(path.join(__dirname, "resources", "tessdata"));
  }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "eng.traineddata.gz")) && fs.existsSync(path.join(dir, "chi_sim.traineddata.gz"))) {
        return dir;
      }
    } catch {}
  }
  return null; // 无本地数据 → tesseract.js 回退 CDN（首次需联网）
}

// ============ IPC 安全包装 ============
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
      console.warn("[main] 拒绝非本窗口 IPC: " + channel);
      return { ok: false, error: "拒绝：非法 IPC 调用来源" };
    }
    try {
      return handler(event, ...args);
    } catch (err) {
      recordCrash("ipc:" + channel, err);
      return { ok: false, error: "内部错误: " + sanitizeForLog(err && err.message).slice(0, 300) };
    }
  });
}

// ============ 图片路径校验（防任意文件读取） ============
function validateImagePaths(paths) {
  if (!Array.isArray(paths)) return { ok: false, error: "参数必须是数组" };
  const clean = [];
  for (const p of paths.slice(0, OCR_BATCH_MAX)) {
    const sp = safePath(p);
    if (!sp) continue;
    if (!isImagePath(sp)) continue;
    let st = null;
    try { st = fs.statSync(sp); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size <= 0 || st.size > MAX_IMAGE_BYTES) continue;
    clean.push(sp);
  }
  if (!clean.length) return { ok: false, error: "没有可识别的图片" };
  return { ok: true, paths: clean };
}

function collectImagesInFolder(dir, limit) {
  const out = [];
  const walk = (d) => {
    if (out.length >= limit) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= limit) return;
      try {
        const full = path.join(d, it.name);
        if (it.isDirectory()) {
          walk(full);
        } else if (it.isFile() && isImagePath(full)) {
          const st = fs.statSync(full);
          if (st.size > 0 && st.size <= MAX_IMAGE_BYTES) out.push(full);
        }
      } catch {}
    }
  };
  walk(dir);
  return out;
}

// ============ 进度推送 ============
function progress(payload) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send("ocr:progress", payload); } catch {}
  }
}

// ============ OCR 任务 ============
async function runOcrJob(filePath, langs) {
  const id = newId("e");
  const entry = store.add({
    id: id,
    filePath: filePath,
    fileName: path.basename(filePath),
    languages: langs,
    status: "pending"
  });
  try {
    progress({ type: "start", id: id, fileName: entry.fileName });
    const res = await engine.recognize(filePath, { langs: langs, signal: queueCancel ? queueCancel.signal : undefined });
    if (res && res.ok) {
      store.update(id, {
        status: "done", text: res.text, confidence: res.confidence,
        durationMs: res.durationMs, ocrAt: Date.now(), error: null
      });
      progress({ type: "done", id: id });
    }
    return true;
  } catch (err) {
    const msg = sanitizeForLog(err instanceof Error ? err.message : String(err)).slice(0, 2000);
    store.update(id, { status: "error", error: msg || "未知错误" });
    progress({ type: "error", id: id, error: msg.slice(0, 300) });
    return false;
  }
}

async function handleRunOcr(payload) {
  if (batchRunning) return { ok: false, error: "已有识别任务进行中" };
  const v = validateImagePaths(payload && payload.paths);
  if (!v.ok) return v;
  const langs = Array.isArray(payload && payload.langs) && payload.langs.length
    ? payload.langs.map((x) => safeString(x, 64)).filter((x) => /^[A-Za-z0-9_\-]+$/.test(x)).slice(0, 6)
    : DEFAULT_LANGS.slice();
  queueCancel = new AbortController();
  batchRunning = true;
  try {
    const paths = v.paths;
    progress({ type: "batch", total: paths.length });
    let okCount = 0;
    for (const p of paths) {
      if (queueCancel.signal.aborted) break;
      const ok = await runOcrJob(p, langs);
      if (ok) okCount++;
    }
    return { ok: true, total: paths.length, okCount: okCount };
  } finally {
    batchRunning = false;
    queueCancel = null;
  }
}


// ============ NapCat 对接（只读：只调只读 API，绝不发送消息） ============
function normalizeNapcatConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: r.enabled === true,
    wsUrl: (typeof r.wsUrl === "string" && validateWsUrl(r.wsUrl)) || DEFAULT_WS,
    groups: Array.isArray(r.groups) ? r.groups.map((g) => safeInt(g, 0)).filter((g) => g > 0).slice(0, 50) : [],
    listen: r.listen === true,
    perGroup: safeInt(r.perGroup, 100, 1, 500),
    qrPath: (typeof r.qrPath === "string" && r.qrPath) ? r.qrPath.slice(0, 1024) : ""
  };
}

function napcatPendingPath() {
  return path.join(app.getPath("userData"), "pending.jsonl");
}
function loadNapcatPending() {
  try {
    if (!fs.existsSync(napcatPendingPath())) return;
    const raw = fs.readFileSync(napcatPendingPath(), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (typeof j.filePath === "string" && j.filePath && fs.existsSync(j.filePath)) {
          napcatPending.push({
            filePath: j.filePath.slice(0, 1024),
            fileName: safeString(j.fileName, 512) || path.basename(j.filePath),
            groupId: safeInt(j.groupId, 0),
            groupName: safeString(j.groupName, 200),
            time: safeInt(j.time, Date.now())
          });
        }
      } catch {}
      if (napcatPending.length >= NAPCAT_PENDING_MAX) break;
    }
    // 加载后自压缩
    fs.writeFileSync(napcatPendingPath(), napcatPending.map((x) => JSON.stringify(x)).join("\n") + (napcatPending.length ? "\n" : ""), "utf8");
  } catch {}
}
function appendNapcatPending(item) {
  if (napcatPending.some((x) => x.filePath === item.filePath)) return false;
  if (napcatPending.length >= NAPCAT_PENDING_MAX) napcatPending.shift();
  napcatPending.push(item);
  try { fs.appendFileSync(napcatPendingPath(), JSON.stringify(item) + "\n", "utf8"); } catch {}
  return true;
}
function clearNapcatPending() {
  napcatPending = [];
  try { fs.writeFileSync(napcatPendingPath(), "", "utf8"); } catch {}
}
function napcatEnsureClient() {
  if (napcat) return napcat;
  const cfg = config.napcat ? config.napcat : normalizeNapcatConfig(null);
  napcat = new NapCatClient({
    wsUrl: cfg.wsUrl,
    imageDir: path.join(app.getPath("userData"), "images")
  });
  return napcat;
}
function napcatStartListen() {
  if (napcatUnlisten) return;
  napcatEnsureClient().ensureConnected()
    .then(() => {
      if (napcatUnlisten) return;
      napcatUnlisten = napcat.onMessage((msg) => napcatHandleEvent(msg));
      console.log("[napcat] 实时监听已开启");
    })
    .catch((err) => console.warn("[napcat] 开启监听失败:", sanitizeForLog(err && err.message)));
}
function napcatStopListen() {
  if (napcatUnlisten) { try { napcatUnlisten(); } catch {} napcatUnlisten = null; }
}
function napcatHandleEvent(msg) {
  try {
    if (!msg || msg.message_type !== "group") return;
    const gid = safeInt(msg.group_id, 0);
    if (!gid) return;
    const cfg = config.napcat;
    if (!cfg || !cfg.listen) return;
    if (cfg.groups.length && cfg.groups.indexOf(gid) < 0) return;
    const segs = Array.isArray(msg.message) ? msg.message : [];
    let count = 0;
    for (const seg of segs) {
      if (count >= 5) break;
      if (!seg || seg.type !== "image") continue;
      const file = safeString(seg.data && seg.data.file, 300);
      const url = safeString(seg.data && seg.data.url, 1000);
      if (!url) continue;
      count++;
      napcatEnsureClient().materializeImage({ file: file, url: url, token: safeString(seg.data && seg.data.token, 500) }, gid)
        .then((localPath) => {
          if (!localPath || !fs.existsSync(localPath)) return;
          if (appendNapcatPending({ filePath: localPath, fileName: path.basename(localPath), groupId: gid, groupName: "", time: Date.now() })) {
            if (win && !win.isDestroyed()) {
              win.webContents.send("napcat:newImages", { paths: [localPath], groupId: gid });
            }
          }
        })
        .catch((err) => console.warn("[napcat] 下载新图失败:", sanitizeForLog(err && err.message)));
    }
  } catch (err) {
    console.warn("[napcat] 事件处理异常:", sanitizeForLog(err && err.message));
  }
}
async function handleNapcatFetch(payload) {
  const client = napcatEnsureClient();
  await client.ensureConnected();
  const cfg = config.napcat;
  const groups = Array.isArray(payload && payload.groups) && payload.groups.length
    ? payload.groups.map((g) => safeInt(g, 0)).filter((g) => g > 0).slice(0, 50)
    : (cfg ? cfg.groups : []);
  if (!groups.length) return { ok: false, error: "未选择群" };
  const pg = safeInt(payload && payload.perGroup, cfg ? cfg.perGroup : 100, 1, 500);
  const found = await client.fetchRecentImages(groups, pg);
  const out = [];
  let failed = 0;
  const queue = found.slice(0, 300);
  const workers = [];
  const n = Math.min(3, queue.length);
  for (let i = 0; i < n; i++) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const localPath = await client.materializeImage(item.image, item.groupId);
          if (localPath && fs.existsSync(localPath)) {
            out.push({ filePath: localPath, fileName: path.basename(localPath), groupId: item.groupId, groupName: "" });
          }
        } catch (err) {
          failed++;
          console.warn("[napcat] 下载失败:", sanitizeForLog(err && err.message));
        }
      }
    })());
  }
  await Promise.all(workers);
  return { ok: true, images: out, total: found.length, failed: failed };
}

// ============ 二维码查看器窗口跟踪：登录完成后自动关闭 ============
let openedViewers = new Set();
function snapshotViewerPids() {
  const pids = new Set();
  try {
    const { execFileSync } = require("child_process");
    for (const img of ["Photos.exe", "PhotosApp.exe", "Microsoft.Photos.exe", "dllhost.exe", "mspaint.exe"]) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq " + img, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: false });
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
  }, 1500);
}
function closeOpenedViewers() {
  if (!openedViewers.size) return;
  for (const pid of openedViewers) { try { process.kill(pid); } catch {} }
  console.log("[main] 登录完成，已关闭二维码查看器");
  openedViewers.clear();
}

// ============ 登录二维码监视：NapCat 等待扫码时自动用系统图片查看器打开 ============
const NAPCAT_QR_CANDIDATES = [
  // 全家桶内嵌 NapCat（换机可用，随安装包走）
  path.join(app.isPackaged ? process.resourcesPath : __dirname, "qq-sentinel", "napcat", "cache", "qrcode.png"),
  // 独立安装/开发兜底
  "G:\\deepseek\\qq-sentinel\\dist\\qq-sentinel-win32-x64\\resources\\napcat\\cache\\qrcode.png",
  "G:\\deepseek\\qq-sentinel\\napcat\\cache\\qrcode.png"
];
let qrWatchTimer = null;
let lastQrSig = null;
let qrWarnCooldownUntil = 0; // 用户取消后冷却期内不再弹窗/打开

function resolveQrPath(cfg) {
  if (cfg && cfg.qrPath && fs.existsSync(cfg.qrPath)) return cfg.qrPath;
  for (const cand of NAPCAT_QR_CANDIDATES) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

// 返回是否打开了查看器
async function isSentinelRunning() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'qq-sentinel' } | Select-Object -First 1 | Select-Object ProcessId"], { encoding: "utf8", windowsHide: false, timeout: 8000 });
    return /\d+/.test(out.trim());
  } catch { return false; }
}

async function checkNapcatLoginQr() {
  try {
    // 大事汇总器在运行时由它负责弹二维码（避免重复弹窗/查看器）；本工具作为兜底
    if (isSentinelRunning()) return false;
    const src = resolveQrPath(config.napcat);
    if (!src) { lastQrSig = null; closeOpenedViewers(); return false; }
    const st = fs.statSync(src);
    // NapCat 等待登录时二维码每约 2 分钟刷新；超过 3 分钟未刷新 = 登录完成/不在等待 → 关闭查看器
    if (Date.now() - st.mtimeMs > 3 * 60 * 1000) { lastQrSig = null; closeOpenedViewers(); return false; }
    const sig = st.mtimeMs + ":" + st.size;
    if (sig === lastQrSig) return false; // 同一张，不重复打开
    lastQrSig = sig;
    const dest = path.join(app.getPath("userData"), "napcat-login-qr.png");
    fs.copyFileSync(src, dest);
    // 打开新查看器前，关闭上一次的（避免刷新堆积多个窗口）
    closeOpenedViewers();
    // 风险警告 + 小号引导（本机标记文件 qr-nowarn.txt 可关闭；用户取消后冷却 3 分钟）
    const nowarnFile = path.join(app.getPath("userData"), "qr-nowarn.txt");
    if (!fs.existsSync(nowarnFile) && Date.now() >= qrWarnCooldownUntil) {
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
        if (choice.response === 2) { try { fs.writeFileSync(nowarnFile, "1"); } catch {} }
      } catch (e) { console.warn("[napcat] 二维码警告弹窗异常:", sanitizeForLog(e && e.message)); }
    }
    // 优先 Windows Photos（ms-photos 协议，绕开 WPS 等第三方劫持默认关联）；失败回退系统默认查看器
    shell.openExternal("ms-photos:viewer?fileName=" + dest).then((err) => {
      if (err) shell.openPath(dest);
    }).catch(() => shell.openPath(dest));
    trackOpenedViewer();
    console.log("[napcat] 检测到登录二维码，已用系统图片查看器打开");
    return true;
  } catch (err) {
    console.warn("[napcat] 二维码监视异常:", sanitizeForLog(err && err.message));
    return false;
  }
}

function watchNapcatLoginQr() {
  if (qrWatchTimer) return;
  qrWatchTimer = setInterval(checkNapcatLoginQr, 15000);
  if (qrWatchTimer.unref) qrWatchTimer.unref();
  setTimeout(checkNapcatLoginQr, 1000);
}
function stopNapcatLoginQrWatch() {
  if (qrWatchTimer) { clearInterval(qrWatchTimer); qrWatchTimer = null; }
}

// ============ 全家桶：大事汇总器启动解析（轻量：共享 Electron 运行时） ============
function resolveSentinelLaunch() {
  if (app.isPackaged) {
    // 轻量模式：resources/electron/electron.exe（dev 运行时）+ resources/qq-sentinel/app
    const appDir = path.join(process.resourcesPath, "qq-sentinel", "app");
    const runner = path.join(process.resourcesPath, "electron", "electron.exe");
    if (fs.existsSync(path.join(appDir, "main.js")) && fs.existsSync(runner)) {
      return { appDir: appDir, runner: runner };
    }
    // 兼容旧整包模式
    const exe = path.join(process.resourcesPath, "qq-sentinel", "qq-sentinel.exe");
    if (fs.existsSync(exe)) return { exe: exe };
  }
  return { exe: "G:\\deepseek\\qq-sentinel\\dist\\qq-sentinel-win32-x64\\qq-sentinel.exe" };
}

// ============ IPC 注册 ============
function registerIpc() {
  safeHandle("app:pickFiles", () => {
    const r = dialog.showOpenDialogSync(win, {
      title: "选择图片",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp", "tif", "tiff"] }]
    });
    if (!r || !r.length) return { ok: true, paths: [] };
    return { ok: true, paths: r };
  });

  safeHandle("app:pickFolder", () => {
    const r = dialog.showOpenDialogSync(win, { title: "选择文件夹", properties: ["openDirectory"] });
    if (!r || !r.length) return { ok: true, paths: [] };
    return { ok: true, paths: collectImagesInFolder(r[0], FOLDER_WALK_MAX) };
  });

  safeHandle("app:config", () => ({
    ok: true,
    version: app.getVersion(),
    deepseekConfigured: Boolean(config.deepseekApiKey),
    storeFile: store.stats().file,
    offlineTessdata: Boolean(engine && engine.opts.langPath)
  }));

  safeHandle("app:setDeepseekKey", (e, payload) => {
    const key = safeString(payload && payload.key, 512).trim();
    if (key && !/^sk-[A-Za-z0-9]{8,}$/.test(key)) {
      return { ok: false, error: "Key 格式不正确（应形如 sk-xxxx）" };
    }
    config.deepseekApiKey = key;
    saveConfig();
    return { ok: true };
  });

  safeHandle("ocr:run", (e, payload) => handleRunOcr(payload));

  safeHandle("ocr:cancel", () => {
    if (queueCancel) queueCancel.abort();
    return { ok: true };
  });

  safeHandle("store:list", (e, payload) => {
    const q = safeString(payload && payload.query, 200);
    const limit = safeInt(payload && payload.limit, MAX_LIST_LEN, 1, MAX_LIST_LEN);
    return { ok: true, entries: store.search(q, limit) };
  });

  safeHandle("store:delete", (e, payload) => {
    const id = safeString(payload && payload.id, 128);
    if (!id) return { ok: false, error: "缺少 id" };
    return { ok: store.remove(id), id: id };
  });

  safeHandle("store:clear", () => {
    store.clear();
    return { ok: true };
  });

  safeHandle("store:stats", () => ({ ok: true, stats: store.stats() }));

  safeHandle("deepseek:summarize", async (e, payload) => {
    const id = safeString(payload && payload.id, 128);
    const entry = store.get(id);
    if (!entry) return { ok: false, error: "条目不存在" };
    if (!entry.text || entry.status !== "done") return { ok: false, error: "该条目还没有识别文本" };
    if (!config.deepseekApiKey) {
      return { ok: false, error: "未配置 DeepSeek API Key（环境变量 DEEPSEEK_API_KEY 或界面设置）" };
    }
    const r = await summarizeText(entry.text, { apiKey: config.deepseekApiKey });
    store.update(id, { summary: r.summary, category: r.category });
    return { ok: true, summary: r.summary, category: r.category, id: id };
  });

  safeHandle("napcat:status", async () => {
    const cfg = config.napcat ? config.napcat : normalizeNapcatConfig(null);
    return {
      ok: true,
      connected: Boolean(napcat && napcat.connected),
      wsUrl: cfg.wsUrl,
      enabled: cfg.enabled,
      listen: cfg.listen,
      groups: cfg.groups,
      perGroup: cfg.perGroup,
      pendingCount: napcatPending.length,
      imageDir: path.join(app.getPath("userData"), "images"),
      qrPath: cfg.qrPath || ""
    };
  });

  safeHandle("napcat:listGroups", async () => {
    try {
      const client = napcatEnsureClient();
      await client.ensureConnected();
      const groups = await client.listGroups();
      return { ok: true, groups: groups };
    } catch (err) {
      return { ok: false, error: "无法连接 NapCat: " + sanitizeForLog(err && err.message).slice(0, 200) };
    }
  });

  safeHandle("napcat:saveConfig", (e, payload) => {
    const wsUrl = (payload && typeof payload.wsUrl === "string" && validateWsUrl(payload.wsUrl)) || DEFAULT_WS;
    const groups = Array.isArray(payload && payload.groups)
      ? payload.groups.map((g) => safeInt(g, 0)).filter((g) => g > 0).slice(0, 50)
      : [];
    const listen = Boolean(payload && payload.listen);
    const perGroup = safeInt(payload && payload.perGroup, 100, 1, 500);
    const qrPath = (payload && typeof payload.qrPath === "string") ? payload.qrPath.slice(0, 1024) : "";
    if (napcat && napcat.wsUrl !== wsUrl) {
      try { napcat.close(); } catch {}
      napcat = null;
      napcatUnlisten = null;
    }
    config.napcat = { enabled: true, wsUrl: wsUrl, groups: groups, listen: listen, perGroup: perGroup, qrPath: qrPath };
    saveConfig();
    if (listen) napcatStartListen();
    else napcatStopListen();
    return { ok: true };
  });

  safeHandle("napcat:fetch", (e, payload) => handleNapcatFetch(payload));

  safeHandle("napcat:pending", () => ({
    ok: true,
    paths: napcatPending.map((x) => x.filePath).slice(0, NAPCAT_PENDING_MAX)
  }));

  safeHandle("napcat:clearPending", () => {
    clearNapcatPending();
    return { ok: true };
  });

  safeHandle("app:disclaimerStatus", () => {
    try {
      const f = path.join(app.getPath("userData"), "disclaimer-accepted.txt");
      return { ok: true, accepted: fs.existsSync(f) };
    } catch { return { ok: true, accepted: false }; }
  });

  safeHandle("app:disclaimerAccept", () => {
    try {
      fs.writeFileSync(path.join(app.getPath("userData"), "disclaimer-accepted.txt"), new Date().toISOString());
      return { ok: true };
    } catch (e) { return { ok: false, error: sanitizeForLog(e && e.message) }; }
  });

  safeHandle("app:quit", () => { isQuitting = true; app.quit(); return { ok: true }; });

  safeHandle("bridge:status", () => ({
    ok: true,
    running: Boolean(bridge && bridge._server),
    port: 8765,
    token: bridge ? bridge.getToken() : "",
    engineReady: Boolean(engine)
  }));

  safeHandle("hub:openSentinel", () => {
    const r = resolveSentinelLaunch();
    if (!r) return { ok: false, error: "未找到大事汇总器" };
    if (r.exe) {
      shell.openPath(r.exe);
      return { ok: true, path: r.exe, mode: "standalone" };
    }
    // 轻量模式：共享 Electron 运行时（electron.exe <appDir>），cwd 指向 app 目录
    try {
      spawn(r.runner, [r.appDir], { cwd: r.appDir, detached: true, stdio: "ignore", windowsHide: false }).unref();
      return { ok: true, path: r.appDir, mode: "shared-electron", runner: r.runner };
    } catch (e) {
      return { ok: false, error: "启动失败: " + sanitizeForLog(e && e.message) };
    }
  });

  safeHandle("napcat:showQr", () => {
    lastQrSig = null;
    const opened = checkNapcatLoginQr();
    return { ok: true, opened: opened };
  });
}

// ============ 窗口 ============
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: "图片识别工具 ImgOCR",
    show: false, // 后台运行：启动不显示窗口，用户主动打开（托盘/再次启动）再展示
    webPreferences: {
      preload: path.join(__dirname, "renderer", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // 禁止打开外部窗口 / 导航离开本地页面
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url.indexOf("file://") !== 0) e.preventDefault();
  });
  // 后台运行：窗口始终隐藏（用户第一眼看到的是大事汇总器），点托盘/再次启动才显示
  // 点关闭 = 隐藏到托盘（后台继续跑 OCR 服务/二维码监视），不退出
  win.on("close", (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on("closed", () => { win = null; });
}

// ============ 启动 / 退出 ============
app.whenReady().then(() => {
  store = new Store(path.join(app.getPath("userData"), "imgocr.jsonl"));
  store.load();
  loadNapcatPending();
  loadConfig();
  if (!config.deepseekApiKey && process.env.DEEPSEEK_API_KEY) {
    config.deepseekApiKey = String(process.env.DEEPSEEK_API_KEY).slice(0, 512);
  }
  engine = new OcrEngine({
    langPath: resolveTessdataPath(),
    cachePath: path.join(app.getPath("userData"), "tesseract-cache"),
    logger: (m) => progress({ type: "worker", status: m && m.status, progress: m && m.progress })
  });
  registerIpc();
  createWindow();
  createTray();
  watchNapcatLoginQr();
  try {
    bridge = new BridgeServer({ port: 8765, tokenFile: path.join(app.getPath("userData"), "bridge-token.txt"), engine });
    bridge.start();
  } catch (e) {
    console.warn("[main] OCR 服务启动失败:", sanitizeForLog(e && e.message));
  }
  if (config.napcat && config.napcat.enabled && config.napcat.listen) napcatStartListen();
  console.log("[main] 就绪 userData=", app.getPath("userData"));
  setTimeout(runSelfTest, 1200);
  // 全家桶第一眼 = 大事汇总器：启动后自动打开（若未运行）
  setTimeout(() => {
    try {
      const r = resolveSentinelLaunch();
      if (!r) return;
      if (r.exe) shell.openPath(r.exe);
      else spawn(r.runner, [r.appDir], { cwd: r.appDir, detached: true, stdio: "ignore", windowsHide: false }).unref();
      console.log("[main] 已自动打开大事汇总器");
    } catch (e) { console.warn("[main] 自动打开大事汇总器失败:", sanitizeForLog(e && e.message)); }
  }, 2500);
});


// ============ 自测钩子：IMGOCR_SELFTEST_IMG=<图片> 时启动后自动跑一轮完整管线 ============
async function runSelfTest() {
  const img = process.env.IMGOCR_SELFTEST_IMG;
  if (!img) return;
  try {
    const r = await handleRunOcr({ paths: [img], langs: ["eng", "chi_sim"] });
    const st = store.stats();
    console.log("[selftest] result:", JSON.stringify(r), "stats:", JSON.stringify(st));
    const e = store.search("", 1)[0];
    console.log("[selftest] first entry:", e ? JSON.stringify({ fileName: e.fileName, status: e.status, head: e.text.slice(0, 80) }) : "(none)");
    app.exit(r && r.ok && r.okCount === 1 && e && e.status === "done" ? 0 : 1);
  } catch (err) {
    console.error("[selftest] FAIL:", sanitizeForLog(err && err.stack));
    app.exit(1);
  }
}
app.on("window-all-closed", () => { /* 后台常驻：窗口关闭后继续运行（托盘） */ });

app.on("before-quit", () => {
  try { if (store) store.flush(); } catch {}
  try { if (engine) engine.terminate(); } catch {}
  try { if (napcat) napcat.close(); } catch {}
  stopNapcatLoginQrWatch();
  try { if (bridge) bridge.stop(); } catch {}
});