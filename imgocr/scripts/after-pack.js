// scripts/after-pack.js — electron-builder 打包后补拷 NapCat 运行依赖
// 原因：electron-builder 的 extraResources 会裁剪 node_modules（当作应用依赖处理），
// 而 napcat.mjs 顶部 import "express" 等，缺失会导致 NapCat 完全无法启动。
"use strict";
exports.default = async function afterPack(context) {
  const path = require("path");
  const fs = require("fs");
  const { appOutDir, packager } = context;
  const srcBase = path.join(packager.projectDir, "bundle-qq-sentinel", "napcat");
  const destBase = path.join(appOutDir, "resources", "qq-sentinel", "napcat");
  const items = ["node_modules", "guild1.db", "guild1.db-wal", "guild1.db-shm", "cache"];
  for (const it of items) {
    const s = path.join(srcBase, it);
    const d = path.join(destBase, it);
    try {
      if (fs.existsSync(s)) {
        fs.cpSync(s, d, { recursive: true });
        console.log("[after-pack] copied " + it);
      }
    } catch (e) {
      console.warn("[after-pack] copy " + it + " failed: " + e.message);
    }
  }
};