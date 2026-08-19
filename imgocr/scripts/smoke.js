// scripts/smoke.js — 冒烟测试：核心 OCR + 存档（不依赖 Electron）
// 用法: npm run smoke -- <图片路径>
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { OcrEngine } = require("../core/ocr");
const { Store } = require("../core/store");

async function main() {
  const img = process.argv[2];
  if (!img || !fs.existsSync(img)) {
    console.error("用法: npm run smoke -- <图片路径>");
    process.exit(2);
  }
  const tess = path.join(__dirname, "..", "resources", "tessdata");
  const hasLocal = fs.existsSync(path.join(tess, "eng.traineddata.gz")) && fs.existsSync(path.join(tess, "chi_sim.traineddata.gz"));
  const langPath = hasLocal ? tess : undefined;
  console.log("本地模型:", hasLocal ? tess : "无（将走 CDN，需联网）");

  const tmpFile = path.join(os.tmpdir(), "imgocr-smoke-" + process.pid + ".jsonl");
  const store = new Store(tmpFile);
  store.load();

  const engine = new OcrEngine({
    langPath: langPath,
    cachePath: path.join(os.tmpdir(), "imgocr-smoke-cache"),
    timeoutMs: 180000
  });

  console.log("开始识别:", img);
  const res = await engine.recognize(img, { langs: ["eng", "chi_sim"] });
  console.log("ok =", res.ok, " 置信度 =", res.confidence, " 耗时 =", res.durationMs + "ms");
  console.log("--- 文本(前2000字) ---");
  console.log(res.text.slice(0, 2000));
  if (!res.ok || !res.text.trim()) {
    console.error("失败：无文本");
    process.exit(1);
  }

  const entry = store.add({
    filePath: img,
    fileName: path.basename(img),
    languages: ["eng", "chi_sim"],
    status: "done",
    text: res.text,
    confidence: res.confidence,
    durationMs: res.durationMs,
    ocrAt: Date.now()
  });
  const found = store.search(path.basename(img).slice(0, 6), 5);
  console.log("存档条目数 =", store.stats().count, " 搜索命中 =", found.length);
  if (found.length < 1) {
    console.error("失败：搜索未命中");
    process.exit(1);
  }
  await engine.terminate();
  try { fs.unlinkSync(tmpFile); } catch {}
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAIL:", (e && e.stack) || e);
  process.exit(1);
});