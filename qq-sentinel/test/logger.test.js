// test/logger.test.js — 日志脱敏/轮转测试
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const logger = require("../core/logger");

let tmpDir;
let logFile;

describe("core/logger", () => {
  before(() => {
    tmpDir = path.join(os.tmpdir(), "qq-sentinel-test-log-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    logger.init(tmpDir);
    logFile = path.join(tmpDir, "sentinel.log");
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("init 创建日志文件目录", () => {
    assert.ok(fs.existsSync(tmpDir));
  });

  it("write 落盘并包含时间戳/级别", async () => {
    logger.info("hello test");
    await new Promise((r) => setTimeout(r, 50)); // 等异步 flush
    const text = fs.readFileSync(logFile, "utf8");
    assert.ok(text.includes("hello test"));
    assert.ok(text.includes("[INFO]"));
    assert.ok(/\[\d{4}-\d{2}-\d{2}T/.test(text));
  });

  it("API key 脱敏（sk- 前缀）", async () => {
    logger.info("using sk-abcdef1234567890xyz token");
    await new Promise((r) => setTimeout(r, 50));
    const text = fs.readFileSync(logFile, "utf8");
    assert.ok(!text.includes("sk-abcdef1234567890xyz"));
    assert.ok(text.includes("sk-***"));
  });

  it("token: 形式脱敏", async () => {
    logger.warn('token: "super-secret-token-123"');
    await new Promise((r) => setTimeout(r, 50));
    const text = fs.readFileSync(logFile, "utf8");
    assert.ok(!text.includes("super-secret-token-123"));
  });

  it("Authorization Bearer 脱敏（不泄漏 payload）", async () => {
    logger.error("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    await new Promise((r) => setTimeout(r, 50));
    const text = fs.readFileSync(logFile, "utf8");
    assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9.payload.sig"), "payload 泄漏");
    assert.ok(!text.includes("payload.sig"), "签名泄漏");
  });
});
