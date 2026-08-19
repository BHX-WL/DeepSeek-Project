// core/hotspots.js — 网络热梗与实时热点库（多平台）
// 数据源：
//   微博：justjavac/weibo-trending-hot-search（README.md，约10分钟更新，raw + jsdelivr 双源）
//   抖音：iesdouyin.com 官方热榜接口（免费无 key）
//   哔哩哔哩：api.bilibili.com 官方热榜接口（免费无 key，需完整 UA/Referer）
// 用途：
//   A) 汇总时提供近期热点背景（summarizer 使用）
//   B) 群消息命中热搜关键词时打"热点"标记（collector 使用）
// 设计：内存缓存（默认 15 分钟）+ 平台独立容错（一个失败不影响其他）+ 失败降级
const https = require("https");
const L = require("./logger");
const config = require("./config");

// 各平台拉取配置：{ key, label, fetcher() }
const PLATFORM_ORDER = ["weibo", "douyin", "bilibili"];

const SOURCES = {
  weibo: [
    "https://raw.githubusercontent.com/justjavac/weibo-trending-hot-search/master/README.md",
    "https://cdn.jsdelivr.net/gh/justjavac/weibo-trending-hot-search@master/README.md",
  ],
};

// 内存缓存：{ fetchedAt, platforms: { [key]: { fetchedAt, items } }, merged: [...] }
let _cache = null;
let _fetching = null; // 并发去重

function cfg(key, fb) {
  try { return config.get(key) ?? fb; } catch { return fb; }
}

// 是否启用热点库
function enabled() {
  return cfg("hotspots.enabled", true) !== false;
}

// 启用的平台列表
function enabledPlatforms() {
  const p = cfg("hotspots.platforms", PLATFORM_ORDER);
  if (!Array.isArray(p) || p.length === 0) return PLATFORM_ORDER;
  return PLATFORM_ORDER.filter((k) => p.includes(k));
}

// 缓存时长（毫秒，默认 15 分钟）
function ttl() {
  return Math.max(1, Number(cfg("hotspots.cacheMinutes", 15)) || 15) * 60000;
}

// ---------- 拉取（带缓存与并发去重） ----------
async function fetchHotspots(force = false) {
  if (!enabled()) return [];
  const now = Date.now();
  if (!force && _cache && now - _cache.fetchedAt < ttl()) return mergedItems();
  if (_fetching) return _fetching; // 已有请求在途，复用
  _fetching = doFetch().finally(() => { _fetching = null; });
  return _fetching;
}

async function doFetch() {
  const platforms = enabledPlatforms();
  // 各平台并行拉取，独立容错
  const results = await Promise.all(platforms.map(async (key) => {
    try {
      const items = await fetchPlatform(key);
      return { key, items, error: null };
    } catch (e) {
      L.warn(`[hotspots] ${key} 拉取失败: ${e.message}`);
      return { key, items: [], error: e.message };
    }
  }));
  const okResults = results.filter((r) => r.items.length > 0);
  if (okResults.length === 0) {
    // 全部失败：降级用旧缓存
    if (_cache) { L.warn("[hotspots] 全部平台失败，使用上次缓存"); return mergedItems(); }
    L.warn("[hotspots] 无可用热点数据");
    return [];
  }
  // 合并缓存：成功平台更新，失败平台保留旧缓存（不丢失历史数据）
  const platformsCache = {};
  for (const r of results) {
    if (r.items.length > 0) {
      platformsCache[r.key] = { fetchedAt: Date.now(), items: r.items, error: r.error };
    } else if (_cache && _cache.platforms && _cache.platforms[r.key] && _cache.platforms[r.key].items.length > 0) {
      // 拉取失败 → 保留该平台旧缓存
      platformsCache[r.key] = { ..._cache.platforms[r.key], error: r.error };
    } else {
      platformsCache[r.key] = { fetchedAt: Date.now(), items: [], error: r.error };
    }
  }
  _cache = { fetchedAt: Date.now(), platforms: platformsCache };
  // 合并关键词
  const merged = mergedItems();
  L.info(`[hotspots] 热点更新：${merged.length} 条（${okResults.map((r) => `${r.key}:${r.items.length}`).join("，")}）`);
  return merged;
}

async function fetchPlatform(key) {
  switch (key) {
    case "weibo": return fetchWeibo();
    case "douyin": return fetchDouyin();
    case "bilibili": return fetchBilibili();
    default: return [];
  }
}

// ---------- 微博 ----------
async function fetchWeibo() {
  let lastErr = null;
  for (const url of SOURCES.weibo) {
    try {
      const text = await httpGet(url);
      const items = parseHotItems(text);
      if (items.length === 0) { lastErr = new Error("解析结果为空"); continue; }
      return items.map((it) => ({ platform: "weibo", ...it }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("weibo fetch failed");
}

// ---------- 抖音（官方热榜） ----------
async function fetchDouyin() {
  const url = "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/";
  const text = await httpGet(url, 15000, { "Referer": "https://www.douyin.com/" });
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error("douyin bad json"); }
  const list = Array.isArray(j.word_list) ? j.word_list : [];
  return list.map((w, i) => ({
    platform: "douyin",
    rank: i + 1,
    title: String(w.word || "").trim(),
    hot_value: w.hot_value || 0,
    url: "",
  })).filter((it) => it.title);
}

// ---------- 哔哩哔哩（官方热榜） ----------
async function fetchBilibili() {
  const url = "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all";
  const text = await httpGet(url, 15000, { "Referer": "https://www.bilibili.com/" });
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error("bilibili bad json"); }
  if (j.code !== 0) throw new Error(`bilibili code=${j.code} ${j.message || ""}`);
  const list = Array.isArray(j.data?.list) ? j.data.list : [];
  return list.map((v, i) => ({
    platform: "bilibili",
    rank: i + 1,
    title: String(v.title || "").trim(),
    owner: v.owner?.name || "",
    bvid: v.bvid || "",
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : "",
  })).filter((it) => it.title);
}

// ---------- 解析微博 README ----------
// 格式：`1. [标题](https://s.weibo.com/...)`
function parseHotItems(text) {
  const out = [];
  if (!text) return out;
  const re = /^\s*(\d+)\.\s*\[([^\]]+)\]\(([^)]+)\)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = (m[2] || "").trim();
    if (!title) continue;
    out.push({ rank: Number(m[1]), title, url: m[3] || "" });
  }
  return out;
}

// ---------- 合并 & 匹配 ----------
function mergedItems() {
  if (!_cache || !_cache.platforms) return [];
  const out = [];
  for (const key of PLATFORM_ORDER) {
    const p = _cache.platforms[key];
    if (p && Array.isArray(p.items)) out.push(...p.items);
  }
  return out;
}

// ---------- 文本命中检测 ----------
// 返回命中的热点条目（含 platform 字段；返回浅拷贝，不暴露缓存内部对象）
// 命中上限 8 条，防止单条消息命中过多热点导致存储膨胀
function matchHotspots(text) {
  if (!enabled() || !text) return [];
  if (!_cache) return [];
  const t = String(text).slice(0, 2000); // 只匹配文本前 2000 字符
  const hits = [];
  for (const it of mergedItems()) {
    const title = String(it.title || "");
    if (!title) continue;
    if (t.includes(title)) { hits.push({ ...it }); if (hits.length >= 8) break; continue; }
    // 标题按词段拆分，任一词段（>=3字）命中即算
    const segs = title.replace(/[【】#\[\]（）()]/g, " ").split(/[\s,，。、!！?？:：;；/\\|·-]+/).map((s) => s.trim()).filter((s) => s.length >= 3);
    if (segs.some((s) => t.includes(s))) { hits.push({ ...it }); if (hits.length >= 8) break; }
  }
  return hits;
}

// 用关键词做模糊命中（宽松：文本含关键词即中）
function matchKeywords(text) {
  if (!enabled() || !text || !_cache) return [];
  const t = String(text);
  const out = [];
  for (const key of PLATFORM_ORDER) {
    const p = _cache.platforms?.[key];
    if (!p || !Array.isArray(p.items)) continue;
    for (const it of p.items) {
      const title = String(it.title || "");
      // 提取短词段（2-10字）做关键词
      const segs = title.replace(/[【】#\[\]（）()]/g, " ").split(/[\s,，。、!！?？:：;；/\\|·-]+/).map((s) => s.trim()).filter((s) => /[\u4e00-\u9fa5]/.test(s) && s.length >= 2 && s.length <= 10);
      for (const seg of segs) if (t.includes(seg)) out.push(seg);
    }
  }
  return [...new Set(out)].slice(0, 20);
}

// 供 collector/summarizer 使用：确保至少尝试拉取一次（fire-and-forget）
function ensureFetched() {
  if (!enabled()) return;
  if (_cache) return;
  fetchHotspots().catch(() => {});
}

// ---------- 供汇总使用的热点背景文本（分平台段落） ----------
function hotspotContext(maxPer = 12) {
  if (!enabled() || !_cache) return "";
  const parts = [];
  for (const key of PLATFORM_ORDER) {
    const p = _cache.platforms?.[key];
    if (!p || !Array.isArray(p.items) || p.items.length === 0) continue;
    const label = { weibo: "微博热搜", douyin: "抖音热榜", bilibili: "B站热榜" }[key] || key;
    const lines = p.items.slice(0, maxPer).map((it) => `${it.rank}. ${it.title}`);
    parts.push(`【${label}】\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

function status() {
  const platforms = {};
  if (_cache && _cache.platforms) {
    for (const key of PLATFORM_ORDER) {
      const p = _cache.platforms[key];
      platforms[key] = p ? { count: Array.isArray(p.items) ? p.items.length : 0, error: p.error || null, fetchedAt: p.fetchedAt ? new Date(p.fetchedAt).toISOString() : null } : { count: 0, error: "未拉取" };
    }
  }
  return {
    enabled: enabled(),
    cached: !!_cache,
    count: mergedItems().length,
    fetchedAt: _cache ? new Date(_cache.fetchedAt).toISOString() : null,
    platforms,
  };
}

// ---------- 工具 ----------
// 响应体大小上限（防止恶意/异常响应耗尽内存）
const MAX_RESP_BYTES = 2 * 1024 * 1024; // 2MB
function httpGet(url, timeout = 15000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("invalid url")); }
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const req = https.request(u, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        ...extraHeaders,
      },
      timeout,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done(reject, new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        size += Buffer.byteLength(c, "utf8");
        if (size > MAX_RESP_BYTES) {
          // 超限：丢弃响应并拒绝（防内存耗尽），确保只结算一次
          res.destroy();
          done(reject, new Error("response too large"));
          return;
        }
        data += c;
      });
      res.on("end", () => done(resolve, data));
      res.on("error", (e) => done(reject, new Error(`response error: ${e.message}`)));
      res.on("aborted", () => done(reject, new Error("response aborted")));
    });
    req.on("timeout", () => { req.destroy(); done(reject, new Error("timeout")); });
    req.on("error", (e) => done(reject, new Error(`request error: ${e.message}`)));
    req.end();
  });
}

module.exports = { fetchHotspots, matchHotspots, matchKeywords, ensureFetched, hotspotContext, status, parseHotItems, enabled };