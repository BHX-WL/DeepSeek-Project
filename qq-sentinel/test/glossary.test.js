// test/glossary.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { parseGlossaryText, matchGlossary } = require("../core/glossary");

describe("core/glossary", () => {
  it("parseGlossaryText 行式解析/去重", () => {
    const list = parseGlossaryText("猪猪=群内互称\n四代目=群主继任者，猪猪=重复");
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].word, "猪猪");
    assert.strictEqual(list[1].meaning, "群主继任者");
  });
  it("忽略无= 或空行", () => {
    const list = parseGlossaryText("随便聊聊\n\n只有词=");
    assert.strictEqual(list.length, 0);
  });
  it("matchGlossary 命中包含词的消息", () => {
    const list = [{ word: "猪猪", meaning: "群内互称" }];
    assert.deepStrictEqual(matchGlossary("今天猪猪好开心", list), [{ word: "猪猪", meaning: "群内互称" }]);
    assert.strictEqual(matchGlossary("今天天气不错", list).length, 0);
  });
});
