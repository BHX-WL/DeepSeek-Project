// test/onebot.test.js — 只读护栏测试（写操作拒绝，只读放行）
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { OneBotClient, ReverseOneBotServer, isReadOnlyAction } = require("../core/onebot");

const WRITES = ["send_group_msg", "send_group_forward_msg", "set_group_name", "delete_msg",
  "kick_group_member", "set_group_ban", "send_private_msg", "set_essence_msg", "handle_group_request",
  "send_msg", "set_group_whole_ban", "set_friend_add_request", "send_group_notice"];

const READS = ["get_login_info", "get_group_list", "get_group_member_list", "get_group_msg_history",
  "_get_group_notice", "get_friend_list", "get_msg", "get_group_info", "get_status", "get_version_info"];

describe("core/onebot 只读护栏", () => {
  it("写操作全部 isReadOnlyAction=false", () => {
    for (const a of WRITES) assert.strictEqual(isReadOnlyAction(a), false, a + " 应为写操作");
  });

  it("只读操作全部 isReadOnlyAction=true", () => {
    for (const a of READS) assert.strictEqual(isReadOnlyAction(a), true, a + " 应为只读操作");
  });

  it("get_ 前缀自动判定为只读", () => {
    assert.ok(isReadOnlyAction("get_some_new_api"));
    assert.ok(isReadOnlyAction("_get_private_api"));
    assert.ok(!isReadOnlyAction("send_private_msg"));
    assert.ok(!isReadOnlyAction("set_group_ban"));
  });

  it("空/非字符串返回 false", () => {
    assert.strictEqual(isReadOnlyAction(""), false);
    assert.strictEqual(isReadOnlyAction(null), false);
    assert.strictEqual(isReadOnlyAction(undefined), false);
  });

  it("call 写操作被拒（不触网）", async () => {
    const c = new OneBotClient({ wsUrl: "ws://127.0.0.1:1" });
    for (const a of WRITES) {
      await assert.rejects(c.call(a, {}), /只读模式/);
    }
  });

  it("reverse server call 也拒绝写操作", async () => {
    const s = new ReverseOneBotServer({ port: 0 });
    await assert.rejects(s.call("send_group_msg", {}), /只读模式/);
  });
});
// ---------- 重连韧性（v2） ----------
class FakeWS {
  constructor(url, opts) { this.url = url; this.opts = opts; this._h = {}; this.readyState = 0; FakeWS.instances.push(this); }
  on(ev, fn) { this._h[ev] = fn; return this; }
  fire(ev, arg) { if (this._h[ev]) this._h[ev](arg); }
  close() { this.fire("close"); }
  send() { throw new Error("not connected"); }
}
FakeWS.instances = [];

// 每用例建新 client，返回 { c, ws }（ws = 该 client 自己刚创建的那个 socket）
function connectOne() {
  const c = new OneBotClient({ wsUrl: "ws://127.0.0.1:1" });
  c._loadWS = () => FakeWS;
  const before = FakeWS.instances.length;
  c.connect();
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  return { c, ws };
}
function cleanup(c) {
  if (c._reconnectTimer) { clearTimeout(c._reconnectTimer); c._reconnectTimer = null; }
  c.stop();
}

describe("onebot 重连韧性", () => {
  it("constructor 初始化 attempts/connecting", () => {
    const x = new OneBotClient();
    assert.strictEqual(x.reconnectAttempts, 0);
    assert.strictEqual(x._connecting, false);
  });

  it("connect 防重入：连接中重复调用不新建 WS", () => {
    const { c } = connectOne();
    assert.strictEqual(c._connecting, true);
    const n1 = FakeWS.instances.length;
    c.connect();
    assert.strictEqual(FakeWS.instances.length, n1, "重复 connect 不应新建 WS");
    cleanup(c);
  });

  it("open 后 attempts 复位且不再 connecting", () => {
    const { c, ws } = connectOne();
    ws.fire("open");
    assert.strictEqual(c.connected, true);
    assert.strictEqual(c._connecting, false);
    assert.strictEqual(c.reconnectAttempts, 0);
    cleanup(c);
  });

  it("close 触发指数退避重连并 emit reconnecting", () => {
    const { c, ws } = connectOne();
    const metas = [];
    c.onEvent((e) => { if (e.type === "meta") metas.push(e); });
    ws.fire("open");
    ws.fire("close");
    assert.strictEqual(c.connected, false);
    assert.strictEqual(c.reconnectAttempts, 1);
    const rc = metas.find((m) => m.subType === "reconnecting");
    assert.ok(rc, "应 emit reconnecting");
    assert.strictEqual(rc.attempt, 1);
    assert.ok(rc.delay >= 2400 && rc.delay <= 4200, "delay=" + rc.delay);
    assert.ok(c._reconnectTimer, "应已安排重连定时器");
    cleanup(c);
  });

  it("退避封顶：多次断线延迟上限 ≈30s", () => {
    const { c, ws } = connectOne();
    ws.fire("open");
    let lastDelay = 0;
    for (let i = 0; i < 8; i++) {
      ws.fire("close"); // 同一 socket 重复触发 close → 每次进入 schedule
      if (c._reconnectTimer) { clearTimeout(c._reconnectTimer); c._reconnectTimer = null; }
      c._connecting = false;
      lastDelay = Math.min(3000 * Math.pow(1.6, c.reconnectAttempts - 1), 30000);
    }
    assert.ok(c.reconnectAttempts >= 6, "attempts=" + c.reconnectAttempts);
    assert.ok(lastDelay >= 24000 && lastDelay <= 30000, "上限应≈30s, got " + lastDelay);
    cleanup(c);
  });

  it("stop 后不再重连", () => {
    const { c } = connectOne();
    c.stop();
    const before = c.reconnectAttempts;
    c._scheduleReconnect();
    assert.strictEqual(c.reconnectAttempts, before);
    assert.strictEqual(c._reconnectTimer, null);
  });
});
// ---------- 降风险：风控信号 / 节流 / 退避 ----------
describe("onebot 降风险机制", () => {
  it("风控文案命中 → riskHold + emit risk", async () => {
    const { OneBotClient } = require("../core/onebot");
    const c = new OneBotClient({ wsUrl: "ws://127.0.0.1:1", apiMinIntervalMs: 0 });
    const metas = [];
    c.onEvent((e) => { if (e.type === "meta") metas.push(e); });
    c._noteFailure("get_group_msg_history", "请求频繁，请稍后再试");
    assert.strictEqual(c.riskHold, true);
    const risk = metas.find((m) => m.subType === "risk");
    assert.ok(risk, "应 emit risk");
    assert.ok(c._holdUntil > Date.now());
    // hold 中主动调用快速失败（不 sleep）
    await assert.rejects(c.call("get_group_list", {}), /风控暂停/);
    c.stop();
  });
  it("普通网络失败不触发 risk，但累计 failStreak", () => {
    const { OneBotClient } = require("../core/onebot");
    const c = new OneBotClient({ apiMinIntervalMs: 0 });
    c._noteFailure("x", "ECONNREFUSED connect");
    assert.strictEqual(c.riskHold, false);
    assert.ok(c.failStreak >= 1);
  });
  it("成功复位 failStreak；hold 过期后解锁", async () => {
    const { OneBotClient } = require("../core/onebot");
    const c = new OneBotClient({ apiMinIntervalMs: 0 });
    c._noteFailure("x", "请求频繁");
    assert.strictEqual(c.riskHold, true);
    c._holdUntil = Date.now() - 1; // 模拟 hold 结束
    c._noteSuccess();
    assert.strictEqual(c.riskHold, false);
    assert.strictEqual(c.failStreak, 0);
    // 解锁后 call 可执行（stub 掉 _callRaw 避免触网）
    const order = [];
    c._callRaw = async () => { order.push("ok"); return {}; };
    const r = await c.call("get_login_info", {});
    assert.deepStrictEqual(order, ["ok"]);
    c.stop();
  });
  it("串行节流：并发 call 依序执行", async () => {
    const { OneBotClient } = require("../core/onebot");
    const c = new OneBotClient({ apiMinIntervalMs: 0 });
    const order = [];
    c._callRaw = async () => { order.push(Date.now()); return {}; };
    await Promise.all([c.call("get_login_info", {}), c.call("get_group_list", {}), c.call("get_msg", {})]);
    assert.strictEqual(order.length, 3);
    assert.ok(order[2] >= order[0], "后到 call 不应早于先到执行");
    c.stop();
  });
});
