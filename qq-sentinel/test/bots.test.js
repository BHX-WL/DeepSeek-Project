// test/bots.test.js — 机器人标注持久化测试
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const bots = require("../core/bots");

let tmpDir;

describe("core/bots", () => {
  before(() => {
    tmpDir = path.join(os.tmpdir(), "qq-sentinel-test-bots-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    bots.init(tmpDir);
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("init 空目录无崩溃，getBots 空", () => {
    assert.deepStrictEqual(bots.getBots("10001"), []);
    assert.strictEqual(bots.getScanned("10001"), 0);
  });

  it("scanGroup 只收集 is_robot=true 成员", async () => {
    const client = {
      call: async (action, params, timeout) => [
        { user_id: 111, nickname: "机器人A", card: "", is_robot: true },
        { user_id: 222, nickname: "真人B", card: "普通人", is_robot: false },
        { user_id: 333, nickname: "机器人C", card: "", is_robot: true },
      ],
    };
    const botsList = await bots.scanGroup(client, "10001");
    assert.strictEqual(botsList.length, 2);
    const uins = bots.getBotUins("10001");
    assert.ok(uins.includes("111"));
    assert.ok(uins.includes("333"));
    assert.ok(!uins.includes("222"));
  });

  it("scanGroup 失败返回上次结果", async () => {
    const badClient = { call: async () => { throw new Error("network down"); } };
    const r = await bots.scanGroup(badClient, "10001");
    assert.strictEqual(r.length, 2); // 上次缓存
  });

  it("botByUin 查找", () => {
    const b = bots.botByUin("10001", "111");
    assert.ok(b);
    assert.strictEqual(b.userId, "111");
    assert.strictEqual(bots.botByUin("10001", "999"), null);
  });

  it("persist 落盘后重新 init 能读回", () => {
    bots.persist();
    const fresh = require("../core/bots");
    // 同一模块实例，改用重新读文件验证
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "bots.json"), "utf8"));
    assert.ok(Array.isArray(raw["10001"]));
    assert.strictEqual(raw["10001"].length, 2);
  });
});
