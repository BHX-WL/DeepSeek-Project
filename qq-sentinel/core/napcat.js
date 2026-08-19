// core/napcat.js — NapCat 实例管理：检测/下载/启动/扫码引导
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const https = require("https");

let _config = null;
let _L = null;
let _proc = null;          // 注入器启动的 QQ 子进程句柄（spawn 方式）
let _procPid = null;       // 注入器启动的 QQ 主进程 PID（跨会话追踪用）
let _pidFile = null;       // 注入器 PID 文件路径
let _installing = false;

const RELEASE_API = "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest";
// 注入器文件名（与 NapCat 同目录）
const INJECTOR_NAME = "napcat-injector.exe";
// 默认小号独立数据目录（魔改 NapCat 的关键：与大号默认目录隔离）
const DEFAULT_DATA_DIR = "D:\\QQNT-MULTI-DATA";
const DEFAULT_QQ_PATH = "D:\\QQNT\\QQ.exe";

function init({ config, logger }) {
  _config = config;
  _L = logger;
}

// 配置读取（防御性：任何异常回退默认值）
function cfg(key, fallback) {
  try { return _config?.get(key) ?? fallback; } catch { return fallback; }
}

function dataDirForQQ() {
  const d = cfg("napcat.dataDir", DEFAULT_DATA_DIR);
  return d && String(d).trim() ? String(d).trim() : DEFAULT_DATA_DIR;
}

function qqPathForQQ() {
  const q = cfg("napcat.qqPath", "");
  if (q && String(q).trim() && fs.existsSync(String(q).trim())) return String(q).trim();
  // 自动探测：注册表 UninstallString（同官方 launcher.bat）
  const detected = detectQQPath();
  if (detected) return detected;
  if (fs.existsSync(DEFAULT_QQ_PATH)) return DEFAULT_QQ_PATH;
  return "";
}

// 从注册表探测 QQ 安装路径（官方 launcher.bat 同款逻辑）
function detectQQPath() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("reg", ["query", "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ", "/v", "UninstallString"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/"([^"]*\\QQ\.exe)"/i) || out.match(/([A-Za-z]:\\[^"]*\\QQ\.exe)/i);
    if (m && fs.existsSync(m[1])) return m[1];
  } catch {}
  // 64 位注册表
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("reg", ["query", "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ", "/v", "UninstallString"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/"([^"]*\\QQ\.exe)"/i) || out.match(/([A-Za-z]:\\[^"]*\\QQ\.exe)/i);
    if (m && fs.existsSync(m[1])) return m[1];
  } catch {}
  return "";
}

function napcatDir() {
  // 1) 显式配置优先
  try {
    const cfgDir = _config?.get("napcat.napcatDir");
    if (cfgDir && fs.existsSync(cfgDir)) return cfgDir;
  } catch {}
  // 2) 打包形态：resources/app/core/../.. = resources → resources/napcat
  const packed = path.join(path.dirname(path.dirname(__dirname)), "napcat");
  if (fs.existsSync(packed)) return packed;
  // 3) 开发形态：qq-sentinel/core/.. = qq-sentinel → qq-sentinel/napcat
  const dev = path.join(path.dirname(__dirname), "napcat");
  if (fs.existsSync(dev)) return dev;
  // 4) 兜底：配置目录（即使尚不存在，交给 install 创建）
  return packed;
}

function installed() {
  const dir = napcatDir();
  if (!fs.existsSync(dir)) return false;
  // NapCat Windows 常见可执行/入口
  const candidates = ["NapCatWinBootMain.exe", "napcat.mjs", "NapCat.Shell.exe", "launcher.bat", "napcat.exe"];
  return candidates.some((c) => fs.existsSync(path.join(dir, c))) || fs.existsSync(path.join(dir, "package.json"));
}

// 运行检测：优先软件启动的进程；否则按进程名检测（支持外部/开机自启的 NapCat）
function isRunning() {
  if (_proc && _proc.exitCode == null) return true;
  if (_procPid && processAlive(_procPid)) return true;
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq NapCatWinBootMain.exe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (/NapCatWinBootMain\.exe/i.test(out)) return true;
  } catch {}
  // 注入器启动的 QQ（独立数据目录的 QQ 主进程）
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("wmic", ["process", "where", "name='QQ.exe'", "get", "ProcessId,CommandLine", "/format:list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const dataDir = dataDirForQQ();
    if (out.includes("--user-data-dir=" + dataDir)) return true;
  } catch {}
  return false;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function status() {
  const dir = napcatDir();
  return {
    installed: installed(),
    dir,
    running: isRunning(),
    installing: _installing,
    mode: "injector",               // 当前使用魔改注入器模式
    qqPath: qqPathForQQ(),
    dataDir: dataDirForQQ(),
    pid: _procPid,
    injectorReady: fs.existsSync(path.join(dir, INJECTOR_NAME)),
  };
}

// 拉取最新 release 下载地址
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.request(RELEASE_API, {
      headers: { "User-Agent": "qq-sentinel", Accept: "application/vnd.github+json" },
      timeout: 20000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.tag_name) {
            resolve({
              tag: j.tag_name,
              assets: (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
            });
          } else reject(new Error("release 解析失败"));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("GitHub API timeout")); });
    req.end();
  });
}

async function install(opts = {}) {
  if (_installing) return { ok: false, error: "安装进行中" };
  _installing = true;
  try {
    const dest = opts.dir || napcatDir();
    fs.mkdirSync(dest, { recursive: true });
    _L.info(`[napcat] installing to ${dest}`);
    const rel = await fetchLatestRelease();
    // Windows 版 zip：NapCat-<tag>-win32-x64.zip 或 NapCat.Win32.zip 之类
    const winAsset = rel.assets.find((a) => /win/i.test(a.name) && /\.zip$/i.test(a.name)) ||
                     rel.assets.find((a) => /\.zip$/i.test(a.name));
    if (!winAsset) throw new Error(`未找到 Windows 安装包（release ${rel.tag}）`);
    _L.info(`[napcat] downloading ${winAsset.name} (${(winAsset.size/1048576).toFixed(1)} MB)`);
    await downloadFile(winAsset.url, path.join(dest, winAsset.name), (pct) => {
      // 进度回调（可在 UI 显示）
    });
    // 解压
    const zipPath = path.join(dest, winAsset.name);
    await extractZip(zipPath, dest);
    // 安装成功后清理 zip 安装包
    try { fs.unlinkSync(zipPath); } catch {}
    _L.info("[napcat] install done");
    return { ok: true, dir: dest, tag: rel.tag };
  } catch (e) {
    _L.error("[napcat] install error:", e.message);
    return { ok: false, error: e.message };
  } finally {
    _installing = false;
  }
}

// 下载带超时/重定向上限/失败清理；redirect 最多跟随 5 次
function downloadFile(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) { reject(new Error("重定向次数过多")); return; }
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "qq-sentinel" }, timeout: 600000 }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return downloadFile(res.headers.location, dest, onProgress, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      res.on("data", (c) => { got += c.length; if (total) onProgress?.(got / total); });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(dest); });
    });
    req.on("timeout", () => { req.destroy(); try { fs.unlinkSync(dest); } catch {} reject(new Error("下载超时（10 分钟）")); });
    req.on("error", (e) => { try { file.close(); } catch {} try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

// 简单 zip 解压（纯 JS 太复杂，尝试用系统 tar —— Win10+ 自带 bsdtar 支持 zip）
function extractZip(zipPath, dest) {
  return new Promise((resolve, reject) => {
    const tar = "tar.exe";
    execFile(tar, ["-xf", zipPath, "-C", dest], { timeout: 300000 }, (err) => {
      if (err) reject(new Error(`解压失败: ${err.message}（可手动解压 ${zipPath} 到 ${dest}）`));
      else resolve(dest);
    });
  });
}

function launch() {
  if (isRunning()) return { ok: true, already: true }; // 已在运行（含外部启动）则不重复启动
  const dir = napcatDir();
  if (!installed()) return { ok: false, error: "NapCat 未安装", dir };

  // ============ 首选：魔改注入器（挂起启动 QQ 带 --user-data-dir + 注入 hook DLL） ============
  const injector = path.join(dir, INJECTOR_NAME);
  if (fs.existsSync(injector)) {
    const qqPath = qqPathForQQ();
    const dataDir = dataDirForQQ();
    if (!qqPath) {
      _L?.warn("[napcat] 未找到 QQ.exe（注册表/默认路径均无），回退 NapCatWinBootMain");
    } else {
      _L.info(`[napcat] 注入器启动: QQ=${qqPath} dataDir=${dataDir}`);
      return launchViaInjector(injector, qqPath, dataDir);
    }
  } else {
    _L?.warn(`[napcat] 未找到注入器 ${INJECTOR_NAME}，回退 NapCatWinBootMain（将使用 QQ 默认数据目录，可能与主号冲突）`);
  }

  // ============ 回退：官方 NapCatWinBootMain（无独立数据目录） ============
  const entry =
    findEntry(dir, ["NapCatWinBootMain.exe", "NapCat.Shell.exe", "napcat.exe"]) ||
    findEntry(dir, ["launcher.bat", "start.bat"]);
  if (!entry) return { ok: false, error: "未找到 NapCat 启动入口", dir };

  _L.info(`[napcat] launching ${entry}`);
  // NapCat 注入 QQ 需要管理员权限：非管理员时通过 runas 提权（弹出 UAC，用户确认）
  try {
    const isAdmin = (() => {
      try {
        const { execFileSync } = require("child_process");
        execFileSync("net", ["session"], { stdio: "ignore" });
        return true;
      } catch { return false; }
    })();
    if (!isAdmin) {
      _L.info("[napcat] 需要管理员权限，尝试提权启动（请在弹出的 UAC 中允许）");
      const { execFile } = require("child_process");
      execFile("powershell", ["-NoProfile", "-Command", "Start-Process -FilePath '" + entry + "' -WorkingDirectory '" + dir + "' -Verb runAs"], { windowsHide: true }, (err) => {
        if (err) _L.warn("[napcat] 提权启动失败:", err.message);
      });
      return { ok: true, elevated: true };
    }
  } catch (e) {}
  if (/\.(bat|cmd)$/i.test(entry)) {
    _proc = spawn("cmd.exe", ["/c", entry], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true });
  } else {
    _proc = spawn(entry, [], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true });
  }
  _proc.on("exit", (code) => {
    _L.warn(`[napcat] process exited code=${code}`);
    _proc = null;
  });
  return { ok: true, entry };
}

// 通过注入器启动：挂起创建 QQ（带 --user-data-dir）→ 注入 NapCatWinBootHook.dll → 恢复
// 无需管理员（注入目标进程由本进程直接创建，同权限即可）；如需提权由调用方处理
function launchViaInjector(injector, qqPath, dataDir) {
  const dir = napcatDir();
  const pidFile = path.join(require("os").tmpdir(), `qq-sentinel-napcat-${Date.now()}.pid`);
  const args = [`"${dataDir}"`, `"${qqPath}"`, `"${pidFile}"`];
  _L.info(`[napcat] injector: ${injector} ${args.join(" ")}`);
  let child;
  try {
    child = spawn(injector, args, { cwd: dir, detached: true, stdio: "ignore", windowsHide: true });
  } catch (e) {
    _L?.warn("[napcat] 注入器启动失败:", e.message);
    return { ok: false, error: `注入器启动失败: ${e.message}` };
  }
  _proc = child;
  // 注入器是原生 exe（CreateProcess 直启 QQ），spawn 的 child 很快退出；QQ 主进程 PID 从 pid 文件读取
  let pidTimer = null;
  const cleanupTimer = () => { if (pidTimer) { clearInterval(pidTimer); pidTimer = null; } };
  child.on("error", (err) => {
    _L?.warn("[napcat] injector error:", err.message);
    cleanupTimer();
    if (_proc === child) _proc = null;
  });
  child.on("exit", (code) => {
    _L?.info(`[napcat] injector exited code=${code}`);
    cleanupTimer();
    if (_proc === child) _proc = null;
  });
  // 轮询读取 QQ 主进程 PID（注入器写完 pid 文件即成功；QQ 随后加载 NapCat）
  let waited = 0;
  pidTimer = setInterval(() => {
    waited += 500;
    let pid = null;
    try {
      if (fs.existsSync(pidFile)) {
        const raw = fs.readFileSync(pidFile, "utf8").trim();
        const n = parseInt(raw, 10);
        if (n > 0) pid = n;
      }
    } catch {}
    if (pid) {
      cleanupTimer();
      _procPid = pid;
      _L.info(`[napcat] QQ 主进程 PID=${pid}（独立数据目录 ${dataDir}）`);
      // 清理 pid 文件（stop 时用 wmic 按数据目录兜底，无需保留）
      try { fs.unlinkSync(pidFile); } catch {}
      return;
    }
    if (waited >= 15000) {
      cleanupTimer();
      _L.warn("[napcat] 未能在 15s 内读取注入器 PID，NapCat 可能未正常启动");
    }
  }, 500);
  return { ok: true, entry: injector, mode: "injector", dataDir };
}

function findEntry(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  // 递归找一层
  try {
    for (const sub of fs.readdirSync(dir)) {
      const subp = path.join(dir, sub);
      if (!fs.statSync(subp).isDirectory()) continue;
      for (const n of names) {
        const p = path.join(subp, n);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) {}
  return null;
}

function stop() {
  const result = { ok: true, stopped: [] };
  // 1) 注入器启动的 QQ 主进程（只杀独立数据目录的实例，绝不误杀大号）
  if (_procPid) {
    const pid = _procPid;
    _procPid = null;
    try {
      require("child_process").execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      result.stopped.push(`QQ#${pid}`);
      _L?.info(`[napcat] 已停止注入器 QQ 进程树 #${pid}`);
    } catch (e) {
      _L?.warn(`[napcat] 停止 QQ#${pid} 失败: ${e.message}`);
    }
  }
  // 2) 软件 spawn 的注入器/启动器进程
  if (_proc && _proc.exitCode == null) {
    const pid = _proc.pid;
    try { _proc.kill(); } catch (e) {}
    try { require("child_process").execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    _proc = null;
  }
  // 3) 按数据目录兜底：杀掉仍带 --user-data-dir=<dataDir> 的 QQ 进程（防 PID 丢失）
  try {
    const dataDir = dataDirForQQ();
    const { execFileSync } = require("child_process");
    const out = execFileSync("wmic", ["process", "where", "name='QQ.exe'", "get", "ProcessId,CommandLine", "/format:list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const blocks = out.split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const pidM = b.match(/ProcessId=(\d+)/);
      if (!pidM) continue;
      if (b.includes("--user-data-dir=" + dataDir)) {
        try {
          require("child_process").execFileSync("taskkill", ["/PID", pidM[1], "/T", "/F"], { stdio: "ignore" });
          result.stopped.push(`QQ#${pidM[1]}(dataDir)`);
        } catch {}
      }
    }
  } catch {}
  // 4) 外部/提权启动的 NapCatWinBootMain（进程名兜底，不动 QQ）
  try {
    require("child_process").execFileSync("taskkill", ["/IM", "NapCatWinBootMain.exe", "/T", "/F"], { stdio: "ignore" });
    result.stopped.push("NapCatWinBootMain");
  } catch {}
  return result;
}

module.exports = { init, status, install, launch, stop, napcatDir, installed };
