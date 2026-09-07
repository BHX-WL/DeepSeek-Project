// core/keywords.js — 关键词匹配（纯函数，可单测）
// 用户自定义关键词：消息文本“包含”任一关键词即命中（忽略大小写）。
"use strict";

// 归一化词表：trim、去空、去重（保序）。支持数组或换行/逗号分隔的字符串。
function normalizeKeywords(raw) {
  let arr = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[\n,，]+/);
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const s = String(item == null ? "" : item).trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

// 命中检测：返回命中的关键词列表（原文形式，保词表顺序）。text 为空或词表为空 → []。
function matchKeywords(text, keywordList) {
  if (!text || !keywordList || !keywordList.length) return [];
  const low = String(text).toLowerCase();
  const hits = [];
  for (const kw of keywordList) {
    const k = String(kw).trim();
    if (k && low.includes(k.toLowerCase())) hits.push(k);
  }
  return hits;
}

// 命中统计：输入 kw-hits 存档行，按词输出 [{word, count, first, last, sample}]（次数降序，其次词表序）
function keywordStats(hits) {
  const map = new Map(); // word(lower) -> {word, count, first, last, sample}
  for (const h of Array.isArray(hits) ? hits : []) {
    const words = Array.isArray(h.words) ? h.words.map(String) : [];
    const t = h.time || "";
    for (const w of words) {
      const key = w.toLowerCase();
      if (!map.has(key)) map.set(key, { word: w, count: 0, first: t, last: t, sample: "" });
      const st = map.get(key);
      st.count += 1;
      if (t && (!st.first || t < st.first)) st.first = t;
      if (t && t > st.last) st.last = t;
      if (!st.sample) st.sample = String(h.text || "").slice(0, 120);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
}

module.exports = { normalizeKeywords, matchKeywords, keywordStats };
