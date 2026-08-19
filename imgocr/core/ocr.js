// core/ocr.js — tesseract.js 封装：本地识别、进度回调、超时/取消保护、单 worker 串行复用
"use strict";

const { safeString, safeInt, sanitizeForLog } = require("./safe");

const DEFAULT_TIMEOUT_MS = 120 * 1000;
const DEFAULT_LANGS = ["eng", "chi_sim"];

class OcrEngine {
  constructor(opts) {
    opts = opts || {};
    this.opts = {
      langPath: typeof opts.langPath === "string" && opts.langPath ? opts.langPath : null, // 本地 tessdata 目录（存在则离线）
      cachePath: typeof opts.cachePath === "string" && opts.cachePath ? opts.cachePath : null,
      logger: typeof opts.logger === "function" ? opts.logger : null,
      timeoutMs: safeInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 10 * 60 * 1000),
      langs: Array.isArray(opts.langs) && opts.langs.length
        ? opts.langs.map((x) => safeString(x, 64)).slice(0, 6)
        : DEFAULT_LANGS.slice()
    };
    this._worker = null;
    this._workerLangs = null;
    this._busy = Promise.resolve();
    this._terminated = false;
  }

  async _getWorker(langs) {
    const key = langs.slice().sort().join("+");
    if (this._worker && this._workerLangs === key && !this._terminated) return this._worker;
    if (this._worker) {
      try { await this._worker.terminate(); } catch {}
    }
    this._workerLangs = key;
    // 延迟 require：仅在真正识别时才加载 tesseract.js（启动更快，且不影响纯存档使用）
    const { createWorker } = require("tesseract.js");
    const opts = {};
    if (this.opts.langPath) opts.langPath = this.opts.langPath;
    if (this.opts.cachePath) opts.cachePath = this.opts.cachePath;
    if (this.opts.logger) {
      opts.logger = (m) => { try { this.opts.logger(m); } catch {} };
    }
    this._worker = await createWorker(key, 1, opts); // oem=1 LSTM
    return this._worker;
  }

  // 串行执行：一次只跑一个识别，避免多个 wasm worker 内存爆炸
  recognize(imagePath, opt) {
    opt = opt || {};
    const langs = Array.isArray(opt.langs) && opt.langs.length
      ? opt.langs.map((x) => safeString(x, 64)).slice(0, 6)
      : this.opts.langs.slice();
    const tmo = safeInt(opt.timeoutMs, this.opts.timeoutMs, 1000, 10 * 60 * 1000);
    const signal = opt.signal;

    const run = async () => {
      if (this._terminated) throw new Error("引擎已关闭");
      if (signal && signal.aborted) throw new Error("已取消");
      const worker = await this._getWorker(langs);
      if (signal && signal.aborted) throw new Error("已取消");
      let timer = null;
      try {
        const started = Date.now();
        const timeoutP = new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("OCR 超时(" + Math.round(tmo / 1000) + "s)")), tmo);
          if (timer.unref) timer.unref();
        });
        const abortP = signal
          ? new Promise((_, rej) => {
              if (signal.aborted) return rej(new Error("已取消"));
              signal.addEventListener("abort", () => rej(new Error("已取消")), { once: true });
            })
          : null;
        const result = await Promise.race([worker.recognize(imagePath), timeoutP].concat(abortP ? [abortP] : []));
        const data = result && result.data ? result.data : result;
        const text = safeString(data && data.text);
        let conf = null;
        if (Array.isArray(data && data.confidence)) {
          const vals = data.confidence.filter((v) => typeof v === "number" && isFinite(v));
          if (vals.length) conf = Math.min(1, Math.max(0, vals.reduce((a, b) => a + b, 0) / vals.length));
        }
        return {
          ok: true,
          text: text,
          confidence: conf,
          durationMs: Date.now() - started,
          langs: langs.slice()
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const p = this._busy.then(run, run);
    this._busy = p.then(() => {}, () => {});
    return p;
  }

  async terminate() {
    this._terminated = true;
    const w = this._worker;
    this._worker = null;
    if (w) { try { await w.terminate(); } catch {} }
  }
}

module.exports = { OcrEngine, DEFAULT_LANGS, DEFAULT_TIMEOUT_MS };