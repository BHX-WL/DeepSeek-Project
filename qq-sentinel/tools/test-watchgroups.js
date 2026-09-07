// tools/test-watchgroups.js — 指定群过滤验证（单元级，不依赖网络）
const path = require("path");
const os = require("os");
const fs = require("fs");

const testDir = path.join(os.tmpdir(), "qq-sentinel-wg-test");
fs.rmSync(testDir, { recursive: true, force: true });

const config = require("../core/config");
config.setDataDir(testDir);
const L = require("../core/logger");
L.init(path.join(testDir, "logs"));
const store = require("../core/store");
store.init(path.join(testDir, "store"));

const { Collector } = require("../core/collector");

const dummyClient = { onEvent() {} };
const collector = new Collector(dummyClient);

function fakeMsg(gid, user, text) {
  return {
    post_type: "message", message_type: "group",
    group_id: gid, user_id: user, message_id: Date.now() + Math.random(),
    time: Math.floor(Date.now() / 1000), sender: { nickname: "测试", card: "测试" },
    message: [{ type: "text", data: { text } }],
    raw_message: text,
  };
}

let ok = true;
const check = (name, cond) => { console.log((cond ? "✅" : "❌"), name); if (!cond) ok = false; };

(async () => {
  // 1) 指定 10001 → 只采集 10001
  config.set("watch.groups", ["10001"]);
  collector._onGroupMessage(fakeMsg(10001, 1, "群A消息"));
  collector._onGroupMessage(fakeMsg(20002, 2, "群B消息(应被忽略)"));
  collector._onGroupMessage(fakeMsg(10001, 3, "群A另一条"));
  check("指定[10001]：10001 采集 2 条", store.getMessages("10001", {}).length === 2);
  check("指定[10001]：20002 未采集", store.getMessages("20002", {}).length === 0);
  check("指定[10001]：20002 未入库", !store.listGroups().some((g) => g.groupId === "20002"));

  // 2) 改指定 20002 → 10001 停止采集
  config.set("watch.groups", ["20002"]);
  collector._onGroupMessage(fakeMsg(10001, 1, "群A第三条(应被忽略)"));
  collector._onGroupMessage(fakeMsg(20002, 2, "群B第一条"));
  check("改指定[20002]：10001 仍是 2 条", store.getMessages("10001", {}).length === 2);
  check("改指定[20002]：20002 采集 1 条", store.getMessages("20002", {}).length === 1);

  // 3) 清空 → 全部采集
  config.set("watch.groups", []);
  collector._onGroupMessage(fakeMsg(10001, 1, "群A第四条(全采)"));
  check("清空指定：10001 变 3 条", store.getMessages("10001", {}).length === 3);

  // 4) 撤回：按产品契约（2026 彻底忽略撤回）——被指定群内也一律不记录
  config.set("watch.groups", ["10001"]);
  collector._onNotice({ post_type: "notice", notice_type: "group_recall", group_id: 20002, time: Math.floor(Date.now()/1000), user_id: 1, operator_id: 2, message_id: 99 });
  check("非指定群 20002 无撤回事件", store.listEvents("20002").length === 0);
  collector._onNotice({ post_type: "notice", notice_type: "group_recall", group_id: 10001, time: Math.floor(Date.now()/1000), user_id: 1, operator_id: 2, message_id: 100 });
  check("指定群 10001：撤回被忽略（无事件）", !store.listEvents("10001").some((e) => e.kind === "recall"));

  console.log(ok ? "✅ WATCHGROUPS OK" : "❌ WATCHGROUPS FAIL");
  process.exit(ok ? 0 : 1);
})();