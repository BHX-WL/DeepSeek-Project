// core/store.js — 本地存储：JSONL 追加 + 内存索引（零原生依赖，exFAT 友好）
const fs = require("fs");
const path = require("path");

const L = require("./logger");

let _dir = null;
const groups = new Map();        // groupId -> meta
const msgCount = new Map();      // groupId -> number（消息总数）
const lastMsgAt = new Map();     // groupId -> ISO string

// ---------- gid 安全校验 ----------
// gid 可能来自远端 NapCat（群号）或 IPC 参数，必须防路径穿越：
// 只允许 1-20 位数字（QQ 群号 / 机器人 QQ 号均为纯数字）
const GID_RE = /^\d{1,20}$/;
function safeGid(gid) {
  const s = String(gid == null ? "" : gid).trim();
  return GID_RE.test(s) ? s : null;
}

function init(dir) {
  _dir = dir;
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "announcements"), { recursive: true });
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  fs.mkdirSync(path.join(dir, "kw-hits"), { recursive: true });
  loadGroups();
  scanCounts();
}

function groupFile() { return path.join(_dir, "groups.json"); }
// 所有文件路径必须经 safeGid 校验；非法 gid 返回 null（调用方应跳过）
function msgFile(gid) {
  const s = safeGid(gid);
  return s ? path.join(_dir, "messages", `${s}.jsonl`) : null;
}
function annFile(gid) {
  const s = safeGid(gid);
  return s ? path.join(_dir, "announcements", `${s}.jsonl`) : null;
}
function evtFile(gid) {
  const s = safeGid(gid);
  return s ? path.join(_dir, "events", `${s}.jsonl`) : null;
}
function kwFile(gid) {
  const s = safeGid(gid);
  return s ? path.join(_dir, "kw-hits", `${s}.jsonl`) : null;
}

function loadGroups() {
  try {
    const raw = fs.readFileSync(groupFile(), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return; // 结构异常：丢弃
    for (const g of arr) {
      if (!g || typeof g !== "object") continue;
      const id = safeGid(g.groupId);
      if (!id) continue; // 非法 groupId 跳过
      groups.set(id, g);
    }
  } catch (e) { /* no groups yet */ }
}

function saveGroups() {
  try {
    const tmp = groupFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...groups.values()], null, 2), "utf8");
    fs.renameSync(tmp, groupFile()); // 原子替换，防中途崩溃损坏
  } catch (e) {
    L.error("[store] saveGroups failed:", e.message);
  }
}

function scanCounts() {
  const dir = path.join(_dir, "messages");
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const gid = f.slice(0, -6);
      if (!safeGid(gid)) continue; // 只统计合法文件名
      const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
      msgCount.set(gid, lines.length);
      const last = lines[lines.length - 1];
      if (last) {
        try { lastMsgAt.set(gid, JSON.parse(last).time || null); } catch (e) {}
      }
    }
  } catch (e) { /* empty */ }
}

function append(file, obj) {
  // 容错：写盘失败（磁盘满/权限）记录日志，不抛给调用方（否则会中断监听循环）
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
    return true;
  } catch (e) {
    L.error("[store] append failed:", e.message, file);
    return false;
  }
}

// ---------- 群 ----------
// 群元数据延迟落盘（防抖）：高频 upsertGroup 不每次都写盘
let _saveTimer = null;
let _dirty = false;
function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_dirty) { _dirty = false; saveGroups(); }
  }, 1000); // 1 秒防抖
}

function upsertGroup(meta) {
  const id = safeGid(meta.groupId || meta.group_id);
  if (!id) return null;
  const prev = groups.get(id) || {};
  const g = {
    groupId: id,
    name: String(meta.groupName || meta.group_name || prev.name || `群${id}`).slice(0, 200),
    watched: prev.watched != null ? !!prev.watched : true,
    memberCount: Number.isFinite(Number(meta.memberCount ?? meta.member_count)) ? Number(meta.memberCount ?? meta.member_count) : (prev.memberCount ?? null),
    firstSeen: prev.firstSeen || new Date().toISOString(),
    lastActive: new Date().toISOString(),
  };
  groups.set(id, g);
  scheduleSave(); // 延迟落盘，避免高频写
  return g;
}

// 立即落盘（进程退出/需要保证时调用）
function flushGroups() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_dirty) { _dirty = false; saveGroups(); }
}

function listGroups() {
  return [...groups.values()].sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

function setWatched(gid, watched) {
  const id = safeGid(gid);
  if (!id) return null;
  const g = groups.get(id);
  if (!g) return null;
  g.watched = !!watched;
  saveGroups();
  return g;
}

// 记录/读取"上次汇总完成时间"（用于默认汇总窗口计算：距上次 < 默认周期则从上次时间起）
function setLastSummary(gid, isoTime) {
  const id = safeGid(gid);
  if (!id) return null;
  const g = groups.get(id) || upsertGroup({ groupId: id });
  if (isoTime == null) delete g.lastSummary; // 清空
  else g.lastSummary = String(isoTime).slice(0, 40);
  saveGroups();
  return g.lastSummary || null;
}
function getLastSummary(gid) {
  const id = safeGid(gid);
  if (!id) return null;
  const g = groups.get(id);
  return g && g.lastSummary ? g.lastSummary : null;
}

// ---------- 消息 ----------
function appendMessage(gid, msg) {
  const id = safeGid(gid);
  if (!id) return false; // 非法 gid 拒绝写入（防路径穿越）
  const file = msgFile(id);
  if (!file) return false;
  append(file, msg);
  msgCount.set(id, (msgCount.get(id) || 0) + 1);
  lastMsgAt.set(id, msg.time || new Date().toISOString());
  if (!groups.has(id)) upsertGroup({ groupId: id });
  else { groups.get(id).lastActive = msg.time || new Date().toISOString(); }
  return true;
}

function getMessages(gid, opts = {}) {
  const id = safeGid(gid);
  if (!id) return [];
  const { since, until, limit = 500, offset = 0 } = opts;
  const file = msgFile(id);
  if (!file || !fs.existsSync(file)) return [];
  // 性能与完整性的权衡：
  //  - 有 since 且文件很大时，尾部窗口可能漏掉较早窗口内消息 → 若 since 早于"尾部窗口起点"则回退全量读
  //  - 无 since（取最近）→ 尾部读取足够
  let lines;
  const stat = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
  const want = Math.max(1000, Math.min(150000, (Number(offset) || 0) + (Number(limit) || 500) + 50000));
  if (since && stat > 64 * 1024 * 1024) {
    // 大文件 + 时间过滤：先读尾部窗口，检查窗口起点是否早于 since；若否（可能漏），回退全量
    const tailLines = readTailLines(file, want);
    const earliestTail = tailLines.map((l) => { try { return JSON.parse(l).time; } catch { return null; } }).filter(Boolean).sort()[0];
    if (earliestTail && earliestTail <= since) lines = tailLines; // 尾部已覆盖 since
    else lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); // 回退全量
  } else if (stat > 8 * 1024 * 1024) {
    lines = readTailLines(file, want);
  } else {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  }
  const out = [];
  for (const ln of lines) {
    try {
      const m = JSON.parse(ln);
      if (!m || typeof m !== "object") continue;
      if (since && m.time < since) continue;
      if (until && m.time > until) continue;
      out.push(m);
    } catch (e) { /* skip bad line */ }
  }
  return out.slice(offset, offset + limit);
}

// 从文件尾部读取最多 n 行（大文件高效；小文件读全部）
function readTailLines(file, n) {
  try {
    const stat = fs.statSync(file);
    // 小文件（<8MB）直接全读
    if (stat.size < 8 * 1024 * 1024) {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    }
    // 大文件：从末尾分块向前读，凑够 n 行
    const CHUNK = 256 * 1024; // 256KB
    const fd = fs.openSync(file, "r");
    try {
      let pos = stat.size;
      let buf = "";
      while (pos > 0 && buf.split("\n").length < n + 1) {
        const readSize = Math.min(CHUNK, pos);
        pos -= readSize;
        const chunk = Buffer.alloc(readSize);
        fs.readSync(fd, chunk, 0, readSize, pos);
        buf = chunk.toString("utf8") + buf;
      }
      return buf.split("\n").filter(Boolean).slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) { return []; }
}

function messageCount(gid) {
  const id = safeGid(gid);
  if (!id) return 0;
  return msgCount.get(id) || 0;
}

// ---------- 公告 ----------
function appendAnnouncement(gid, ann) {
  const file = annFile(gid);
  if (file) append(file, ann);
}
function listAnnouncements(gid) {
  const file = annFile(gid);
  if (!file || !fs.existsSync(file)) return [];
  return readTailLines(file, 5000).map((ln) => {
    try { return JSON.parse(ln); } catch (e) { return null; }
  }).filter(Boolean);
}

// ---------- 大事事件 ----------
function appendEvent(gid, evt) {
  const file = evtFile(gid);
  if (!file) return false;
  return append(file, evt); // 返回写入是否成功（供调用方决定是否推进游标）
}
function listEvents(gid, limit = 200) {
  const file = evtFile(gid);
  if (!file || !fs.existsSync(file)) return [];
  const n = Math.max(100, Math.min(20000, Number(limit) || 200));
  const all = readTailLines(file, n).map((ln) => {
    try { return JSON.parse(ln); } catch (e) { return null; }
  }).filter(Boolean);
  return all.slice(-limit).reverse();
}

// ---------- 关键词命中（逐条存档） ----------
function appendKeywordHit(gid, rec) {
  const file = kwFile(gid);
  if (!file) return false;
  return append(file, rec);
}
function listKeywordHits(gid, limit = 500) {
  const file = kwFile(gid);
  if (!file || !fs.existsSync(file)) return [];
  const n = Math.max(50, Math.min(5000, Number(limit) || 500));
  const all = readTailLines(file, n).map((ln) => {
    try { return JSON.parse(ln); } catch (e) { return null; }
  }).filter(Boolean);
  return all.slice(-limit).reverse();
}

// ---------- 统计 ----------
function stats() {
  const out = [];
  for (const [gid, g] of groups) {
    out.push({
      groupId: gid,
      name: g.name,
      watched: g.watched,
      messages: msgCount.get(gid) || 0,
      lastActive: lastMsgAt.get(gid) || null,
      memberCount: g.memberCount,
    });
  }
  return out;
}

module.exports = {
  init, upsertGroup, flushGroups, listGroups, setWatched,
  setLastSummary, getLastSummary,
  appendMessage, getMessages, messageCount,
  appendAnnouncement, listAnnouncements,
  appendEvent, listEvents,
  appendKeywordHit, listKeywordHits,
  stats,
};
