// test/summarizer.e2e.test.js — 无网络 summarize 全链路 dry 测试（守护 summarizer+semantic+关键词节）
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const config = require("../core/config");
const store = require("../core/store");
const { Summarizer } = require("../core/summarizer");

let tmpDir;

describe("summarize 全链路（dry, 无网络）", () => {
  before(() => {
    tmpDir = path.join(os.tmpdir(), "qq-e2e-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    config.setDataDir(tmpDir);
    config.set("summarize.mode", "local");
    config.set("summarize.burstEnabled", false);
    config.set("hotspots.enabled", false);
    config.set("watch.keywords", ["开黑"]);
    store.init(path.join(tmpDir, "store"));
    // 造 14 条消息（同一话题，确保聚类有意义）+ 2 条关键词命中
    for (let i = 0; i < 14; i++) {
      const t = new Date("2026-09-08T0" + (i % 8) + ":00:00Z").toISOString();
      store.appendMessage("10001", { text: "讨论第" + i + "条 内测版本周上" + (i % 5 === 0 ? " 今晚开黑" : ""), time: t, userId: "2", nickname: "B" });
    }
    for (let i = 0; i < 2; i++) {
      store.appendKeywordHit("10001", { words: ["开黑"], text: "今晚开黑" + i, time: "2026-09-08T0" + i + ":00:00Z" });
    }
  });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it("local 档：semantic(有模型)或统计兜底，报告完整且含关键词命中小节", async () => {
    const s = new Summarizer({}, {});
    const r = await s.summarizeGroup("10001", { mode: "period", since: "2026-09-08T00:00:00Z", until: "2026-09-08T23:59:59Z" });
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert.ok(["semantic", "local"].includes(r.engine), "engine=" + r.engine);
    assert.ok(r.summary && r.summary.length > 20, "报告不能为空");
    assert.ok(r.summary.includes("关键词命中"), "应含关键词命中小节");
    if (r.engine === "semantic") {
      assert.ok(/话题/.test(r.summary), "semantic 报告应含话题行");
    }
  }, 60000);
});