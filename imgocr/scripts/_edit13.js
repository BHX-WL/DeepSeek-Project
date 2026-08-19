"use strict";
const fs = require("fs");
const p = "G:/deepseek/imgocr/renderer/app.js";
let c = fs.readFileSync(p, "utf8");
const old = '  $("btn-napcat-clear-pending").addEventListener("click", async () => {';
const neu = '  $("btn-napcat-showqr").addEventListener("click", async () => {\n    saveNapcatConfig();\n    const r = await api.napcatShowQr();\n    showMsg("napcat-status", r && r.opened ? "已在图片查看器中打开二维码" : "未检测到登录二维码（NapCat 可能在正常运行）", 4000);\n  });\n' + old;
const n = c.split(old).length - 1;
if (n !== 1) { console.log("MISS(" + n + ")"); process.exit(1); }
fs.writeFileSync(p, c.replace(old, neu), "utf8");
console.log("OK: showQr button binding");