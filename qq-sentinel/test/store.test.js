// test/store.test.js — 存储层测试：gid 安全 / 消息追加读取 / 事件
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const store = require("../core/store");

let tmpDir;

describe("core/store", () => {
  before(() => {
    tmpDir = path.join(os.tmpdir(), "qq-sentinel-test-store-" + Date.now());
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.init(path.join(tmpDir, "store"));
  });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("safeGid 拒绝路径穿越（非法 gid 不写盘）", () => {
    const evil = "../../../etc/passwd";
    const r = store.appendMessage(evil, { text: "x" });
    assert.strictEqual(r, false);
    const ev = store.appendEvent(evil, { kind: "x" });
    assert.strictEqual(ev, false);
    // 无文件被创建（messages 目录下不应出现 passwd 等异常文件）
    const msgsDir = path.join(tmpDir, "store", "messages");
    const names = fs.readdirSync(msgsDir);
    assert.ok(!names.some((n) => /passwd|etc/i.test(n)), "路径穿越文件被创建: " + names.join(","));
  });

  it("appendMessage + getMessages 往返", () => {
    store.appendMessage("10001", { text: "你好", time: "2026-09-01T00:00:00Z" });
    store.appendMessage("10001", { text: "在吗", time: "2026-09-01T00:01:00Z" });
    const msgs = store.getMessages("10001", {});
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].text, "你好");
  });

  it("getMessages 时间过滤 since/until", () => {
    const msgs = store.getMessages("10001", { since: "2026-09-01T00:00:30Z", until: "2026-09-01T00:01:30Z" });
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, "在吗");
  });

  it("getMessages 非法 gid 返回空数组", () => {
    assert.deepStrictEqual(store.getMessages("../../x", {}), []);
    assert.deepStrictEqual(store.getMessages("", {}), []);
  });

  it("upsertGroup + listGroups + setWatched", () => {
    store.upsertGroup({ groupId: "10001", groupName: "测试群" });
    const gs = store.listGroups();
    assert.ok(gs.some((g) => g.groupId === "10001" && g.name === "测试群"));
    const g = store.setWatched("10001", false);
    assert.strictEqual(g.watched, false);
    assert.strictEqual(store.listGroups().find((x) => x.groupId === "10001").watched, false);
  });

  it("appendEvent + listEvents", () => {
    store.appendEvent("10001", { kind: "atall", title: "全员通知", time: new Date().toISOString() });
    const evs = store.listEvents("10001");
    assert.ok(evs.some((e) => e.kind === "atall"));
  });

  it("setLastSummary/getLastSummary", () => {
    store.setLastSummary("10001", "2026-09-01T00:00:00Z");
    assert.strictEqual(store.getLastSummary("10001"), "2026-09-01T00:00:00Z");
    store.setLastSummary("10001", null);
    assert.strictEqual(store.getLastSummary("10001"), null);
  });

  it("stats 汇总统计", () => {
    const st = store.stats();
    assert.ok(Array.isArray(st));
    const me = st.find((s) => s.groupId === "10001");
    assert.ok(me);
    assert.ok(me.messages >= 2);
  });

  it("appendKeywordHit + listKeywordHits（逐条存档）", () => {
    const rec = { word: "开黑", words: ["开黑"], text: "今晚开黑", time: "2026-09-02T00:00:00Z" };
    assert.strictEqual(store.appendKeywordHit("10001", rec), true);
    assert.strictEqual(store.appendKeywordHit("10001", { ...rec, text: "再来", time: "2026-09-02T00:01:00Z" }), true);
    const hits = store.listKeywordHits("10001");
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].text, "再来"); // 新的在前
    // 非法 gid 拒绝
    assert.strictEqual(store.appendKeywordHit("../../x", rec), false);
    assert.deepStrictEqual(store.listKeywordHits("../../x"), []);
  });
});
