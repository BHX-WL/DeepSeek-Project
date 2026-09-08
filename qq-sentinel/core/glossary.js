// core/glossary.js — 用户自定义黑话/梗词表（纯函数）
// 词表格式：数组 [{word, meaning}]。提供行式文本解析与命中匹配。
"use strict";

// 解析“每行 词=解释”文本 → [{word, meaning}]（去空、词去重）
function parseGlossaryText(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text == null ? "" : text).split(/\r?\n|[,;；，]/);
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const word = line.slice(0, eq).trim();
    const meaning = line.slice(eq + 1).trim();
    if (!word || !meaning) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ word: word.slice(0, 60), meaning: meaning.slice(0, 200) });
  }
  return out;
}

// 文本包含词表中的词？返回命中词条（含在该文本中出现的词）
function matchGlossary(text, list) {
  const hits = [];
  const t = String(text == null ? "" : text);
  if (!t) return hits;
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || !g.word) continue;
    if (t.includes(String(g.word))) hits.push(g);
    if (hits.length >= 20) break;
  }
  return hits;
}

module.exports = { parseGlossaryText, matchGlossary };
