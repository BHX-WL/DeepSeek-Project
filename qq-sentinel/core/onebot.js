// core/onebot.js — OneBot 11 客户端：正向 WS 收事件 + HTTP API 主动调用
// ⚠️ 只读承诺：本软件只能采集信息，禁止任何写操作（发消息/撤回/管理群等）。
// 所有主动 API 调用经 READ_ONLY_ACTIONS 白名单过滤，未列出的一律拒绝。
const http = require("http");
const https = require("https");
const L = require("./logger");

// 只读白名单：允许的 API 全部是"查询/读取"类。新增只读 API 需显式加到这里。
const READ_ONLY_ACTIONS = new Set([
  "get_login_info", "get_group_list", "get_group_member_list", "get_group_msg_history",
  "get_group_info", "get_group_member_info", "get_friend_list", "get_stranger_info",
  "get_msg", "get_essence_msg_list", "get_group_system_msg", "get_group_ban_list",
  "get_friend_remark", "get_version_info", "get_status", "get_cookies", "get_csrf_token",
  "_get_group_notice", "_get_model_info", "_get_friend_with_group",
]);

// 判断是否为只读 action：白名单内，或 get_/_get_ 前缀的查询类
function isReadOnlyAction(action) {
  return READ_ONLY_ACTIONS.has(action) || /^_?get_[a-z_]+$/.test(String(action || ""));
}

// 拒绝写操作：返回统一错误（无论调用方是谁，写操作一律被拦）
function readOnlyError(action) {
  return Promise.reject(new Error(`只读模式：禁止操作 ${action}（本软件仅采集信息，不做任何 QQ 写操作）`));
}

class OneBotClient {
  constructor(opts = {}) {
    this.wsUrl = opts.wsUrl || "ws://127.0.0.1:3001";
    this.httpUrl = opts.httpUrl || "http://127.0.0.1:3000";
    this.token = opts.token || "";
    this.ws = null;
    this.connected = false;
    this.selfId = null;
    this.listeners = new Set();      // (event) => void
    this._reconnectTimer = null;
    this._retryDelay = 3000;
    this._stopped = false;
    this.reconnectAttempts = 0;
    this._connecting = false;
    this._seq = 0;
    this._pending = new Map();       // echo -> {resolve,reject,method}
    // 降风险：主动 API 节流 + 失败退避 + 风控信号（保守默认）
    this.apiMinInterval = Math.max(50, Number(opts.apiMinIntervalMs) || 250);
    this._lastCallAt = 0;
    this._gate = Promise.resolve();
    this.failStreak = 0;
    this.riskHold = false;
    this._holdUntil = 0;
    this.lastError = "";
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(evt) {
    for (const fn of this.listeners) {
      try { fn(evt); } catch (e) { L.error("[onebot] listener error:", e.message); }
    }
  }

  connect() {
    if (this._stopped) return;
    if (this._connecting || this.connected) return; // 防重入：正在连接/已连通时不重复建连
    this._connecting = true;
    const WS = this._loadWS();
    if (!WS) { L.error("[onebot] no WebSocket available in this env"); return; }
    L.info(`[onebot] connecting ${this.wsUrl}`);
    let ws;
    try {
      ws = new WS(this.wsUrl, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    } catch (e) {
      this._connecting = false;
      L.error("[onebot] ws create error:", e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this._connecting = false;
      this.reconnectAttempts = 0;
      this._retryDelay = 3000;
      L.info("[onebot] ws open");
      this.emit({ type: "meta", subType: "connected" });
    });
    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch (e) {
        // 可能是二进制分片
        return;
      }
      if (frame.post_type === "meta_event" && frame.meta_event_type === "heartbeat") {
        this.emit({ type: "meta", subType: "heartbeat", payload: frame });
        return;
      }
      if (frame.echo != null) {
        const p = this._pending.get(String(frame.echo));
        if (p) {
          this._pending.delete(String(frame.echo));
          if (frame.status === "ok" || frame.retcode === 0 || frame.data != null) p.resolve(frame.data);
          else p.reject(new Error(frame.message || "onebot api error"));
        }
        return;
      }
      this.emit(frame);
    });
    ws.on("error", (err) => {
      L.warn("[onebot] ws error:", err.message || err);
    });
    ws.on("close", () => {
      this.connected = false;
      this._connecting = false;
      L.warn("[onebot] ws closed");
      this.emit({ type: "meta", subType: "disconnected" });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this.reconnectAttempts += 1;
    // 指数退避 + 随机抖动（防多实例/惊群）
    const base = 3000;
    const exp = Math.min(base * Math.pow(1.6, this.reconnectAttempts - 1), 30000);
    const delay = Math.round(exp * (0.8 + Math.random() * 0.4));
    this._retryDelay = delay;
    const n = this.reconnectAttempts;
    if (n === 1 || n % 5 === 0) {
      L.warn(`[onebot] 连接断开，将在 ${Math.round(delay / 1000)}s 后进行第 ${n} 次自动重连`);
    }
    this.emit({ type: "meta", subType: "reconnecting", attempt: n, delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _loadWS() {
    try { return require("ws"); } catch (e) { return null; }
  }

  // API 调用（OneBot 11）：优先走已连接的 WS（NapCat 只开正向 WS 3001 时也可用），HTTP 作为兜底。
  // 仅允许只读 action（白名单/查询类），写操作一律拒绝。
  // 风控/风险信号词（含常见错误文案；命中即暂停主动拉取并上报）
  static RISK_HINTS = [/风控/i, /操作频繁/i, /请求频繁/i, /请稍后/i, /too many/i, /rate.?limit/i, /1203/, /1202/, /130101/i];

  _noteSuccess() { this.failStreak = 0; if (this.riskHold && Date.now() > this._holdUntil) this.riskHold = false; }
  _noteFailure(action, msg) {
    const s = String(msg || "");
    this.lastError = s;
    this.failStreak += 1;
    if (OneBotClient.RISK_HINTS.some((re) => re.test(s))) {
      if (!this.riskHold) L.warn("[onebot] 疑似风控信号: " + s);
      this.riskHold = true;
      this._holdUntil = Date.now() + Math.min(60000, 5000 * Math.pow(2, Math.min(4, this.failStreak - 1)));
      this.emit({ type: "meta", subType: "risk", message: s, holdMs: this._holdUntil - Date.now() });
    }
  }
  // 主动 API 门禁：串行节流 + 风控暂停
  async _pace() {
    if (this.riskHold) {
      const wait = this._holdUntil - Date.now();
      if (wait > 0) throw new Error("风控暂停中，主动拉取已暂停 " + Math.ceil(wait / 1000) + "s（如持续请停用小号降低频率）");
      this.riskHold = false;
    }
    const now = Date.now();
    const wait = Math.max(0, this.apiMinInterval - (now - this._lastCallAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastCallAt = Date.now();
  }

  call(action, params = {}, timeout = 10000) {
    if (!isReadOnlyAction(action)) return readOnlyError(action); // 只读护栏：写操作一律拒绝
    // 降风险门禁：串行节流 + 风控暂停；统一记账成功/失败（事件接收不受影响，只限主动 API）
    return this._pace()
      .then(() => this._callRaw(action, params, timeout))
      .then((data) => { this._noteSuccess(); return data; })
      .catch((e) => { this._noteFailure(action, e && e.message); throw e; });
  }

  // 原始执行体（无门禁；被 call() 统一调用，便于测试与记账）
  _callRaw(action, params = {}, timeout = 10000) {
    // 1) 优先：正向 WS 通道（NapCat 正向连接下 WS 同时支持事件+API 请求）
    if (this.connected && this.ws && this.ws.readyState === 1) {
      return new Promise((resolve, reject) => {
        const echo = `api-${++this._seq}`;
        const timer = setTimeout(() => {
          this._pending.delete(echo);
          reject(new Error(`${action} timeout (ws)`));
        }, timeout);
        this._pending.set(echo, {
          resolve: (data) => { clearTimeout(timer); resolve(data); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try {
          this.ws.send(JSON.stringify({ action, params, echo }));
        } catch (e) {
          clearTimeout(timer);
          this._pending.delete(echo);
          reject(new Error(`${action} ws send error: ${e.message}`));
        }
      });
    }
    // 2) 兜底：HTTP API（NapCat 需额外开启 HTTP 服务，通常 3000）
    return this._callHttp(action, params, timeout);
  }

  _callHttp(action, params, timeout) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(`${this.httpUrl}/api/${action}`); } catch (e) { return reject(new Error(`${action} http url invalid`)); }
      // 安全：仅允许 http/https 协议（防 file/gopher 等任意协议请求）
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return reject(new Error(`${action} http 协议不支持: ${url.protocol}`));
      }
      const body = JSON.stringify({ action, params, echo: `api-${++this._seq}` });
      const mod = url.protocol === "https:" ? require("https") : http;
      const req = mod.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        timeout,
      }, (res) => {
        let data = "";
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 2 * 1024 * 1024) { res.destroy(); reject(new Error(`${action} response too large`)); return; }
          data += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.status === "ok" || j.retcode === 0) resolve(j.data);
            else reject(new Error(j.message || `${action} failed`));
          } catch (e) { reject(new Error(`${action} bad response: ${data.slice(0, 200)}`)); }
        });
        res.on("error", (e) => reject(new Error(`${action} response error: ${e.message}`)));
      });
      req.on("error", (e) => reject(new Error(`${action} http error: ${e.message}`)));
      req.on("timeout", () => { req.destroy(); reject(new Error(`${action} timeout`)); });
      req.write(body);
      req.end();
    });
  }

  // 常用封装
  getSelfInfo() { return this.call("get_login_info"); }
  getGroupList() { return this.call("get_group_list"); }
  getGroupMemberList(gid) { return this.call("get_group_member_list", { group_id: Number(gid) }); }
  // 历史消息：大 count 拉取本地缓存较慢，放宽超时（NapCat 处理大群历史可能 20-40 秒）
  getGroupMsgHistory(gid, seq = 0, count = 20) {
    return this.call("get_group_msg_history", { group_id: Number(gid), message_seq: seq, count }, 45000);
  }
  getGroupAnnouncements(gid) {
    // NapCat 扩展 API：_get_group_notice（下划线前缀），标准 OneBot 11 无公告接口
    return this.call("_get_group_notice", { group_id: Number(gid) }).catch((e) => {
      L.debug("[onebot] _get_group_notice failed:", e.message);
      return null;
    });
  }
  // （已移除：sendGroupMsg / sendGroupForward —— 本软件只读，不提供任何发送能力）
  stop() {
    this._stopped = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    this.connected = false;
  }
}


// ---------- 反向 WS 服务端（NapCat 主动连入，自动重连） ----------
class ReverseOneBotServer {
  constructor(opts = {}) {
    this.port = opts.port || 3002;
    this.token = opts.token || "";
    this.wss = null;
    this.connected = false;
    this.selfId = null;
    this.listeners = new Set();
    this._seq = 0;
    this._pending = new Map();
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { for (const fn of this.listeners) { try { fn(evt); } catch (e) { L.error("[rev] listener error:", e.message); } } }

  start() {
    const WS = this._loadWS();
    if (!WS) { L.error("[rev] no ws module"); return; }
    const { WebSocketServer } = WS;
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws, req) => {
      // token 校验：解析 Bearer 头精确匹配，防子串绕过
      if (this.token) {
        const auth = String(req.headers.authorization || "");
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        const got = m ? m[1].trim() : "";
        if (got !== this.token) { ws.close(4001, "unauthorized"); return; }
      }
      L.info("[rev] NapCat connected");
      this.connected = true;
      this.emit({ type: "meta", subType: "connected" });
      ws.on("message", (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch (e) { return; }
        if (frame.post_type === "meta_event") {
          if (frame.meta_event_type === "heartbeat") { this.emit({ type: "meta", subType: "heartbeat", payload: frame }); return; }
          if (frame.meta_event_type === "lifecycle") { this.selfId = String(frame.self_id || ""); return; }
          return;
        }
        // 事件推送
        this.emit(frame);
      });
      ws.on("close", () => {
        this.connected = false;
        L.warn("[rev] NapCat disconnected");
        this.emit({ type: "meta", subType: "disconnected" });
      });
      ws.on("error", () => {});
    });
    this.wss.on("listening", () => L.info(`[rev] listening on ${this.port}`));
    this.wss.on("error", (e) => L.error("[rev] server error:", e.message));
    return this;
  }

  _loadWS() {
    try { return require("ws"); } catch (e) { return null; }
  }

  // 主动调用：反向模式不支持 HTTP 调用；即使未来支持，也只允许只读 action
  call(action, params = {}) {
    if (!isReadOnlyAction(action)) return readOnlyError(action);
    return Promise.reject(new Error("reverse mode: use forward WS or enable NapCat http server"));
  }

  stop() {
    if (this.wss) {
      try {
        for (const c of this.wss.clients) c.close();
        this.wss.close();
      } catch (e) {}
      this.wss = null;
    }
    this.connected = false;
  }
}

module.exports = { OneBotClient, ReverseOneBotServer, isReadOnlyAction };


