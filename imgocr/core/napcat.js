// core/napcat.js — NapCat (OneBot v11 WS) 只读客户端
// 原则：只调用只读 API（get_group_list / get_group_msg_history），绝不发送任何消息；
// 图片只下载到应用自己的缓存目录（userData/images），不改动 NapCat / QQ 的任何数据。
"use strict";

const WebSocket = require("ws");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { safeString, safeInt, sanitizeForLog } = require("./safe");

const DEFAULT_WS = "ws://127.0.0.1:3001";
const RECONNECT_MS = 5000;
const CALL_TIMEOUT_MS = 60000;
const MAX_IMAGES_PER_GROUP = 100;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_GROUPS = 50;

// QQ 图片 CDN 域名白名单（只允许下载这些主机的图片）
const ALLOWED_IMAGE_HOSTS = [/\.qpic\.cn$/i, /\.qlogo\.cn$/i, /\.gtimg\.cn$/i, /\.qq\.com$/i];

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

// 校验 wsUrl：仅本地 ws 或任意 wss
function validateWsUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol === "ws:") {
    if (!isLoopback(parsed.hostname)) return null;
  } else if (parsed.protocol !== "wss:") {
    return null;
  }
  return u;
}

class NapCatClient {
  constructor(opts) {
    opts = opts || {};
    const wsUrl = validateWsUrl(opts.wsUrl || DEFAULT_WS);
    this.wsUrl = wsUrl || DEFAULT_WS;
    this.imageDir = typeof opts.imageDir === "string" && opts.imageDir ? opts.imageDir : null;
    this.reconnectMs = safeInt(opts.reconnectMs, RECONNECT_MS, 1000, 60000);
    this.callTimeoutMs = safeInt(opts.callTimeoutMs, CALL_TIMEOUT_MS, 2000, 60000);

    this._ws = null;
    this._seq = 0;
    this._pending = new Map(); // echo -> {resolve, reject, timer}
    this._listeners = new Set();
    this._manualClose = false;
    this._reconnectTimer = null;
    this._connected = false;
  }

  get connected() { return this._connected; }

  // ---------- 连接管理 ----------
  connect() {
    this._manualClose = false;
    if (this._ws && this._connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.wsUrl, { handshakeTimeout: 8000 });
      } catch (err) {
        return reject(err);
      }
      this._ws = ws;
      ws.on("open", () => {
        this._connected = true;
        if (!settled) { settled = true; resolve(); }
      });
      ws.on("message", (data) => {
        try { this._handleMessage(JSON.parse(String(data))); } catch {}
      });
      ws.on("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      ws.on("close", () => {
        this._connected = false;
        this._failPending(new Error("NapCat 连接断开"));
        if (!this._manualClose) {
          this._reconnectTimer = setTimeout(() => { this.connect(); }, this.reconnectMs);
          if (this._reconnectTimer.unref) this._reconnectTimer.unref();
        }
      });
    });
  }

  // 确保已连接（未连则尝试一次）
  async ensureConnected() {
    if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) return;
    await this.connect();
  }

  close() {
    this._manualClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._failPending(new Error("客户端已关闭"));
    if (this._ws) { try { this._ws.close(); } catch {} }
    this._ws = null;
    this._connected = false;
  }

  _failPending(err) {
    for (const [, p] of this._pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  // ---------- RPC 调用 ----------
  call(method, params, timeoutMs) {
    const tmo = safeInt(timeoutMs, this.callTimeoutMs, 2000, 300000);
    return this.ensureConnected().then(() => {
      return new Promise((resolve, reject) => {
        const echo = "c" + (++this._seq);
        const timer = setTimeout(() => {
          this._pending.delete(echo);
          reject(new Error("NapCat 调用超时: " + method));
        }, tmo);
        if (timer.unref) timer.unref();
        this._pending.set(echo, { resolve, reject, timer });
        try {
          this._ws.send(JSON.stringify({ action: method, params: params || {}, echo: echo }));
        } catch (err) {
          clearTimeout(timer);
          this._pending.delete(echo);
          reject(err);
        }
      });
    });
  }

  _handleMessage(msg) {
    if (msg && typeof msg.echo === "string" && this._pending.has(msg.echo)) {
      const p = this._pending.get(msg.echo);
      this._pending.delete(msg.echo);
      if (p.timer) clearTimeout(p.timer);
      if (msg.status === "ok" || msg.retcode === 0) p.resolve(msg.data);
      else p.reject(new Error("NapCat 返回错误: " + sanitizeForLog(String((msg && msg.message) || msg.retcode || "未知")).slice(0, 200)));
      return;
    }
    // 事件推送
    if (msg && msg.post_type === "message" && this._listeners.size) {
      for (const cb of this._listeners) {
        try { cb(msg); } catch {}
      }
    }
  }

  onMessage(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }

  // ---------- 只读 API ----------
  async listGroups() {
    const data = await this.call("get_group_list", {});
    if (!Array.isArray(data)) return [];
    return data.map((g) => ({
      groupId: safeInt(g && g.group_id, 0),
      groupName: safeString(g && g.group_name, 200) || ("群 " + safeInt(g && g.group_id, 0))
    })).filter((g) => g.groupId > 0).slice(0, MAX_GROUPS);
  }

  // 拉取指定群最近图片：message_seq=0 + count 读本地历史（NapCat 内存索引限制，不做游标翻页）。
  // 实测 NapCat 对 count≥100 的查询可能挂起，count≤50 秒回；无本地缓存报"消息0不存在"。
  async fetchRecentImages(groups, perGroup) {
    const pg = safeInt(perGroup, MAX_IMAGES_PER_GROUP, 1, 500);
    const out = [];
    for (const gid of groups.slice(0, MAX_GROUPS)) {
      let messages = null;
      // NapCat 实测：count 较大(≥100)时查询可能挂起，小 count(≤50) 秒回 → 用小 count 阶梯
      for (const cnt of [50, 20, 10]) {
        const tmo = cnt === 50 ? 20000 : (cnt === 20 ? 15000 : 10000);
        try {
          const data = await this.call("get_group_msg_history", { group_id: gid, message_seq: 0, count: cnt }, tmo);
          const cand = Array.isArray(data) ? data : (data && Array.isArray(data.messages) ? data.messages : []);
          if (Array.isArray(cand) && cand.length > 0) { messages = cand; break; }
          if (Array.isArray(cand)) break; // 空 = 本地无缓存
        } catch (err) {
          const msg = String((err && err.message) || "");
          if (/消息0不存在|not exist|不存在/.test(msg)) break; // 本地无缓存视为空
          console.warn("[napcat] 群 " + gid + " count=" + cnt + " 失败，降级:", sanitizeForLog(msg));
        }
      }
      if (!Array.isArray(messages) || messages.length === 0) continue;
      const seen = new Set();
      const found = [];
      // 倒序（最新在前）
      for (let i = messages.length - 1; i >= 0 && found.length < pg; i--) {
        const m = messages[i];
        const segs = Array.isArray(m && m.message) ? m.message : [];
        for (const seg of segs) {
          if (!seg || seg.type !== "image") continue;
          const file = safeString(seg.data && seg.data.file, 300);
          const url = safeString(seg.data && seg.data.url, 1000);
          if (!file || seen.has(file)) continue;
          seen.add(file);
          found.push({
            msgId: safeString(m && m.message_id, 200),
            time: safeInt(m && m.time, 0),
            file: file,
            url: url,
            token: safeString(seg.data && seg.data.token, 500)
          });
          if (found.length >= pg) break;
        }
      }
      for (const img of found) {
        out.push({ groupId: gid, image: img });
      }
    }
    return out;
  }

  // 物化单张图片：优先用魔改 token（NapCat 经 QQ 内核 get_image 下载到本地真实路径），
  // 失败/无 token 时回退 URL 下载。返回我们自己的缓存目录里的本地路径。
  async materializeImage(image, groupId) {
    if (!image) return null;
    if (image.token) {
      try {
        const r = await this.call("get_image", { file: image.token }, 90000);
        const p = r && typeof r.file === "string" ? r.file : null;
        if (p && fs.existsSync(p)) {
          return this.copyToCache(p, groupId, image.file || path.basename(p));
        }
      } catch (err) {
        console.warn("[napcat] get_image token 失败:", sanitizeForLog(err && err.message));
      }
    }
    if (image.url) {
      try {
        return await this.downloadImage(image, groupId);
      } catch (err) {
        console.warn("[napcat] URL 下载失败:", sanitizeForLog(err && err.message));
      }
    }
    return null;
  }

  // 把 NapCat/QQ 缓存里的文件复制到我们自己的缓存目录（源文件可能被 QQ 清理）
  copyToCache(srcPath, groupId, fileName) {
    if (!this.imageDir) return null;
    const dir = path.join(this.imageDir, String(safeInt(groupId, 0)));
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statSync(srcPath);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
    const ext = path.extname(fileName || srcPath).toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".jpg";
    const hash = crypto.createHash("sha1").update(srcPath + ":" + (fileName || "")).digest("hex").slice(0, 24);
    const dest = path.join(dir, hash + safeExt);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    fs.copyFileSync(srcPath, dest);
    return dest;
  }

  // 下载单张图片到 imageDir/<groupId>/<sha1>.ext，返回本地路径
  async downloadImage(image, groupId) {
    if (!this.imageDir) throw new Error("未设置图片缓存目录");
    const url = image && image.url;
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("图片 URL 非法"); }
    const hostOk = ALLOWED_IMAGE_HOSTS.some((re) => re.test(parsed.hostname));
    if (!hostOk || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new Error("图片域名不在白名单: " + parsed.hostname);
    }
    const dir = path.join(this.imageDir, String(safeInt(groupId, 0)));
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(parsed.pathname).toLowerCase() || ".jpg";
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".jpg";
    const hash = crypto.createHash("sha1").update(String(image.file || url)).digest("hex").slice(0, 24);
    const dest = path.join(dir, hash + safeExt);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    await this._downloadTo(url, dest);
    return dest;
  }

  _downloadTo(url, dest) {
    return new Promise((resolve, reject) => {
      const mod = url.indexOf("https:") === 0 ? https : http;
      const tmp = dest + "." + process.pid + ".tmp";
      const req = mod.get(url, { timeout: 30000, headers: { "User-Agent": "imgocr/0.1" } }, (res) => {
        if (res.statusCode !== 200) {
          try { fs.unlinkSync(tmp); } catch {}
          res.resume();
          return reject(new Error("下载失败 HTTP " + res.statusCode));
        }
        const cl = parseInt(res.headers["content-length"] || "0", 10);
        if (cl > MAX_IMAGE_BYTES) {
          try { fs.unlinkSync(tmp); } catch {}
          res.resume();
          return reject(new Error("图片过大"));
        }
        let size = 0;
        const f = fs.createWriteStream(tmp);
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_IMAGE_BYTES) {
            req.destroy(new Error("图片过大"));
          }
        });
        res.pipe(f);
        f.on("finish", () => {
          f.close(() => {
            try { fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} return reject(e); }
            resolve(dest);
          });
        });
        f.on("error", (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
        req.on("error", (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
        req.on("timeout", () => { req.destroy(new Error("下载超时")); });
      });
      req.on("error", (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    });
  }
}

module.exports = { NapCatClient, DEFAULT_WS, validateWsUrl, ALLOWED_IMAGE_HOSTS };