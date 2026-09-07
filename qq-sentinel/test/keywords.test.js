// test/keywords.test.js — 关键词匹配纯函数
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { normalizeKeywords, matchKeywords } = require("../core/keywords");

describe("core/keywords", () => {
  it("normalizeKeywords 数组/字符串/去空去重", () => {
    assert.deepStrictEqual(normalizeKeywords([" 开黑 ", "", "开黑", "  "]), ["开黑"]);
    assert.deepStrictEqual(normalizeKeywords("a,b\nc，d"), ["a", "b", "c", "d"]);
    assert.deepStrictEqual(normalizeKeywords([]), []);
    assert.deepStrictEqual(normalizeKeywords(null), []);
  });
  it("matchKeywords 包含匹配（忽略大小写）", () => {
    assert.deepStrictEqual(matchKeywords("今晚一起开黑吗", ["开黑"]), ["开黑"]);
    assert.deepStrictEqual(matchKeywords("HELLO world", ["hello"]), ["hello"]); // 英文忽略大小写
    assert.deepStrictEqual(matchKeywords("晚上好", ["开黑", "晚安"]), []);
  });
  it("多词任一命中，返回全部命中词", () => {
    assert.deepStrictEqual(matchKeywords("有开黑群吗 顺便晚安", ["开黑", "晚安"]), ["开黑", "晚安"]);
  });
  it("空文本/空词表返回空", () => {
    assert.deepStrictEqual(matchKeywords("", ["x"]), []);
    assert.deepStrictEqual(matchKeywords("x", []), []);
    assert.deepStrictEqual(matchKeywords("x", null), []);
  });
});
const { keywordStats } = require("../core/keywords");

describe("core/keywords keywordStats", () => {
  it("按词统计次数/首末时间/样本", () => {
    const hits = [
      { words: ["开黑"], text: "今晚开黑", time: "2026-09-02T00:00:00Z" },
      { words: ["开黑", "内测"], text: "开黑顺便内测", time: "2026-09-02T00:01:00Z" },
      { words: ["开黑"], text: "再来", time: "2026-09-02T00:02:00Z" },
    ];
    const st = keywordStats(hits);
    const kai = st.find((x) => x.word === "开黑");
    assert.strictEqual(kai.count, 3);
    assert.strictEqual(kai.first, "2026-09-02T00:00:00Z");
    assert.strictEqual(kai.last, "2026-09-02T00:02:00Z");
    assert.strictEqual(kai.sample, "今晚开黑");
    const ce = st.find((x) => x.word === "内测");
    assert.strictEqual(ce.count, 1);
  });
  it("空数据返回空数组", () => {
    assert.deepStrictEqual(keywordStats([]), []);
    assert.deepStrictEqual(keywordStats(null), []);
  });
});
