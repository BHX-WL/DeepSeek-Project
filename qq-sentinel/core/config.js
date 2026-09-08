// core/config.js — 配置读写（userData/config.json）
// v2：新增 schema 校验/越界钳制、reload()（外部改动热读）、保存前 .bak 备份、
//     合并防原型污染。全部原 API 不变（load/save/get/set/setDataDir/dataDir）。
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  napcat: {
    wsUrl: "ws://127.0.0.1:3001", // NapCat OneBot 正向 WS 地址（forward 模式）
    mode: "forward",              // forward | reverse
    reversePort: 3002,            // 反向 WS 监听端口（reverse 模式）
    token: "",                    // OneBot access_token（如有）
    napcatDir: "",                // NapCat 安装目录（空则用内置 napcat/）
    autoStart: true,
    // 魔改注入器模式：小号 QQ 使用独立数据目录，与大号默认目录隔离（避免"文件已损坏"冲突）
    qqPath: "",                   // QQ.exe 路径（空=自动探测注册表/默认路径）
    dataDir: "D:\\QQNT-MULTI-DATA", // 小号 NapCat 的独立数据目录
  },
  // 黑话/梗词表：消息出现时，本地语义/AI 总结会用词条解释帮助“看懂”（格式 {word, meaning}）
  glossary: [],
  watch: {
    groups: [],        // 监听群号列表（空 = 全部）
    collectHistoryDays: 0,  // 启动回拉历史天数（保守默认 0 = 不回拉，靠在线实时积累；过大回拉会增加风控风险）
    keywords: [],      // 关键词监控：消息包含任一词时重点记录
  },
  // 降封号风险（monitor）：主动拉取的克制参数
  monitor: {
    announcePollMinutes: 60,  // 群公告轮询间隔（分钟，保守默认 60）
    botScanAuto: false,       // 是否自动周期性扫描机器人（默认关=手动「🤖 检测机器人」）
    botScanHours: 24,         // 自动扫描间隔（小时，仅在 botScanAuto=true 时生效）
    apiMinIntervalMs: 250,    // 主动 API 最小间隔（毫秒，全局节流）
  },
  summarize: {
    dailyHour: 22,     // 每日汇总触发小时（24h）
    mode: "auto",       // auto=有 key 用 AI 否则本地；deepseek=强制 AI；local=强制本地
    defaultDays: 7,    // 默认汇总窗口天数
    includeAnnouncements: true,
    includeAtAll: true,
    includeConflicts: true,
    conflictWindowMin: 10,   // 吵架检测时间窗（分钟）
    conflictMessageMin: 8,   // 时间窗内最少消息数
    ignoreBotUins: [],       // 补充忽略的官方机器人 QQ 号
    autoIgnoreBots: true,    // 检测到 is_robot 时自动并入忽略列表
    burstEnabled: true,      // 突发总结开关
    burstBucketMin: 5,       // 突发检测粒度（分钟/桶）
    burstMinCount: 20,       // 突发绝对阈值：桶内至少多少条
    burstMult: 2,            // 突发相对阈值：≥ 基线多少倍
    burstContextMin: 10,     // 起因上下文窗口（分钟）
    burstMax: 5,             // 单次最多几个突发
  },
  hotspots: {
    enabled: true,     // 热点库开关
    cacheMinutes: 15,  // 热点缓存时长（分钟）
    platforms: ["weibo", "douyin", "bilibili"],
  },
  deepseek: {
    apiKey: "",        // DEEPSEEK_API_KEY（也可环境变量）
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
  },
  ocr: {
    enabled: true,
    bridgeUrl: "http://127.0.0.1:8765",
    bridgeToken: "",      // 留空自动从 imgocr userData 读取
  },
  ui: {
    theme: "auto",     // auto | light | dark
  },
  ollama: {
    enabled: true,          // 本地 LLM（无 DeepSeek Key 时的 AI 降级）
    url: "http://127.0.0.1:11434",
    model: "qwen2.5:7b",
    timeoutSec: 180,
  },
  notify: {
    enabled: true,      // 系统通知总开关
    atAll: true,        // @全体 通知
    announcement: true, // 新公告 通知
    conflict: true,     // 吵架冲突 通知
    daily: true,        // 每日自动汇总完成 通知
    focusSilent: true,  // 应用窗口聚焦时不打扰
  },
};

// ---------- schema：类型 + 边界（越界钳制到边界；枚举不合法回退默认） ----------
const SCHEMA = {
  "napcat.mode": { enum: ["forward", "reverse"], def: "forward" },
  "napcat.reversePort": { type: "int", min: 1, max: 65535 },
  "napcat.autoStart": { type: "bool" },
  "watch.collectHistoryDays": { type: "int", min: 0, max: 90 },
  "summarize.dailyHour": { type: "int", min: 0, max: 23 },
  "summarize.mode": { enum: ["auto", "deepseek", "local"], def: "auto" },
  "summarize.defaultDays": { type: "int", min: 1, max: 90 },
  "summarize.conflictWindowMin": { type: "int", min: 1, max: 1440 },
  "summarize.conflictMessageMin": { type: "int", min: 1, max: 10000 },
  "summarize.burstBucketMin": { type: "int", min: 1, max: 60 },
  "summarize.burstMinCount": { type: "int", min: 1, max: 100000 },
  "summarize.burstMult": { type: "num", min: 1, max: 100 },
  "summarize.burstContextMin": { type: "int", min: 0, max: 1440 },
  "summarize.burstMax": { type: "int", min: 1, max: 100 },
  "hotspots.cacheMinutes": { type: "int", min: 1, max: 1440 },
  "deepseek.baseUrl": { type: "string", maxLen: 500 },
  "ocr.bridgeUrl": { type: "string", maxLen: 500 },
  "ui.theme": { enum: ["auto", "light", "dark"], def: "auto" },
  "notify.enabled": { type: "bool" },
  "notify.atAll": { type: "bool" },
  "notify.announcement": { type: "bool" },
  "notify.conflict": { type: "bool" },
  "notify.daily": { type: "bool" },
  "notify.focusSilent": { type: "bool" },
  "monitor.announcePollMinutes": { type: "int", min: 5, max: 1440 },
  "monitor.botScanHours": { type: "int", min: 1, max: 168 },
  "monitor.apiMinIntervalMs": { type: "int", min: 50, max: 10000 },
  "monitor.botScanAuto": { type: "bool" },
  "ollama.url": { type: "string", maxLen: 500 },
  "ollama.model": { type: "string", maxLen: 200 },
  "ollama.timeoutSec": { type: "int", min: 10, max: 600 },
  "ollama.enabled": { type: "bool" },
};

let _dir = null;
let _cfg = null;
let _backedUp = false; // 进程内只备份一次（保存前的"上次可用"）

function dataDir() { return _dir; }

function setDataDir(dir) {
  _dir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

function configPath() { return _dir ? path.join(_dir, "config.json") : null; }

// ---------- 合并防原型污染：拒绝 __proto__/constructor/prototype 键 ----------
function isEvilKey(k) {
  return k === "__proto__" || k === "constructor" || k === "prototype";
}
function deepMerge(base, override) {
  const out = {};
  for (const k of Object.keys(base || {})) {
    if (isEvilKey(k)) continue;
    out[k] = base[k];
  }
  for (const k of Object.keys(override || {})) {
    if (isEvilKey(k)) continue;
    const bv = base && base[k];
    const ov = override[k];
    if (bv && typeof bv === "object" && !Array.isArray(bv) &&
        ov && typeof ov === "object" && !Array.isArray(ov)) {
      out[k] = deepMerge(bv, ov);
    } else {
      out[k] = ov;
    }
  }
  return out;
}

function pathGet(o, p) {
  return p.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), o);
}
function pathSet(o, p, v) {
  const parts = p.split(".");
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
}

// ---------- schema 校验 + 钳制（对已合并的 cfg 就地修正，返回修正条目） ----------
function sanitizeCfg(cfg) {
  const fixed = [];
  const root = { root: cfg };
  for (const [p, rule] of Object.entries(SCHEMA)) {
    const raw = pathGet(cfg, p);
    if (raw === undefined || raw === null) {
      if (rule.def !== undefined) { pathSet(cfg, p, rule.def); }
      continue;
    }
    if (rule.enum) {
      if (!rule.enum.includes(raw)) {
        fixed.push(p + "=" + JSON.stringify(raw) + " → " + JSON.stringify(rule.def));
        pathSet(cfg, p, rule.def);
      }
      continue;
    }
    if (rule.type === "bool") {
      if (typeof raw !== "boolean") {
        fixed.push(p + "=" + JSON.stringify(raw) + " → bool");
        pathSet(cfg, p, raw === true || raw === "true" || raw === 1 ? true : false);
      }
      continue;
    }
    if (rule.type === "string") {
      if (typeof raw !== "string" || (rule.maxLen && raw.length > rule.maxLen)) {
        fixed.push(p + "=非字符串/超长");
        pathSet(cfg, p, rule.def !== undefined ? rule.def : "");
      }
      continue;
    }
    if (rule.type === "int" || rule.type === "num") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        fixed.push(p + "=非数字");
        if (rule.def !== undefined) pathSet(cfg, p, rule.def);
        continue;
      }
      let v = rule.type === "int" ? Math.trunc(n) : n;
      if (rule.min !== undefined && v < rule.min) v = rule.min;
      if (rule.max !== undefined && v > rule.max) v = rule.max;
      if (v !== raw) { fixed.push(p + "=" + String(raw) + " → " + v); pathSet(cfg, p, v); }
    }
  }
  return fixed;
}

function log(msg) { try { console.error("[config] " + msg); } catch (e) {} }

function load() {
  if (_cfg) return _cfg;
  return reload();
}

// reload()：无视缓存重读磁盘并校验（供外部编辑热读 / 测试）
function reload() {
  let base = deepMerge({}, DEFAULTS);
  const cp = configPath();
  if (cp && fs.existsSync(cp)) {
    try {
      const saved = JSON.parse(fs.readFileSync(cp, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        base = deepMerge(DEFAULTS, saved);
      } else {
        log("配置文件结构异常（非对象），使用默认值: " + cp);
      }
    } catch (e) {
      log("配置读取失败，使用默认值: " + e.message);
    }
  }
  const fixed = sanitizeCfg(base);
  if (fixed.length) log("配置越界/非法已钳制: " + fixed.join("; "));
  _cfg = base;
  return _cfg;
}

function backup() {
  const cp = configPath();
  if (!cp || !fs.existsSync(cp)) return;
  if (_backedUp) return; // 进程内只做一次（首次保存前）
  _backedUp = true;
  try { fs.copyFileSync(cp, cp + ".bak"); } catch (e) { /* ignore */ }
}

function save() {
  const cp = configPath();
  if (!cp) { log("save: dataDir 未设置"); return; }
  try {
    fs.mkdirSync(_dir, { recursive: true });
    backup(); // 保存前留 .bak（上次可用）
    const tmp = cp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(_cfg, null, 2), "utf8");
    fs.renameSync(tmp, cp); // 原子替换
  } catch (e) {
    log("save error: " + e.message);
  }
}

function get(keyPath) {
  const cfg = load();
  return keyPath.split(".").reduce((o, k) => (o == null ? o : o[k]), cfg);
}

function set(keyPath, value) {
  const cfg = load();
  const parts = String(keyPath || "").split(".").filter(Boolean);
  if (parts.length === 0) return value;
  for (const p of parts) if (isEvilKey(p)) return value;
  let o = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  // 立即钳制本路径（若在 schema 内）
  const f = sanitizeCfg(cfg);
  if (f.length) log("保存值钳制: " + f.join("; "));
  save();
  return value;
}

module.exports = {
  DEFAULTS, SCHEMA,
  dataDir, setDataDir,
  load, reload, save, get, set,
  sanitizeCfg, deepMerge,
};
