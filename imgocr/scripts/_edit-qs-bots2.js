"use strict";
const fs = require("fs");
function repFile(p, pairs) {
  let c = fs.readFileSync(p, "utf8");
  for (const [old, neu, tag] of pairs) {
    const n = c.split(old).length - 1;
    if (n !== 1) { console.log("MISS(" + n + "): " + tag); continue; }
    c = c.replace(old, neu); console.log("OK: " + tag);
  }
  fs.writeFileSync(p, c, "utf8");
}

// 1) config.js: autoIgnoreBots 默认值
repFile("G:/deepseek/qq-sentinel/core/config.js", [[
  '    ignoreBotUins: [],       // 补充忽略的官方机器人 QQ 号（默认自动过滤 2854196 号段）',
  '    ignoreBotUins: [],       // 补充忽略的官方机器人 QQ 号（默认自动过滤 2854196 号段）\n    autoIgnoreBots: true,    // 检测到 is_robot 成员时自动并入 ignoreBotUins',
  "config autoIgnoreBots"
]]);

// 2) summarizer.js: require bots + 概况机器人数
repFile("G:/deepseek/qq-sentinel/core/summarizer.js", [
  ['const hotspots = require("./hotspots");',
   'const hotspots = require("./hotspots");\nconst bots = require("./bots");',
   "summarizer require bots"],
  ['    out.push(`【概况】消息 ${msgs.length} 条 · 参与 ${userCount.size} 人 · @全体 ${atAll} 次 · 图片 ${images} 张 · 最活跃时段 ${peak}:00`);',
   '    const botN = bots.getBots(gid).length;\n    out.push(`【概况】消息 ${msgs.length} 条 · 参与 ${userCount.size} 人 · @全体 ${atAll} 次 · 图片 ${images} 张 · 机器人 ${botN} 个 · 最活跃时段 ${peak}:00`);',
   "summarizer 概况 bot count"]
]);

// 3) preload.js: bots API + 通道
repFile("G:/deepseek/qq-sentinel/preload.js", [
  ['  appStats: safe("app:stats"),',
   '  appStats: safe("app:stats"),\n  botsGet: safe("bots:get"),\n  botsGetAll: safe("bots:getAll"),\n  botsScan: safe("bots:scan"),',
   "preload bots APIs"],
  ['"groups:updated", "summary:done"]',
   '"groups:updated", "summary:done", "bots:updated"]',
   "preload channel"]
]);

// 4) index.html: 检测按钮 + 设置勾选
repFile("G:/deepseek/qq-sentinel/renderer/index.html", [
  ['<h2>群列表 <button id="btn-refresh-groups" class="btn small">刷新</button></h2>',
   '<h2>群列表 <button id="btn-refresh-groups" class="btn small">刷新</button> <button id="btn-scan-bots" class="btn small" title="扫描各群成员，标记机器人（NapCat 返回 is_robot 字段）">🤖 检测机器人</button></h2>',
   "index scan button"],
  ['<label>监听群号（逗号分隔，空=全部） <input type="text" id="set-groups"></label>',
   '<label>监听群号（逗号分隔，空=全部） <input type="text" id="set-groups"></label>\n          <label><input type="checkbox" id="set-auto-ignore-bots"> 自动把检测到的机器人加入汇总忽略列表</label>',
   "index checkbox"]
]);

// 5) app.js
repFile("G:/deepseek/qq-sentinel/renderer/app.js", [
  // loadSettings
  ['  $("#set-conflicts").checked = !!s.includeConflicts;',
   '  $("#set-conflicts").checked = !!s.includeConflicts;\n  $("#set-auto-ignore-bots").checked = s.autoIgnoreBots !== false;',
   "loadSettings checkbox"],
  // saveSettings summarize
  ['    conflictMessageMin: parseInt($("#set-conflict-min").value, 10) || 8,\n  });',
   '    conflictMessageMin: parseInt($("#set-conflict-min").value, 10) || 8,\n    autoIgnoreBots: $("#set-auto-ignore-bots").checked,\n  });',
   "saveSettings checkbox"],
  // renderGroups: 拉机器人数据
  ['  const spec = await getSpecGroups();',
   '  let botsAll = {};\n  try { botsAll = (await api.botsGetAll()).bots || {}; } catch {}\n  const spec = await getSpecGroups();',
   "renderGroups fetch bots"],
  // 卡片模板：机器人行
  ['      <div class="gstat">${Number(g.messages) || 0} 条消息 · 最近 ${fmtTime(g.lastActive) || "-"}</div>\n    </div>\n  `).join("");',
   '      <div class="gstat">${Number(g.messages) || 0} 条消息 · 最近 ${fmtTime(g.lastActive) || "-"}</div>\n      ${(botsAll[String(g.groupId)] || []).length ? `<div class="gbots">🤖 机器人：${(botsAll[String(g.groupId)] || []).map((b) => esc(b.nickname)).join("、")}</div>` : ""}\n    </div>\n  `).join("");',
   "card bot line"],
  // 扫描按钮事件（插在刷新按钮事件附近 —— 用 fillGroupSelects 后插入，先找刷新按钮绑定）
  ['  fillGroupSelects();\n}',
   '  fillGroupSelects();\n}\n\n$("#btn-scan-bots").addEventListener("click", async () => {\n  toast("正在检测各群机器人…");\n  const r = await api.botsScan();\n  if (r && r.ok) {\n    const n = Object.values(r.all || {}).reduce((s, arr) => s + arr.length, 0);\n    toast("✅ 检测完成，共标注 " + n + " 个机器人");\n    renderGroups();\n  } else {\n    toast("检测失败：" + ((r && r.error) || "未知"));\n  }\n});',
   "scan button handler"],
  // bots:updated 订阅
  ['  api.on("groups:updated", () => { renderGroups(); renderOverview(); });',
   '  api.on("groups:updated", () => { renderGroups(); renderOverview(); });\n  api.on("bots:updated", () => { renderGroups(); });',
   "bots updated subscription"]
]);
console.log("all edits done");