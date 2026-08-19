// tools/mock-onebot.js — Mock OneBot 服务器：验证采集链路
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = 3001;
const wss = new WebSocketServer({ port: PORT });
console.log(`[mock] WS on ${PORT}`);

function fakeMsg(seq, user, name, text, extra = {}) {
  return {
    post_type: "message", message_type: "group",
    group_id: 10001, user_id: user, message_id: seq,
    time: Math.floor(Date.now() / 1000), sender: { nickname: name, card: name },
    message: [{ type: "text", data: { text } }],
    raw_message: text, ...extra,
  };
}

let seq = 0;
setInterval(() => {
  seq++;
  const msgs = [
    fakeMsg(seq, 1001, "小明", "今天有人一起开黑吗"),
    fakeMsg(seq, 1002, "小红", "我我我！晚上八点"),
  ];
  for (const m of msgs) {
    wss.clients.forEach((c) => c.readyState === 1 && c.send(JSON.stringify(m)));
  }
  if (seq % 5 === 0) {
    const atAll = {
      ...fakeMsg(seq, 1003, "群主", "今晚八点全体开会，全员参加！"),
      message: [{ type: "at", data: { qq: "all" } }, { type: "text", data: { text: " 今晚八点全体开会，全员参加！" } }],
      raw_message: "[CQ:at,qq=all] 今晚八点全体开会，全员参加！",
    };
    wss.clients.forEach((c) => c.readyState === 1 && c.send(JSON.stringify(atAll)));
  }
  if (seq % 7 === 0) {
    for (let i = 0; i < 4; i++) {
      const fight = fakeMsg(seq + i, 1004, "暴躁老哥", ["你他妈什么意思", "傻逼吧", "有本事再说一遍", "滚！别bb"][i]);
      wss.clients.forEach((c) => c.readyState === 1 && c.send(JSON.stringify(fight)));
    }
  }
}, 3000);

// HTTP API mock
const httpSrv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let action = "";
    try { action = JSON.parse(body).action; } catch (e) {}
    let data = null;
    if (action === "get_login_info") data = { user_id: 88888888, nickname: "监控小号" };
    else if (action === "get_group_list") data = [{ group_id: 10001, group_name: "测试群", member_count: 10 }];
    else if (action === "get_group_msg_history") data = [];
    else if (action === "_get_group_notice" || action === "get_group_announcement") data = [{ notice_id: "a1", content: "测试公告：全体注意", sender_id: 1003, time: Math.floor(Date.now() / 1000) }];
    else data = null;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: data === null ? "failed" : "ok", retcode: 0, data }));
  });
});
httpSrv.listen(3000, () => console.log("[mock] HTTP on 3000"));
