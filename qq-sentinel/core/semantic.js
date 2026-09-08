// core/semantic.js — 本地语义摘要引擎（内置轻量 embedding 模型，全离线/免费）
// 策略：过滤(机器人/纯图/复读模板) → 按日分窗 → 语义嵌入 → k-means 聚类 → 每窗代表句 + 复读提示。
// 模型 ~129MB 随包内置；懒加载一次；加载/调用失败返回 null（调用方降级统计版）。
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./logger");
const glossaryUtil = require("./glossary");

let _fePromise = null;

// ---------- 纯函数（可单测） ----------
function cleanText(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 120);
}
function isBare(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return true;
  const t = s.replace(/\[CQ:[^\]]+\]/g, "")
    .replace(/^(\s*(\[图片\]|\[表情\]|\[动画表情\]|\[语音\]|\[视频\]|\[文件\]|\[名片\]|\[链接\]|\[音乐\]|\[小程序\]|\[红包\]|\[转账\]|\[回复\]|\[戳一戳\]|\[QQ红包\])+)+\s*$/g, "");
  return t.trim().length < 2;
}
function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function kmeans(vectors, k, maxIter = 15) {
  const n = vectors.length, dim = vectors[0].length;
  const cents = [];
  for (let i = 0; i < k; i++) cents.push(vectors[Math.floor((i * n) / k)].slice());
  const assign = new Array(n).fill(0);
  for (let it = 0; it < maxIter; it++) {
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const cnt = new Array(k).fill(0);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let b = 0, bs = -2;
      for (let c = 0; c < k; c++) { const s = cos(vectors[i], cents[c]); if (s > bs) { bs = s; b = c; } }
      if (assign[i] !== b) { assign[i] = b; changed++; }
      for (let d = 0; d < dim; d++) sums[b][d] += vectors[i][d];
      cnt[b]++;
    }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let d = 0; d < dim; d++) cents[c][d] = sums[c][d] / cnt[c];
    if (changed === 0) break;
  }
  return { assign, cents };
}

// 预处理：过滤 → 窗口化。返回 { windows:[{day,items:[{text,time,nickname}]}], templates:[{day,text,count}] }
function prepareRows(rows, opts = {}) {
  const ignore = new Set((opts.ignoreUins || []).map(String));
  const templateMin = opts.templateMin ?? 3;
  const freq = new Map();
  const items = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    if (ignore.has(String(r.userId || ""))) continue;
    if (isBare(r.text)) continue;
    const t = cleanText(r.text);
    if (t.length < 2) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
    items.push({ text: t, time: r.time || "", nickname: r.nickname || r.userId || "", hotHits: Array.isArray(r.hotHits) ? r.hotHits : [] });
  }
  const template = new Set([...freq.entries()].filter(([, c]) => c >= templateMin).map(([t]) => t));
  const real = items.filter((r) => !template.has(r.text));
  // 按日分窗（time 取 UTC 日期；无时间的并入首个窗）
  const byDay = new Map();
  for (const r of real) {
    const day = r.time ? String(r.time).slice(0, 10) : "__none__";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const windows = [...byDay.entries()]
    .filter(([, arr]) => arr.length >= 8)
    .sort((a, b) => (a[0] === "__none__" ? 1 : b[0] === "__none__" ? -1 : a[0] < b[0] ? -1 : 1))
    .map(([day, arr]) => ({ day: day === "__none__" ? "" : day, items: arr }));
  const templates = [...freq.entries()]
    .filter(([, c]) => c >= templateMin)
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({ text: String(text).slice(0, 60), count }));
  return { windows, templates };
}

// ---------- 模型加载（Windows 坑：localModelPath=父目录 + 相对目录名） ----------
const MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2";
function localModelsBase() {
  return path.join(path.dirname(__dirname), "models").replace(/\\/g, "/") + "/";
}
function modelDir() {
  const local = path.join(path.dirname(__dirname), "models", MODEL_NAME);
  return fs.existsSync(path.join(local, "onnx")) ? local.replace(/\\/g, "/") : null;
}
function loadPipeline() {
  if (_fePromise) return _fePromise;
  _fePromise = (async () => {
    try {
      const { pipeline, env } = require("@xenova/transformers");
      env.allowRemoteModels = false;
      if (!modelDir()) { L.warn("[semantic] 内置模型缺失"); return null; }
      env.localModelPath = localModelsBase();
      const fe = await pipeline("feature-extraction", MODEL_NAME, { quantized: true });
      return fe;
    } catch (e) {
      L.warn("[semantic] 模型加载失败:", e && e.message);
      _fePromise = null;
      return null;
    }
  })();
  return _fePromise;
}
async function embedOne(fe, text) {
  const r = await fe(text, { pooling: "mean", normalize: true });
  return Array.from(r.data || r[0].data || []);
}

// ---------- 入口 ----------
async function semanticSummarize(rows, opts = {}) {
  try {
    const { windows, templates } = prepareRows(rows, opts);
    const totalReal = windows.reduce((a, w) => a + w.items.length, 0);
    if (totalReal < 8) return null;
    const fe = await loadPipeline();
    if (!fe) return null;
    const MAX_PER_WINDOW = 400;
    const lines = [];
    let clusters = 0, embedded = 0;
    for (const win of windows) {
      const sample = win.items.slice(-MAX_PER_WINDOW);
      // 词表命中：窗口内文本出现的黑话/梗 → 给一句解释（最多 2 条/窗）
      const glossHits = [];
      if (opts.glossary && opts.glossary.length) {
        const joined = sample.map((r) => r.text).join("\n");
        for (const g of glossaryUtil.matchGlossary(joined, opts.glossary)) {
          if (!glossHits.some((x) => x.word === g.word)) glossHits.push(g);
          if (glossHits.length >= 2) break;
        }
      }
      const vectors = [];
      for (const r of sample) vectors.push(await embedOne(fe, r.text));
      embedded += sample.length;
      const k = Math.max(2, Math.min(4, Math.round(sample.length / 60)));
      const { assign, cents } = kmeans(vectors, k, 15);
      const groups = new Map();
      for (let i = 0; i < sample.length; i++) {
        if (!groups.has(assign[i])) groups.set(assign[i], []);
        groups.get(assign[i]).push(i);
      }
      const parts = [];
      for (const [c, idxs] of groups) {
        if (idxs.length < 2) continue;
        idxs.sort((a, b) => cos(vectors[b], cents[c]) - cos(vectors[a], cents[c]));
        const times = idxs.map((i) => sample[i].time).filter(Boolean).sort();
        parts.push({
          count: idxs.length,
          from: times[0] || "",
          to: times[times.length - 1] || "",
          rep: sample[idxs[0]],
        });
      }
      parts.sort((a, b) => b.count - a.count);
      if (!parts.length) continue;
      clusters += Math.min(parts.length, 3);
      if (win.day) lines.push("【" + String(win.day).slice(5) + "】");
      if (glossHits.length) for (const g of glossHits) lines.push("   💬 「" + g.word + "」= " + g.meaning);
      // 关联热搜（collector 对消息打的 hotHits 聚合，去重 top2）
      const hotTitles = [];
      for (const r of sample) {
        for (const h of r.hotHits || []) {
          const t = String(h && h.title || "").trim().slice(0, 40);
          if (t && !hotTitles.includes(t)) hotTitles.push(t);
          if (hotTitles.length >= 2) break;
        }
        if (hotTitles.length >= 2) break;
      }
      if (hotTitles.length) lines.push("   🔥 关联热搜：疑似在聊 " + hotTitles.join(" / "));
      for (const p of parts.slice(0, 3)) {
        const span = p.from && p.to && p.from !== p.to
          ? "（" + String(p.from).slice(11, 16) + "~" + String(p.to).slice(11, 16) + "）"
          : "";
        const t = p.rep.time ? "[" + String(p.rep.time).slice(11, 16) + "] " : "";
        lines.push("• 话题 " + p.count + " 条" + span + ":");
        lines.push("   " + t + (p.rep.nickname ? p.rep.nickname + "：" : "") + p.rep.text);
      }
      if (win.day) {
        const tpl = templates.filter((x) => true);
        const top = tpl.slice(0, 1);
        if (top.length) lines.push("   🔁「" + top[0].text + "」复读 " + top[0].count + " 次");
      }
    }
    if (!lines.length) return null;
    return { text: lines.join("\n"), clusters, items: embedded, engine: "semantic" };
  } catch (e) {
    L.warn("[semantic] 摘要失败:", e && e.message);
    return null;
  }
}

module.exports = { semanticSummarize, prepareRows, loadPipeline, cleanText, isBare, cos, kmeans };
