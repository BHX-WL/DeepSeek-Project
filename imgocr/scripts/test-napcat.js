// scripts/test-napcat.js — 对接测试：连真实 NapCat(127.0.0.1:3001)，列群 + 拉最近图片 + 下载
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const { NapCatClient } = require("../core/napcat");

async function main() {
  const client = new NapCatClient({
    wsUrl: "ws://127.0.0.1:3001",
    imageDir: path.join(os.tmpdir(), "imgocr-napcat-test")
  });
  await client.ensureConnected();
  console.log("connected:", client.connected);
  const groups = await client.listGroups();
  console.log("群数:", groups.length);
  console.log("前5个群:", JSON.stringify(groups.slice(0, 5)));
  if (!groups.length) { console.log("无群，跳过拉图"); client.close(); return; }
  // 找第一个能响应的群（NapCat 对大群历史可能挂起，跳过）
  let gid = 0;
  for (const g of groups) {
    try {
      await client.call("get_group_msg_history", { group_id: g.groupId, message_seq: 0, count: 20 }, 15000);
      gid = g.groupId; break;
    } catch {}
  }
  if (!gid) { console.log("没有可响应的群"); client.close(); return; }
  console.log("使用群:", gid);
  const found = await client.fetchRecentImages([gid], 20);
  console.log("群 " + gid + " 最近图片数:", found.length);
  if (found.length) {
    const dest = await client.downloadImage(found[0].image, gid);
    console.log("下载到:", dest, "存在:", fs.existsSync(dest), "大小:", fs.existsSync(dest) ? fs.statSync(dest).size : 0);
  }
  client.close();
  console.log("TEST OK");
}
main().catch((e) => { console.error("TEST FAIL:", (e && e.stack) || e); process.exit(1); });