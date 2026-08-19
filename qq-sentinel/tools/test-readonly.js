// 只读护栏验证
const { OneBotClient, isReadOnlyAction } = require("../core/onebot");
const c = new OneBotClient({ wsUrl: "ws://127.0.0.1:3001" });
(async () => {
  // 写操作必须被拒
  const writes = ["send_group_msg", "send_group_forward_msg", "set_group_name", "delete_msg", "kick_group_member", "set_group_ban", "send_private_msg", "set_essence_msg", "handle_group_request"];
  let ok = true;
  for (const a of writes) {
    const r = await c.call(a, {}).then(() => "ALLOWED", (e) => "REJECTED");
    if (r !== "REJECTED") { console.log("❌ 写操作未被拦截:", a, r); ok = false; }
  }
  // 只读操作必须放行（不真连，检查是否通过白名单进入网络层——此处应走到 http 请求并失败于连接，而非"只读拒绝"）
  const reads = ["get_login_info", "get_group_list", "get_group_member_list", "get_group_msg_history", "_get_group_notice", "get_friend_list", "get_msg", "get_group_info"];
  for (const a of reads) {
    const r = await c.call(a, {}).then(() => "NETWORK", (e) => e.message);
    if (r === "NETWORK" || r.includes("http") || r.includes("ECONN")) { /* 放行到网络层 = 白名单通过 */ }
    else if (r.includes("只读模式")) { console.log("❌ 只读操作被误拦截:", a, r); ok = false; }
  }
  // isReadOnlyAction 单元
  const unitOk = writes.every((a) => !isReadOnlyAction(a)) && reads.every((a) => isReadOnlyAction(a));
  console.log(ok && unitOk ? "✅ 只读护栏 OK：写操作全部拒绝，只读操作全部放行" : "❌ 护栏异常");
})();