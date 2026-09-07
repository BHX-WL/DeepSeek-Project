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
  // 模型分发闭环校验：qq-sentinel 内置语义模型必须随包存在，缺失直接终止打包（v0.4+）
  const qqAppDest = path.join(appOutDir, "resources", "qq-sentinel", "app");
  const modelOnnx = path.join(qqAppDest, "models", "paraphrase-multilingual-MiniLM-L12-v2", "onnx", "model_quantized.onnx");
  if (!fs.existsSync(modelOnnx)) {
    throw new Error("[after-pack] qq-sentinel 内置语义模型缺失：" + modelOnnx + "\n请先执行 qq-sentinel 打包并把 dist/qq-sentinel-win32-x64/resources/app 同步到 imgocr/bundle-qq-sentinel/app（含 models/）。");
  }
  console.log("[after-pack] qq-sentinel 语义模型在包内 ✅ " + (fs.statSync(modelOnnx).size / 1048576).toFixed(0) + "MB");
  // qq-sentinel 运行依赖（ws / @xenova/transformers 等）同 NapCat 一样会被 extraResources 裁剪 → 补拷整棵 node_modules
  const qqAppSrcNm = path.join(packager.projectDir, "bundle-qq-sentinel", "app", "node_modules");
  const qqAppDestNm = path.join(appOutDir, "resources", "qq-sentinel", "app", "node_modules");
  if (fs.existsSync(qqAppSrcNm)) {
    fs.cpSync(qqAppSrcNm, qqAppDestNm, { recursive: true });
    console.log("[after-pack] copied qq-sentinel node_modules");
  } else {
    throw new Error("[after-pack] qq-sentinel node_modules 缺失: " + qqAppSrcNm + "\n请先同步 bundle-qq-sentinel/app（含 node_modules/）。");
  }
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