const { execFileSync } = require("child_process");
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "QQSentinelTest";
const cmd = '"C:\\Program Files\\nodejs\\node.exe" "G:\\deepseek\\qq-sentinel"';
try {
  // add
  execFileSync("reg", ["add", RUN_KEY, "/v", NAME, "/t", "REG_SZ", "/d", cmd, "/f"], { stdio: "ignore" });
  console.log("✅ add 成功");
  // query
  const out = execFileSync("reg", ["query", RUN_KEY, "/v", NAME], { encoding: "utf8" });
  console.log("✅ query 成功，含条目:", out.includes(NAME));
  console.log("  值:", out.split("\n").map(s=>s.trim()).filter(Boolean).slice(-1)[0]);
  // delete 清理
  execFileSync("reg", ["delete", RUN_KEY, "/v", NAME, "/f"], { stdio: "ignore" });
  console.log("✅ delete 成功（已清理）");
} catch (e) {
  console.log("❌ 失败:", e.message);
}