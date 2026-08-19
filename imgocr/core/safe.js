// core/safe.js — 通用防护性工具：字符串截断、日志脱敏、原子写、路径/扩展名校验
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 全局长度上限（防不可信输入撑爆内存/磁盘）
const MAX_TEXT_LEN = 2 * 1024 * 1024; // OCR 文本等大字段 2MB
const MAX_PATH_LEN = 1024;            // 路径上限
const MAX_LIST_LEN = 500;             // 搜索/列表返回上限

function safeString(v, maxLen = MAX_TEXT_LEN) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function safeInt(v, dflt = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 日志脱敏：token / api key / sk- 等不落盘
function sanitizeForLog(s) {
  return safeString(s, 4000)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(/((?:token|api[_-]?key|password|passwd|secret|authorization)(?:["']?\s*[:=]\s*["']?))[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(/\bsk-[A-Za-z0-9]{8,}/g, "sk-***");
}

// 短随机 id
function newId(prefix = "e") {
  return prefix + "-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

// 原子写：tmp + rename，失败时清理 tmp，不破坏旧文件
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, "." + path.basename(filePath) + "." + process.pid + "." + crypto.randomBytes(3).toString("hex") + ".tmp");
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf8" });
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// 校验路径字符串：非空、长度、无空字节
function safePath(v) {
  if (typeof v !== "string") return null;
  if (v.length === 0 || v.length > MAX_PATH_LEN) return null;
  if (v.indexOf("\u0000") >= 0) return null;
  return v;
}

// 图片扩展名白名单
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".pbm", ".pgm", ".ppm"]);
function isImagePath(p) {
  return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

module.exports = {
  MAX_TEXT_LEN, MAX_PATH_LEN, MAX_LIST_LEN,
  safeString, safeInt, isPlainObject, sanitizeForLog, newId, atomicWrite, safePath, isImagePath, IMAGE_EXT
};