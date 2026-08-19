"use strict";
const fs = require("fs");
const repFile = (p, old, neu, label) => {
  let c = fs.readFileSync(p, "utf8");
  const n = c.split(old).length - 1;
  if (n !== 1) { console.log("MISS(" + n + "): " + label); return; }
  fs.writeFileSync(p, c.replace(old, neu), "utf8");
  console.log("OK: " + label);
};

// preload: showQr
repFile("G:/deepseek/imgocr/renderer/preload.js",
  '  napcatClearPending: () => ipcRenderer.invoke("napcat:clearPending"),',
  '  napcatClearPending: () => ipcRenderer.invoke("napcat:clearPending"),\n  napcatShowQr: () => ipcRenderer.invoke("napcat:showQr"),',
  "preload showQr");

// index.html: QR 路径输入 + 立即打开按钮
repFile("G:/deepseek/imgocr/renderer/index.html",
  '    <div id="napcat-groups" class="groups"></div>\n    <div class="row">',
  '    <div id="napcat-groups" class="groups"></div>\n    <div class="row">\n      <input id="napcat-qr" type="text" placeholder="NapCat 二维码路径（留空自动查找）" autocomplete="off">\n      <button id="btn-napcat-showqr" class="mini">立即打开二维码</button>\n    </div>\n    <div class="row">',
  "index.html QR input+button");

// app.js: 保存/回显 qrPath + 按钮事件
repFile("G:/deepseek/imgocr/renderer/app.js",
  '    api.napcatSaveConfig({\n      wsUrl: cap($("napcat-ws").value || "", 200),\n      groups: Array.from(napcatSelected).map(Number),\n      listen: listen !== undefined ? listen : $("napcat-listen").checked\n    }).then((r) => { if (r && !r.ok) showMsg("napcat-status", r.error, 4000); });',
  '    api.napcatSaveConfig({\n      wsUrl: cap($("napcat-ws").value || "", 200),\n      groups: Array.from(napcatSelected).map(Number),\n      listen: listen !== undefined ? listen : $("napcat-listen").checked,\n      qrPath: cap($("napcat-qr").value || "", 1024)\n    }).then((r) => { if (r && !r.ok) showMsg("napcat-status", r.error, 4000); });',
  "app.js saveConfig qrPath");
repFile("G:/deepseek/imgocr/renderer/app.js",
  '    $("napcat-ws").value = r.wsUrl || "ws://127.0.0.1:3001";\n    $("napcat-listen").checked = Boolean(r.listen);',
  '    $("napcat-ws").value = r.wsUrl || "ws://127.0.0.1:3001";\n    $("napcat-listen").checked = Boolean(r.listen);\n    if (r.qrPath) $("napcat-qr").value = r.qrPath;',
  "app.js status qrPath");
repFile("G:/deepseek/imgocr/renderer/app.js",
  '  $("napcat-clear-pending").addEventListener("click", async () => {',
  '  $("btn-napcat-showqr").addEventListener("click", async () => {\n    saveNapcatConfig();\n    const r = await api.napcatShowQr();\n    showMsg("napcat-status", r && r.opened ? "已在图片查看器中打开二维码" : "未检测到登录二维码（NapCat 可能在正常运行）", 4000);\n  });\n  $("napcat-clear-pending").addEventListener("click", async () => {',
  "app.js showQr button");
console.log("renderer done");