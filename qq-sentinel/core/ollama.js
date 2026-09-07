// core/ollama.js — Ollama 本地 LLM 客户端（OpenAI 兼容 /chat/completions；无 SDK 依赖）
// 用途：无 DeepSeek API Key 时，用本地 Ollama 做 AI 汇总/冲突判定（数据不出本机）。
// 安全性：仅允许 http/https（默认本机 http://127.0.0.1:11434）；超时经 AbortController 强制终止。
"use strict";
const config = require("./config");

function settings() {
  const o = config.get("ollama") || {};
  return {
    enabled: o.enabled !== false,
    url: String(o.url || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: String(o.model || "qwen2.5:7b").trim(),
    timeoutMs: (Number(o.timeoutSec) || 180) * 1000,
  };
}

// URL 白名单：只允许 http/https，且拒绝用户信息（user:pass@）与任意主机风险交由用户负责
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString().replace(/\/+$/, "");
  } catch (e) { return null; }
}

// 纯函数：组装 /chat/completions 请求体（便于单测）
function buildChatBody(messages, opts = {}) {
  return {
    model: opts.model || "qwen2.5:7b",
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 2000,
    stream: false,
  };
}

// 调用本地 Ollama（OpenAI 兼容端点）。resolve {text, raw}；网络/协议/模型错误 reject。
async function chat(messages, opts = {}) {
  const s = settings();
  const model = opts.model || s.model;
  const base = normalizeUrl(opts.url || s.url);
  if (!base) return Promise.reject(new Error("Ollama 地址无效（仅支持 http/https）: " + (opts.url || s.url)));
  if (!model) return Promise.reject(new Error("未配置 Ollama 模型"));
  if (s.enabled === false && !opts.force) return Promise.reject(new Error("Ollama 已停用"));
  const url = base + "/chat/completions";
  const body = buildChatBody(messages, { model, temperature: opts.temperature, max_tokens: opts.max_tokens });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || s.timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch (e) {}
      return Promise.reject(new Error(`Ollama HTTP ${resp.status}: ${detail || resp.statusText}`));
    }
    const j = await resp.json();
    const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "");
    if (!text) return Promise.reject(new Error("Ollama 返回空内容"));
    return { text, raw: j };
  } catch (e) {
    if (e && e.name === "AbortError") return Promise.reject(new Error("Ollama 超时"));
    return Promise.reject(new Error("Ollama 请求失败: " + (e && e.message ? e.message : String(e))));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, settings, normalizeUrl, buildChatBody };
