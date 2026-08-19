// core/bridge.js — 本地 HTTP OCR 服务（全家桶互调桥）
// 127.0.0.1:8765，令牌鉴权（存 userData/bridge-token.txt），只读：
//   只接受"本地存在的图片文件路径"并返回识别文本，绝不读取任意文件内容、绝不做任何写操作。
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { safeString, safeInt, isImagePath, sanitizeForLog } = require("./safe");

const DEFAULT_PORT = 8765;

class BridgeServer {
  constructor(opts) {
    opts = opts || {};
    this.port = safeInt(opts.port, DEFAULT_PORT, 1024, 65535);
    this.tokenFile = opts.tokenFile || null;
    this.userDataDir = opts.userDataDir || null;
    this.engine = opts.engine || null; // OcrEngine 实例
    this._token = null;
    this._server = null;
  }

  getToken() {
    if (this._token) return this._token;
    try {
      if (this.tokenFile && fs.existsSync(this.tokenFile)) {
        const t = fs.readFileSync(this.tokenFile, "utf8").trim();
        if (/^[A-Za-z0-9]{16,64}$/.test(t)) { this._token = t; return t; }
      }
    } catch {}
    this._token = crypto.randomBytes(24).toString("hex");
    try {
      if (this.tokenFile) {
        fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
        fs.writeFileSync(this.tokenFile, this._token, "utf8");
      }
    } catch {}
    return this._token;
  }

  start() {
    if (this._server) return;
    const token = this.getToken();
    this._server = http.createServer((req, res) => {
      this._handle(req, res, token).catch((e) => {
        this._json(res, 500, { ok: false, error: "内部错误: " + sanitizeForLog(e && e.message).slice(0, 200) });
      });
    });
    this._server.on("error", (e) => {
      console.warn("[bridge] 服务异常:", sanitizeForLog(e && e.message));
    });
    this._server.listen(this.port, "127.0.0.1");
    console.log(`[bridge] OCR 服务已启动 http://127.0.0.1:${this.port}`);
  }

  stop() {
    if (this._server) { try { this._server.close(); } catch {} this._server = null; }
  }

  _json(res, code, obj) {
    try {
      const body = Buffer.from(JSON.stringify(obj), "utf8");
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
      res.end(body);
    } catch {}
  }

  async _handle(req, res, token) {
    // 只允许本地回环
    const addr = req.socket && req.socket.remoteAddress;
    if (!(addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1")) {
      return this._json(res, 403, { ok: false, error: "仅允许本机调用" });
    }
    const url = req.url || "/";
    const p = url.split("?")[0];
    if (req.method === "GET" && p === "/api/health") {
      return this._json(res, 200, { ok: true, service: "imgocr-bridge", port: this.port, engine: Boolean(this.engine) });
    }
    if (req.method !== "POST" || p !== "/api/ocr") {
      return this._json(res, 404, { ok: false, error: "not found" });
    }
    // 令牌校验
    if (req.headers["x-bridge-token"] !== token) {
      return this._json(res, 401, { ok: false, error: "令牌无效" });
    }
    // 读取 body（≤1MB）
    const body = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 1024 * 1024) { req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    if (!body) return this._json(res, 400, { ok: false, error: "请求体为空" });
    let payload;
    try { payload = JSON.parse(body); } catch { return this._json(res, 400, { ok: false, error: "JSON 解析失败" }); }
    const imgPath = safeString(payload && payload.path, 1024);
    if (!imgPath) return this._json(res, 400, { ok: false, error: "缺少 path" });
    if (!isImagePath(imgPath)) return this._json(res, 400, { ok: false, error: "路径不是图片" });
    let st;
    try { st = fs.statSync(imgPath); } catch { return this._json(res, 404, { ok: false, error: "图片不存在" }); }
    if (!st.isFile() || st.size <= 0 || st.size > 100 * 1024 * 1024) {
      return this._json(res, 400, { ok: false, error: "图片文件无效" });
    }
    if (!this.engine) return this._json(res, 503, { ok: false, error: "OCR 引擎未就绪" });
    const langs = Array.isArray(payload.langs) && payload.langs.length
      ? payload.langs.map((x) => safeString(x, 64)).filter((x) => /^[A-Za-z0-9_\-]+$/.test(x)).slice(0, 6)
      : ["eng", "chi_sim"];
    const started = Date.now();
    const r = await this.engine.recognize(imgPath, { langs });
    return this._json(res, 200, {
      ok: r.ok,
      text: r.text,
      confidence: r.confidence,
      durationMs: r.durationMs,
      serviceMs: Date.now() - started,
    });
  }
}

module.exports = { BridgeServer, DEFAULT_PORT };