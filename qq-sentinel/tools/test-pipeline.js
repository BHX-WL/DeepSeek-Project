// tools/test-pipeline.js — 无头集成测试：Mock OneBot → Collector → Store → Summarizer(mock)
const path = require("path");
const os = require("os");
const fs = require("fs");

const testDir = path.join(os.tmpdir(), "qq-sentinel-test");
fs.rmSync(testDir, { recursive: true, force: true });

const config = require("../core/config");
config.setDataDir(testDir);
const L = require("../core/logger");
L.init(path.join(testDir, "logs"));
const store = require("../core/store");
store.init(path.join(testDir, "store"));

const { OneBotClient } = require("../core/onebot");
const { Collector } = require("../core/collector");
const { Summarizer } = require("../core/summarizer");

// 用环境变量模拟 DeepSeek 响应（避免真实调用）
const ds = require("../core/deepseek");
const origChat = ds.chat;
ds.chat = async (messages) => ({
  text: `{"isConflict":true,"level":4,"reason":"双方情绪激烈对骂","summary":"小明与暴躁老哥发生激烈冲突"}`,
});

(async () => {
  // 先启动 mock server（子进程）
  const { spawn } = require("child_process");
  const mockProc = spawn(process.execPath, [path.join(__dirname, "mock-onebot.js")], { stdio: "ignore", detached: false });

  const client = new OneBotClient({ wsUrl: "ws://127.0.0.1:3001", httpUrl: "http://127.0.0.1:3000" });
  const collector = new Collector(client);
  const summarizer = new Summarizer(client, collector);
  collector.attach();

  let conflictSeen = false;
  summarizer.judgeConflict = async (gid, win) => {
    conflictSeen = true;
    const record = { kind: "conflict", groupId: gid, title: "冲突", summary: "测试冲突", time: new Date().toISOString() };
    store.appendEvent(gid, record);
    return record;
  };

  await new Promise((resolve) => setTimeout(resolve, 1000));
  client.connect();

  await new Promise((resolve) => setTimeout(resolve, 22000));

  // 公告轮询（主进程 bootstrap 路径）
  const annAdded = await collector.refreshAnnouncements("10001");
  console.log("公告轮询新增:", annAdded);

  const groups = store.listGroups();
  const msgs = store.getMessages("10001", {});
  const events = store.listEvents("10001");

  console.log("=== 测试结果 ===");
  console.log("群数:", groups.length, groups.map((g) => `${g.name}(${g.groupId})`).join(","));
  console.log("消息数:", msgs.length);
  const atAll = msgs.filter((m) => m.atAll);
  console.log("@全体消息:", atAll.length, atAll.map((m) => m.text).join(" | "));
  console.log("事件数:", events.length, events.map((e) => `${e.kind}:${e.title}`).join(" | "));
  console.log("公告数:", annAdded, "(新增)");
  console.log("冲突检测触发:", conflictSeen);

  client.stop();
  mockProc.kill();
  const ok = groups.length >= 1 && msgs.length >= 4 && atAll.length >= 1 && annAdded >= 1 && conflictSeen;
  console.log(ok ? "✅ PIPELINE OK" : "❌ PIPELINE FAIL");
  process.exit(ok ? 0 : 1);
})();



