// test/semantic.test.js — 本地语义摘要纯函数
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { cleanText, isBare, cos, kmeans } = require("../core/semantic");

describe("core/semantic 纯函数", () => {
  it("cleanText 去 CQ/@/链接并截断", () => {
    assert.strictEqual(cleanText("[CQ:image,file=x] 今晚  @群主  开会 https://a.b/c  呀"), "今晚 开会 呀");
    assert.ok(cleanText("x".repeat(300)).length <= 120);
  });
  it("isBare 纯图/表情判定", () => {
    assert.ok(isBare("[图片]"));
    assert.ok(isBare("[CQ:image,file=1]"));
    assert.ok(isBare(""));
    assert.ok(!isBare("[图片]今晚开会"));
    assert.ok(!isBare("大家好"));
  });
  it("cos 归一化相似度", () => {
    assert.ok(Math.abs(cos([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cos([1, 0], [0, 1])) < 1e-9);
  });
  it("kmeans 分离线性可分向量", () => {
    const vecs = [];
    for (let i = 0; i < 20; i++) vecs.push([1, 0, i / 50]);
    for (let i = 0; i < 20; i++) vecs.push([0, 1, i / 50]);
    const { assign } = kmeans(vecs, 2, 20);
    const a0 = assign[0], b0 = assign[20];
    assert.notStrictEqual(a0, b0, "两组应分到不同簇");
    let same0 = 0, same1 = 0;
    for (let i = 0; i < 20; i++) { if (assign[i] === a0) same0++; if (assign[20 + i] === b0) same1++; }
    assert.ok(same0 >= 15 && same1 >= 15, "组内一致性");
  });

const { prepareRows } = require("../core/semantic");

describe("core/semantic prepareRows", () => {
  it("按日分窗 + 忽略机器人/纯图 + 模板过滤", () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ text: "早安" + i, time: "2026-09-01T08:00:00Z", userId: "bot1", nickname: "机器人" }); // 机器人 → 忽略
    for (let i = 0; i < 10; i++) rows.push({ text: "今日猪猪", time: "2026-09-01T09:00:00Z", userId: "1", nickname: "A" }); // 模板(≥3) → 提示
    for (let i = 0; i < 6; i++) rows.push({ text: "[图片]", time: "2026-09-01T10:00:00Z", userId: "1", nickname: "A" }); // 纯图 → 忽略
    for (let i = 0; i < 12; i++) rows.push({ text: "讨论第" + i + "个问题可以吗", time: "2026-09-01T09:00:00Z", userId: "2", nickname: "B" });
    for (let i = 0; i < 10; i++) rows.push({ text: "第二日议题" + i + "号怎么样", time: "2026-09-02T09:00:00Z", userId: "2", nickname: "B" });
    const { windows, templates } = prepareRows(rows, { ignoreUins: ["bot1"], templateMin: 3 });
    // 机器人被忽略后不在窗内
    const flat = windows.flatMap((w) => w.items);
    assert.ok(!flat.some((r) => r.userId === "bot1"), "机器人应被忽略");
    assert.ok(!flat.some((r) => r.text === "[图片]"), "纯图应被忽略");
    assert.ok(!flat.some((r) => r.text === "今日猪猪"), "复读模板不应作代表句");
    assert.ok(templates.some((x) => x.text === "今日猪猪" && x.count === 10), "模板进入提示列表");
    // 窗口跨 09-01 / 09-02
    const days = windows.map((w) => w.day);
    assert.ok(days.includes("2026-09-01") && days.includes("2026-09-02"));
  });
  it("窗口少于 8 条不出窗", () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ text: "零星消息" + i, time: "2026-09-01T08:00:00Z", userId: "1" });
    const { windows } = prepareRows(rows, {});
    assert.strictEqual(windows.length, 0);
  });
});
});
