// test/export-report.test.js — 报告导出纯函数
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { buildReportMarkdown, buildReportJson } = require("../core/export-report");

const base = {
  gid: "10001", groupName: "测试群",
  since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z",
  events: [
    { kind: "summary", title: "周报", summary: "本周无大事", engine: "local", time: "2026-09-01T12:00:00Z" },
    { kind: "conflict", title: "冲突", summary: "激烈争执", time: "2026-09-01T18:00:00Z" },
    { kind: "chat", title: "闲聊", text: "不应出现在报告中", time: "2026-09-01T09:00:00Z" },
  ],
  msgs: [
    { time: "2026-09-01T10:00:00Z", nickname: "小明", text: "大家好", atAll: false },
    { time: "2026-09-01T11:00:00Z", nickname: "群主", text: "今晚开会", atAll: true, images: 0 },
  ],
};

describe("core/export-report", () => {
  it("Markdown 含标题/统计/仅白名单事件", () => {
    const md = buildReportMarkdown(base);
    assert.ok(md.includes("# QQ 群大事报告 — 测试群（10001）"));
    assert.ok(md.includes("消息总数：2"));
    assert.ok(md.includes("[summary] 周报"));
    assert.ok(md.includes("[conflict] 冲突"));
    assert.ok(!md.includes("不应出现在报告中"), "非白名单事件不得入报告");
    assert.ok(md.includes("今晚开会 [@全体]"));
  });

  it("JSON 结构化且过滤非白名单事件", () => {
    const j = buildReportJson(base);
    assert.strictEqual(j.gid, "10001");
    assert.strictEqual(j.events.length, 2);
    assert.strictEqual(j.messageCount, 2);
    assert.strictEqual(j.messageSample[1].atAll, true);
    assert.ok(!j.events.some((e) => e.kind === "chat"));
  });

  it("空数据安全降级", () => {
    const md = buildReportMarkdown({ gid: "1", events: [], msgs: [] });
    assert.ok(md.includes("（该时段无大事/汇总记录）"));
    assert.ok(md.includes("（无消息样本）"));
    const j = buildReportJson({ gid: "1", events: null, msgs: null });
    assert.strictEqual(j.events.length, 0);
    assert.strictEqual(j.messageCount, 0);
  });
});
