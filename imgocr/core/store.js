// core/store.js — OCR 结果本地 JSONL 存档
// 只写应用自己的数据目录(userData)，绝不修改图片源文件（只读原则）。
"use strict";

const fs = require("fs");
const path = require("path");
const { safeString, safeInt, isPlainObject, sanitizeForLog, newId, atomicWrite, MAX_LIST_LEN } = require("./safe");

const COMPACT_THRESHOLD = 20 * 1024 * 1024; // 存档超过 20MB 全量压缩重写
const MAX_ENTRIES = 20000;                  // 内存条目上限（防无限增长）

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map(); // id -> entry
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      if (raw.length > 64 * 1024 * 1024) {
        console.warn("[store] 存档超过 64MB，将只解析前段数据");
      }
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t);
          if (!isPlainObject(e) || typeof e.id !== "string" || !e.id) continue;
          this.entries.set(e.id, this._normalize(e));
        } catch { /* 坏行跳过 */ }
      }
    } catch (err) {
      console.warn("[store] 读取存档失败(将新建):", sanitizeForLog(err && err.message));
    }
    this._maybeCompact();
  }

  _normalize(e) {
    return {
      id: safeString(e.id, 128),
      filePath: safeString(e.filePath, 1024),
      fileName: safeString(e.fileName, 512),
      addedAt: safeInt(e.addedAt, 0),
      ocrAt: safeInt(e.ocrAt, 0),
      languages: Array.isArray(e.languages) ? e.languages.map((x) => safeString(x, 64)).slice(0, 8) : [],
      text: safeString(e.text),
      confidence: typeof e.confidence === "number" && isFinite(e.confidence) ? Math.min(1, Math.max(0, e.confidence)) : null,
      durationMs: safeInt(e.durationMs, 0),
      status: ["pending", "done", "error"].indexOf(e.status) >= 0 ? e.status : "pending",
      error: safeString(e.error, 2000) || null,
      summary: safeString(e.summary, 20000) || null,
      category: safeString(e.category, 200) || null
    };
  }

  // 追加一行（JSON 序列化保证无裸换行），同 id 后写覆盖前写
  _appendLine(entry) {
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    this._maybeCompact();
  }

  _maybeCompact() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      if (fs.statSync(this.filePath).size < COMPACT_THRESHOLD) return;
      this.compact();
    } catch {}
  }

  // 全量原子重写（去重 + 压缩）
  compact() {
    const lines = [];
    for (const e of this.entries.values()) lines.push(JSON.stringify(e));
    atomicWrite(this.filePath, lines.join("\n") + (lines.length ? "\n" : ""));
  }

  add(entry) {
    this.load();
    if (this.entries.size >= MAX_ENTRIES) {
      // 淘汰最旧条目，保持上限
      let oldest = null;
      for (const e of this.entries.values()) {
        if (!oldest || e.addedAt < oldest.addedAt) oldest = e;
      }
      if (oldest) this.entries.delete(oldest.id);
    }
    const norm = this._normalize(Object.assign({}, entry, {
      id: entry && entry.id ? safeString(entry.id, 128) : newId("e"),
      addedAt: entry && entry.addedAt ? safeInt(entry.addedAt, Date.now()) : Date.now()
    }));
    this.entries.set(norm.id, norm);
    this._appendLine(norm);
    return Object.assign({}, norm);
  }

  get(id) {
    this.load();
    const e = this.entries.get(safeString(id, 128));
    return e ? Object.assign({}, e) : null;
  }

  update(id, patch) {
    this.load();
    const cur = this.entries.get(safeString(id, 128));
    if (!cur) return null;
    const merged = this._normalize(Object.assign({}, cur, patch, { id: cur.id, addedAt: cur.addedAt }));
    this.entries.set(merged.id, merged);
    this._appendLine(merged);
    return Object.assign({}, merged);
  }

  remove(id) {
    this.load();
    const ok = this.entries.delete(safeString(id, 128));
    if (ok) this.compact(); // 删除后全量重写，避免残留行
    return ok;
  }

  clear() {
    this.load();
    this.entries.clear();
    atomicWrite(this.filePath, "");
  }

  // 全文搜索：text + fileName 大小写不敏感子串
  search(query, limit) {
    this.load();
    const q = safeString(query, 200).trim().toLowerCase();
    const lim = safeInt(limit, MAX_LIST_LEN, 1, MAX_LIST_LEN);
    const out = [];
    for (const e of this.entries.values()) {
      if (out.length >= lim) break;
      if (!q || e.text.toLowerCase().indexOf(q) >= 0 || e.fileName.toLowerCase().indexOf(q) >= 0) {
        out.push(Object.assign({}, e));
      }
    }
    out.sort((a, b) => b.addedAt - a.addedAt);
    return out;
  }

  stats() {
    this.load();
    let count = 0, done = 0, error = 0, pending = 0, lastAt = 0;
    for (const e of this.entries.values()) {
      count++;
      if (e.status === "done") done++;
      else if (e.status === "error") error++;
      else pending++;
      if (e.addedAt > lastAt) lastAt = e.addedAt;
    }
    return { count: count, done: done, error: error, pending: pending, lastAt: lastAt, file: this.filePath };
  }

  flush() {
    this.load();
    this.compact();
  }
}

module.exports = { Store };