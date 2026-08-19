// core/config.js — 配置读写（userData/config.json）
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
  watch: {
    groups: [],        // 监听群号列表（空 = 全部）
    collectHistoryDays: 3,  // 启动时回拉历史天数
  },
  summarize: {
    dailyHour: 22,     // 每日汇总触发小时（24h）
    mode: "auto",       // 汇总引擎：auto=有 DeepSeek key 用 AI，否则本地统计版；deepseek=强制 AI；local=强制本地
    defaultDays: 7,    // 默认汇总窗口天数（一周；距上次汇总不足则从上次起）
    includeAnnouncements: true,
    includeAtAll: true,
    includeConflicts: true,
    conflictWindowMin: 10,   // 吵架检测时间窗（分钟）
    conflictMessageMin: 8,   // 时间窗内最少消息数
    ignoreBotUins: [],       // 补充忽略的官方机器人 QQ 号（默认自动过滤 2854196 号段）
    autoIgnoreBots: true,    // 检测到 is_robot 成员时自动并入 ignoreBotUins
    burstEnabled: true,      // 突发总结：检测消息激增时段，按 起因→过程→结果 复盘
    burstBucketMin: 5,       // 突发检测粒度（分钟/桶）
    burstMinCount: 20,       // 突发绝对阈值：一个桶内至少多少条消息
    burstMult: 2,            // 突发相对阈值：≥ 该群基线（桶计数中位数）的多少倍
    burstContextMin: 10,     // 起因上下文：取突发窗口前多少分钟的消息找引爆点
    burstMax: 5,             // 单次汇总最多列出几个突发
  },
  hotspots: {
    enabled: true,     // 启用热点库（汇总参考 + 消息热梗标记）
    cacheMinutes: 15,  // 热点缓存时长（分钟）
    platforms: ["weibo", "douyin", "bilibili"], // 启用平台：weibo微博 / douyin抖音 / bilibili哔哩哔哩
  },
  deepseek: {
    apiKey: "",        // DEEPSEEK_API_KEY（也可从环境变量读取）
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
  },
  ocr: {
    enabled: true,        // 全家桶互调：调用图片识别工具（imgocr）OCR 群图
    bridgeUrl: "http://127.0.0.1:8765", // imgocr 本地 OCR 服务地址
    bridgeToken: "",      // 桥令牌（留空自动从 imgocr 的 userData 读取）
  },
  ui: {
    theme: "auto",     // auto | light | dark
  },
};

let _dir = null;
let _cfg = null;

function dataDir() {
  return _dir;
}
function setDataDir(dir) {
  _dir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function configPath() {
  return path.join(_dir, "config.json");
}

function load() {
  if (_cfg) return _cfg;
  let base = { ...DEFAULTS };
  try {
    if (fs.existsSync(configPath())) {
      const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      base = deepMerge(DEFAULTS, saved);
    }
  } catch (e) {
    console.error("[config] load error:", e.message);
  }
  _cfg = base;
  return _cfg;
}

function save() {
  try {
    fs.mkdirSync(_dir, { recursive: true });
    // 原子写：先写临时文件再重命名，防中途崩溃损坏配置
    const tmp = configPath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(_cfg, null, 2), "utf8");
    fs.renameSync(tmp, configPath());
  } catch (e) {
    console.error("[config] save error:", e.message);
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
  // 防原型污染：禁止 __proto__ / constructor / prototype 作为 key
  for (const p of parts) {
    if (p === "__proto__" || p === "constructor" || p === "prototype") return value;
  }
  let o = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  save();
  return value;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    if (
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k]) &&
      typeof override[k] === "object" &&
      !Array.isArray(override[k])
    ) {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

module.exports = { DEFAULTS, dataDir, setDataDir, load, save, get, set };

