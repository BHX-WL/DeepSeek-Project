// test/config.test.js — 配置读写单元测试
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 模块级单例（大多数测试用它）
const config = require("../core/config");

// config 模块有 _cfg 缓存（单例），外部改文件后需换新实例才能重读
function freshConfig() {
  const mod = require.resolve("../core/config");
  delete require.cache[mod];
  return require("../core/config");
}

let tmpDir;

describe("core/config", () => {
  before(() => {
    tmpDir = path.join(os.tmpdir(), "qq-sentinel-test-config-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    config.setDataDir(tmpDir);
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("DEFAULTS 结构完整", () => {
    const d = config.DEFAULTS;
    assert.ok(d.napcat, "缺少 napcat");
    assert.ok(d.watch, "缺少 watch");
    assert.ok(d.summarize, "缺少 summarize");
    assert.ok(d.hotspots, "缺少 hotspots");
    assert.ok(d.deepseek, "缺少 deepseek");
    assert.ok(d.ocr, "缺少 ocr");
    assert.ok(d.ui, "缺少 ui");
    assert.strictEqual(d.napcat.mode, "forward");
    assert.strictEqual(d.summarize.dailyHour, 22);
    assert.strictEqual(d.deepseek.baseUrl, "https://api.deepseek.com");
  });

  it("load() 返回默认值（无配置文件）", () => {
    const cfg = config.load();
    assert.ok(cfg);
    assert.strictEqual(cfg.napcat.wsUrl, "ws://127.0.0.1:3001");
    assert.deepStrictEqual(cfg.watch.groups, []);
  });

  it("get() 支持点号路径", () => {
    assert.strictEqual(config.get("napcat.mode"), "forward");
    assert.strictEqual(config.get("summarize.dailyHour"), 22);
    assert.strictEqual(config.get("deepseek.apiKey"), "");
  });

  it("set() 写入并持久化到文件", () => {
    config.set("deepseek.apiKey", "sk-test-key");
    assert.strictEqual(config.get("deepseek.apiKey"), "sk-test-key");
    const raw = fs.readFileSync(path.join(tmpDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.deepseek.apiKey, "sk-test-key");
  });

  it("set() 拒绝原型污染 key", () => {
    config.set("__proto__.polluted", true);
    assert.strictEqual(config.get("polluted"), undefined);
    config.set("constructor.prototype.polluted", true);
    assert.strictEqual(config.get("polluted"), undefined);
  });

  it("load() 合并保存值与默认值（新实例重读文件）", () => {
    const c = freshConfig();
    c.setDataDir(tmpDir);
    const partial = JSON.stringify({ napcat: { wsUrl: "ws://custom:3001" } });
    fs.writeFileSync(path.join(tmpDir, "config.json"), partial, "utf8");
    const loaded = c.load();
    assert.strictEqual(loaded.napcat.wsUrl, "ws://custom:3001");
    assert.strictEqual(loaded.napcat.mode, "forward");
    assert.strictEqual(loaded.watch.groups.length, 0);
    assert.strictEqual(loaded.deepseek.model, "deepseek-chat");
  });

  it("损坏的配置文件优雅降级为默认值", () => {
    const c = freshConfig();
    c.setDataDir(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "config.json"), "{ not valid json !!!", "utf8");
    const loaded = c.load();
    assert.ok(loaded);
    assert.strictEqual(loaded.napcat.mode, "forward");
    assert.strictEqual(loaded.watch.groups.length, 0);
  });

  it("set() 创建中间对象路径", () => {
    config.set("custom.nested.deep.value", 42);
    assert.strictEqual(config.get("custom.nested.deep.value"), 42);
  });

  it("set() 空路径返回原值", () => {
    const r = config.set("", 99);
    assert.strictEqual(r, 99);
  });
  // ---------- v2 加固特性 ----------

  it("SCHEMA 导出完整", () => {
    const s = config.SCHEMA;
    assert.ok(s["napcat.mode"], "缺 napcat.mode");
    assert.ok(s["summarize.dailyHour"], "缺 dailyHour");
    assert.ok(s["ui.theme"], "缺 ui.theme");
  });

  it("sanitizeCfg 钳制越界整数", () => {
    const bad = { napcat: { mode: "forward" }, summarize: { dailyHour: 99, burstMult: 0.5, conflictMessageMin: 0 }, ui: { theme: "neon" } };
    const cfg = config.deepMerge(config.DEFAULTS, bad);
    const fixed = config.sanitizeCfg(cfg);
    assert.ok(fixed.length >= 3, "应报告越界: " + fixed.join(","));
    assert.strictEqual(cfg.summarize.dailyHour, 23);       // 钳到上限
    assert.strictEqual(cfg.summarize.burstMult, 1);        // 钳到下限
    assert.strictEqual(cfg.summarize.conflictMessageMin, 1);
    assert.strictEqual(cfg.ui.theme, "auto");              // 非法枚举回退默认
  });

  it("set() 越界值被钳制后持久化", () => {
    config.set("summarize.dailyHour", 42);
    assert.strictEqual(config.get("summarize.dailyHour"), 23);
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    assert.strictEqual(raw.summarize.dailyHour, 23);
  });

  it("deepMerge 拒绝原型污染键", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const out = config.deepMerge(config.DEFAULTS, evil);
    assert.strictEqual(out.polluted, undefined);
    assert.strictEqual({}.polluted, undefined); // 未污染全局
    assert.strictEqual(out.ok, 1);
  });

  it("reload() 热读外部修改（不换实例）", () => {
    // 模块级实例已缓存；用 freshConfig 验证 reload 能重读
    const c = freshConfig();
    c.setDataDir(tmpDir);
    c.set("napcat.wsUrl", "ws://a:1");
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ napcat: { wsUrl: "ws://edited:9" } }), "utf8");
    const before = c.get("napcat.wsUrl");
    assert.strictEqual(before, "ws://a:1");   // 缓存旧值
    c.reload();
    assert.strictEqual(c.get("napcat.wsUrl"), "ws://edited:9"); // reload 后新值
  });

  it("save() 前自动备份 .bak", () => {
    config.set("napcat.wsUrl", "ws://first:1");
    const bak = path.join(tmpDir, "config.json.bak");
    assert.ok(fs.existsSync(bak), "应生成 .bak");
    // 备份内容是上一次可用（即首次保存前的状态）
    const bakRaw = JSON.parse(fs.readFileSync(bak, "utf8"));
    assert.ok(bakRaw);
  });

});
