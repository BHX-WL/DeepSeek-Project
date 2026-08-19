// core/deepseek.js — DeepSeek chat completions 客户端（HTTPS，无 SDK 依赖）
const https = require("https");
const { URL } = require("url");
const L = require("./logger");
const config = require("./config");

function apiKey() {
  return config.get("deepseek.apiKey") || process.env.DEEPSEEK_API_KEY || "";
}

function chat(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = apiKey();
    if (!key) return reject(new Error("未配置 DeepSeek API Key（设置页填写或设置环境变量 DEEPSEEK_API_KEY）"));
    const base = config.get("deepseek.baseUrl") || "https://api.deepseek.com";
    const model = opts.model || config.get("deepseek.model") || "deepseek-chat";
    let url;
    try {
      url = new URL(`${base}/chat/completions`);
    } catch (e) { return reject(new Error(`API 地址无效: ${e.message}`)); }
    // 安全：仅允许 https（防 API Key 经明文/任意协议泄露；如用户确需 http 请显式配置且明确风险）
    if (url.protocol !== "https:") {
      return reject(new Error("API 地址必须为 https://（安全要求，防止密钥泄露）"));
    }
    const body = JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? 2000,
      stream: false,
    });
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: opts.timeout || 120000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) return reject(new Error(`DeepSeek error: ${j.error.message || JSON.stringify(j.error)}`));
          const text = j.choices?.[0]?.message?.content ?? "";
          resolve({ text, raw: j });
        } catch (e) { reject(new Error(`DeepSeek bad response: ${data.slice(0, 300)}`)); }
      });
    });
    req.on("error", (e) => reject(new Error(`DeepSeek request failed: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("DeepSeek timeout")); });
    req.write(body);
    req.end();
  });
}

module.exports = { chat, apiKey };
