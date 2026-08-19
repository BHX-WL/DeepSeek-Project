"use strict";
const fs = require("fs");
const p = "G:/deepseek/imgocr/main.js";
let c = fs.readFileSync(p, "utf8");
const rep = (old, neu, label) => {
  const n = c.split(old).length - 1;
  if (n !== 1) { console.log("MISS(" + n + "): " + label); return; }
  c = c.replace(old, neu); console.log("OK: " + label);
};

// 1) 引入 shell
rep('const { app, BrowserWindow, dialog, ipcMain } = require("electron");',
    'const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");', "import shell");

// 2) normalizeNapcatConfig 增加 qrPath
rep(
  '    listen: r.listen === true,\n    perGroup: safeInt(r.perGroup, 100, 1, 500)\n  };',
  '    listen: r.listen === true,\n    perGroup: safeInt(r.perGroup, 100, 1, 500),\n    qrPath: (typeof r.qrPath === "string" && r.qrPath) ? r.qrPath.slice(0, 1024) : ""\n  };',
  "normalizeNapcatConfig qrPath");

// 3) 在 handleNapcatFetch 之后插入二维码监视逻辑
rep(
  '// ============ IPC 注册 ============',
  `// ============ 登录二维码监视：NapCat 等待扫码时自动用系统图片查看器打开 ============
const NAPCAT_QR_CANDIDATES = [
  "G:\\\\deepseek\\\\qq-sentinel\\\\dist\\\\qq-sentinel-win32-x64\\\\resources\\\\napcat\\\\cache\\\\qrcode.png",
  "G:\\\\deepseek\\\\qq-sentinel\\\\napcat\\\\cache\\\\qrcode.png"
];
let qrWatchTimer = null;
let lastQrSig = null;

function resolveQrPath(cfg) {
  if (cfg && cfg.qrPath && fs.existsSync(cfg.qrPath)) return cfg.qrPath;
  for (const cand of NAPCAT_QR_CANDIDATES) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

// 返回是否打开了查看器
function checkNapcatLoginQr() {
  try {
    const src = resolveQrPath(config.napcat);
    if (!src) { lastQrSig = null; return false; }
    const st = fs.statSync(src);
    // NapCat 等待登录时二维码每约 2 分钟刷新；超过 6 分钟未刷新 = 不在登录等待
    if (Date.now() - st.mtimeMs > 6 * 60 * 1000) { lastQrSig = null; return false; }
    const sig = st.mtimeMs + ":" + st.size;
    if (sig === lastQrSig) return false; // 同一张，不重复打开
    lastQrSig = sig;
    const dest = path.join(app.getPath("userData"), "napcat-login-qr.png");
    fs.copyFileSync(src, dest);
    shell.openPath(dest).then((err) => {
      if (err) console.warn("[napcat] 打开二维码失败:", err);
    });
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

// ============ IPC 注册 ============`,
  "QR watcher block");

// 4) napcat:saveConfig 保存 qrPath
rep(
  '    const listen = Boolean(payload && payload.listen);\n    const perGroup = safeInt(payload && payload.perGroup, 100, 1, 500);\n    if (napcat && napcat.wsUrl !== wsUrl) {',
  '    const listen = Boolean(payload && payload.listen);\n    const perGroup = safeInt(payload && payload.perGroup, 100, 1, 500);\n    const qrPath = (payload && typeof payload.qrPath === "string") ? payload.qrPath.slice(0, 1024) : "";\n    if (napcat && napcat.wsUrl !== wsUrl) {',
  "saveConfig qrPath parse");
rep(
  '    config.napcat = { enabled: true, wsUrl: wsUrl, groups: groups, listen: listen, perGroup: perGroup };',
  '    config.napcat = { enabled: true, wsUrl: wsUrl, groups: groups, listen: listen, perGroup: perGroup, qrPath: qrPath };',
  "saveConfig qrPath set");

// 5) napcat:status 返回 qrPath + showQr IPC（插在 napcat:clearPending 之后、registerIpc 结束前）
rep(
  '  safeHandle("napcat:clearPending", () => {\n    clearNapcatPending();\n    return { ok: true };\n  });',
  '  safeHandle("napcat:clearPending", () => {\n    clearNapcatPending();\n    return { ok: true };\n  });\n\n  safeHandle("napcat:showQr", () => {\n    lastQrSig = null;\n    const opened = checkNapcatLoginQr();\n    return { ok: true, opened: opened };\n  });',
  "napcat:showQr IPC");

// 6) napcat:status 返回 qrPath
rep(
  '      pendingCount: napcatPending.length,\n      imageDir: path.join(app.getPath("userData"), "images")\n    };',
  '      pendingCount: napcatPending.length,\n      imageDir: path.join(app.getPath("userData"), "images"),\n      qrPath: cfg.qrPath || ""\n    };',
  "status qrPath");

// 7) 生命周期：启动监视 / 退出停止
rep(
  '  registerIpc();\n  createWindow();\n  if (config.napcat && config.napcat.enabled && config.napcat.listen) napcatStartListen();',
  '  registerIpc();\n  createWindow();\n  watchNapcatLoginQr();\n  if (config.napcat && config.napcat.enabled && config.napcat.listen) napcatStartListen();',
  "start watcher");
rep(
  '  try { if (napcat) napcat.close(); } catch {}',
  '  try { if (napcat) napcat.close(); } catch {}\n  stopNapcatLoginQrWatch();',
  "stop watcher");

fs.writeFileSync(p, c, "utf8");
console.log("main.js QR watcher done");