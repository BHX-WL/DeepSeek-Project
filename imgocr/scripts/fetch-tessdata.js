// scripts/fetch-tessdata.js — 下载 eng + chi_sim traineddata 到 resources/tessdata（离线打包用）
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://tessdata.projectnaptha.com/4.0.0";
const LANGS = ["eng", "chi_sim"];
const OUT = path.join(__dirname, "..", "resources", "tessdata");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    const req = https.get(url, { timeout: 180000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try { f.close(); fs.unlinkSync(dest); } catch {}
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        try { f.close(); fs.unlinkSync(dest); } catch {}
        return reject(new Error("HTTP " + res.statusCode + " " + url));
      }
      res.pipe(f);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", (e) => {
      try { f.close(); fs.unlinkSync(dest); } catch {}
      reject(e);
    });
    f.on("finish", () => { try { f.close(); } catch {} resolve(); });
    f.on("error", (e) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = {};
  for (const lang of LANGS) {
    const file = lang + ".traineddata.gz"; // tesseract.js 默认 gzip=true，读取 .gz
    const dest = path.join(OUT, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) {
      console.log("已存在: " + file + " (" + fs.statSync(dest).size + " bytes)");
    } else {
      console.log("下载 " + lang + " ...");
      await download(BASE + "/" + lang + ".traineddata.gz", dest);
    }
    manifest[lang] = { file: file, bytes: fs.statSync(dest).size, fetchedAt: new Date().toISOString() };
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log("完成: " + JSON.stringify(manifest));
})().catch((e) => { console.error("失败:", e && e.message); process.exit(1); });