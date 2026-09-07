// test/ollama.test.js — Ollama 客户端纯函数测试（不触网）
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { normalizeUrl, buildChatBody } = require("../core/ollama");

describe("core/ollama 纯函数", () => {
  it("normalizeUrl 接受 http/https", () => {
    assert.strictEqual(normalizeUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
    assert.ok(normalizeUrl("https://ollama.example.com/v1").startsWith("https://"));
  });

  it("normalizeUrl 拒绝非法协议与带凭据 URL", () => {
    assert.strictEqual(normalizeUrl("ftp://x/y"), null);
    assert.strictEqual(normalizeUrl("file:///etc/passwd"), null);
    assert.strictEqual(normalizeUrl("ws://x"), null);
    assert.strictEqual(normalizeUrl("http://user:pass@host:11434"), null);
    assert.strictEqual(normalizeUrl("not a url"), null);
    assert.strictEqual(normalizeUrl(""), null);
  });

  it("normalizeUrl 去尾部斜杠", () => {
    assert.strictEqual(normalizeUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  });

  it("buildChatBody 组装 OpenAI 兼容请求体", () => {
    const body = buildChatBody([{ role: "user", content: "hi" }], { model: "qwen2.5:7b", temperature: 0.1, max_tokens: 500 });
    assert.deepStrictEqual(body.model, "qwen2.5:7b");
    assert.strictEqual(body.temperature, 0.1);
    assert.strictEqual(body.max_tokens, 500);
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.messages[0].role, "user");
  });

  it("buildChatBody 默认温度/长度", () => {
    const body = buildChatBody([], {});
    assert.strictEqual(body.temperature, 0.3);
    assert.strictEqual(body.max_tokens, 2000);
  });
});
