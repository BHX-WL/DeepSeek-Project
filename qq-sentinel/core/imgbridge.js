// core/imgbridge.js — 全家桶互调：拉群图 + 调用 imgocr 本地 OCR 服务
// 只读：只拉取图片（get_image 经 NapCat 内核下载）并调用本地 OCR，不做任何 QQ 写操作。
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const L = require("./logger");

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";
const MAX_IMAGES = 50;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

// ---------- 拉取群内最近图片（NapCat 魔改 token 通道，同 imgocr） ----------
async function fetchGroupImages(client, gid, limit) {
  const pg = Math.max(1, Math.min(MAX_IMAGES, Number(limit) || 10));
  let messages = null;
  // 小 count 阶梯：NapCat 对 count≥100 可能挂起，≤50 秒回
  for (const cnt of [50, 20, 10]) {
    try {
      const tmo = cnt === 50 ? 20000 : cnt === 20 ? 15000 : 10000;
      const data = await client.call("get_group_msg_history", { group_id: Number(gid), message_seq: 0, count: cnt }, tmo);
      const cand = Array.isArray(data) ? data : (data && data.messages) || [];
      if (Array.isArray(cand) && cand.length > 0) { messages = cand; break; }
      if (Array.isArray(cand)) break;
    } catch (e) {
      const msg = String((e && e.message) || "");
      if (/消息0不存在|not exist|不存在/.test(msg)) break;
      L.warn(`[imgbridge] 群 ${gid} count=${cnt} 失败:`, msg);
    }
  }
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < pg; i--) {
    const m = messages[i];
    const segs = Array.isArray(m && m.message) ? m.message : [];
    for (const seg of segs) {
      if (!seg || seg.type !== "image" || !seg.data) continue;
      const file = String(seg.data.file || "");
      const token = String(seg.data.token || "");
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, token, msgId: String(m.message_id || ""), time: Number(m.time || 0) });
      if (out.length >= pg) break;
    }
  }
  return out;
}

// 用 token 经 NapCat get_image 拿本地路径，并复制到自己的缓存目录
async function materializeImage(client, image, gid, cacheDir) {
  // 纵深防御：gid 只允许纯数字，防路径穿越
  if (!/^\d{1,20}$/.test(String(gid))) return null;
  if (!image || !image.token) return null;
  try {
    const r = await client.call("get_image", { file: image.token }, 90000);
    const src = r && typeof r.file === "string" ? r.file : null;
    if (!src || !fs.existsSync(src)) return null;
    const st = fs.statSync(src);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
    const dir = path.join(cacheDir, String(gid));
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(image.file).toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ".jpg";
    const hash = crypto.createHash("sha1").update(image.file + ":" + (image.msgId || "")).digest("hex").slice(0, 24);
    const dest = path.join(dir, hash + safeExt);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    fs.copyFileSync(src, dest);
    return dest;
  } catch (e) {
    L.warn(`[imgbridge] get_image 失败:`, e.message);
    return null;
  }
}

// ---------- 调用 imgocr 本地 OCR 服务 ----------
function _request(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error("URL 非法")); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("仅支持 http/https"));
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost" && u.hostname !== "::1") {
      return reject(new Error("OCR 服务仅限本机"));
    }
    const payload = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8") : null;
    const req = http.request(u, {
      method,
      headers: Object.assign({}, headers, payload ? { "Content-Length": payload.length } : {}),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 4 * 1024 * 1024) { req.destroy(new Error("响应过大")); return; } chunks.push(c); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch { reject(new Error("响应解析失败: " + text.slice(0, 120))); }
      });
    });
    req.on("error", (e) => reject(e));
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function bridgeHealth(bridgeUrl) {
  const url = String(bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/$/, "") + "/api/health";
  try {
    const r = await _request(url, "GET", {}, null, 8000);
    return { ok: r.status === 200 && r.json && r.json.ok, status: r.status, info: r.json || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ocrViaBridge(filePath, bridgeUrl, token, timeoutMs) {
  const url = String(bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/$/, "") + "/api/ocr";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Bridge-Token"] = token;
  const r = await _request(url, "POST", headers, { path: filePath, langs: ["eng", "chi_sim"] }, timeoutMs || 120000);
  if (r.status !== 200 || !r.json) throw new Error("OCR 服务返回 " + r.status + ": " + JSON.stringify(r.json || {}).slice(0, 150));
  if (!r.json.ok) throw new Error(String(r.json.error || "OCR 失败"));
  return r.json;
}

// 读取 imgocr 的桥令牌（%APPDATA%\imgocr\bridge-token.txt）——全家桶自动互认
function readImgocrToken() {
  try {
    const f = path.join(process.env.APPDATA || "", "imgocr", "bridge-token.txt");
    if (fs.existsSync(f)) {
      const t = fs.readFileSync(f, "utf8").trim();
      if (/^[A-Za-z0-9]{16,64}$/.test(t)) return t;
    }
  } catch {}
  return "";
}

module.exports = { fetchGroupImages, materializeImage, bridgeHealth, ocrViaBridge, readImgocrToken, DEFAULT_BRIDGE_URL };