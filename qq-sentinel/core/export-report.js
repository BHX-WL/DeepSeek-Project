// core/export-report.js — 汇总报告导出（纯函数，供 main IPC 与单测复用）
"use strict";

const EVENT_KINDS = ["summary", "daily", "conflict", "keyword", "at_all", "announcement", "admin_change", "member_joined", "member_left"];

// 生成 Markdown 报告
function buildReportMarkdown({ gid, groupName, since, until, events, msgs }) {
  const L = [];
  L.push(`# QQ 群大事报告 — ${groupName || ("群" + gid)}（${gid}）`);
  L.push("");
  L.push(`- 时段：${since || "（未限定）"} ~ ${until || "（未限定）"}`);
  L.push(`- 消息总数：${Array.isArray(msgs) ? msgs.length : 0}`);
  L.push(`- 导出时间：${new Date().toISOString()}`);
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && EVENT_KINDS.includes(e.kind));
  L.push("");
  L.push(`## 大事与汇总记录（${evs.length}）`);
  if (!evs.length) L.push("（该时段无大事/汇总记录）");
  for (const e of evs) {
    L.push("");
    L.push(`### [${e.kind}] ${e.title || "（无标题）"} · ${e.time || e.savedAt || ""}`);
    const body = e.summary || e.text || e.reason || "";
    if (body) L.push(String(body).slice(0, 4000));
    if (e.engine) L.push(`<sup>引擎：${e.engine}</sup>`);
  }
  const sample = (Array.isArray(msgs) ? msgs : []).slice(-200);
  L.push("");
  L.push(`## 消息样本（最近 ${sample.length} 条）`);
  if (!sample.length) L.push("（无消息样本）");
  for (const m of sample) {
    const who = (m.nickname || m.card || m.userId || "?").toString().slice(0, 30);
    const txt = String(m.text || "").slice(0, 200).replace(/\r?\n/g, " ");
    const at = m.atAll ? " [@全体]" : "";
    L.push(`- ${m.time || ""} ${who}：${txt}${at}${m.images ? " [图×" + m.images + "]" : ""}`);
  }
  return L.join("\n") + "\n";
}

// 生成 JSON 报告（结构化）
function buildReportJson({ gid, groupName, since, until, events, msgs }) {
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && EVENT_KINDS.includes(e.kind));
  return {
    kind: "qq-group-report",
    version: 1,
    gid: String(gid || ""),
    groupName: groupName || "",
    since: since || null,
    until: until || null,
    exportedAt: new Date().toISOString(),
    messageCount: Array.isArray(msgs) ? msgs.length : 0,
    events: evs.map((e) => ({
      kind: e.kind,
      title: e.title,
      summary: e.summary || e.text || "",
      reason: e.reason || "",
      engine: e.engine || null,
      time: e.time || e.savedAt || null,
      level: e.level ?? null,
      from: e.from || null,
      to: e.to || null,
    })),
    messageSample: (Array.isArray(msgs) ? msgs : []).slice(-200).map((m) => ({
      time: m.time || null,
      user: (m.nickname || m.card || m.userId || "").toString().slice(0, 30),
      text: String(m.text || "").slice(0, 500),
      atAll: !!m.atAll,
      images: m.images || 0,
    })),
  };
}

module.exports = { buildReportMarkdown, buildReportJson, EVENT_KINDS };
