// core/logger.js — 简单文件+控制台日志（敏感信息脱敏 + 异步写盘 + 大小轮转）
const fs = require("fs");
const path = require("path");

let _dir = null;
let _logFile = null;
let _queue = [];          // 待写行缓冲
let _flushing = false;
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB 轮转阈值

function init(dir) {
  _dir = dir;
  fs.mkdirSync(dir, { recursive: true });
  _logFile = path.join(dir, "sentinel.log");
  // 启动时若已超限则轮转一次
  try { if (fs.statSync(_logFile).size > MAX_LOG_BYTES) rotate(); } catch {}
}

function ts() {
  return new Date().toISOString();
}

// 敏感信息脱敏：token / api key / Authorization 值 / 密码类一律打码
function sanitize(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(/((?:token|api[_-]?key|password|passwd|secret|authorization)(?:["']?\s*[:=]\s*["']?))[A-Za-z0-9._\-]+/gi, "$1***")
    .replace(/\bsk-[A-Za-z0-9]{8,}/g, "sk-***");
}

// 大小轮转：sentinel.log → sentinel.log.1（保留 1 份旧日志）
function rotate() {
  try {
    const old = _logFile + ".1";
    if (fs.existsSync(old)) fs.unlinkSync(old);
    fs.renameSync(_logFile, old);
  } catch (e) { /* ignore */ }
}

function write(level, args) {
  let line;
  try { line = sanitize(`[${ts()}] [${level}] ${args.map(String).join(" ")}`); }
  catch { line = `[${ts()}] [${level}] (log args error)`; }
  if (level !== "DEBUG") {
    try { console.log(line); } catch { /* ignore */ }
  }
  if (_logFile) {
    _queue.push(line);
    scheduleFlush();
  }
}

// 异步批量写盘（防阻塞事件循环）+ 超限轮转
function scheduleFlush() {
  if (_flushing) return;
  _flushing = true;
  setImmediate(() => {
    try {
      if (_queue.length === 0) { _flushing = false; return; }
      const batch = _queue.splice(0, _queue.length);
      fs.appendFileSync(_logFile, batch.join("\n") + "\n", "utf8");
      try {
        if (fs.statSync(_logFile).size > MAX_LOG_BYTES) rotate();
      } catch {}
    } catch (e) { /* 写盘失败静默（不阻断主流程） */ }
    _flushing = false;
  });
}

module.exports = {
  init,
  info: (...a) => write("INFO", a),
  warn: (...a) => write("WARN", a),
  error: (...a) => write("ERROR", a),
  debug: (...a) => write("DEBUG", a),
};
