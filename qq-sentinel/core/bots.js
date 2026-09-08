// core/bots.js — 群机器人检测与标注
// 从成员列表读取 is_robot 标记（NapCat 提供），持久化到 bots.json，
// 供界面标注 + 汇总自动忽略机器人刷屏。
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("./logger");

let _dir = null;
let _bots = {};    // gid -> [{userId, nickname, card}]
let _scanned = {}; // gid -> 扫描时间戳

function init(dir) {
  _dir = dir;
  try {
    const f = path.join(_dir, "bots.json");
    if (fs.existsSync(f)) {
      let raw = fs.readFileSync(f, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) _bots = j;
      if (j && j._scanned && typeof j._scanned === "object") _scanned = j._scanned;
    }
  } catch (e) {
    L.warn("[bots] 加载失败:", e.message);
  }
}

function persist() {
  try {
    fs.mkdirSync(_dir, { recursive: true });
    const tmp = path.join(_dir, "bots.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify({ _scanned, ..._bots }, null, 2), "utf8");
    fs.renameSync(tmp, path.join(_dir, "bots.json"));
  } catch (e) {
    L.warn("[bots] 保存失败:", e.message);
  }
}

// 扫描单个群：标记 is_robot=true 的成员；失败时返回上次结果
async function scanGroup(client, gid) {
  const key = String(gid);
  try {
    const list = await client.call("get_group_member_list", { group_id: Number(gid) }, 20000);
    if (!Array.isArray(list)) return getBots(key);
    const bots = list
      .filter((m) => m && m.is_robot === true)
      .map((m) => ({
        userId: String(m.user_id || ""),
        nickname: String(m.nickname || m.card || "未知").slice(0, 60),
        card: String(m.card || "").slice(0, 60),
      }))
      .filter((b) => b.userId);
    _bots[key] = bots;
    _scanned[key] = Date.now();
    persist();
    return bots;
  } catch (e) {
    L.warn(`[bots] 扫描群 ${gid} 失败:`, e.message);
    return getBots(key);
  }
}

// 顺序扫描多个群（串行，避免 NapCat 并发查询压力）
async function scanGroups(client, gids) {
  const out = {};
  for (const gid of gids.slice(0, 30)) {
    out[String(gid)] = await scanGroup(client, gid);
  }
  return out;
}

function getBots(gid) {
  return Array.isArray(_bots[String(gid)]) ? _bots[String(gid)].slice() : [];
}
function getBotUins(gid) {
  return getBots(gid).map((b) => b.userId);
}
function getAllBots() {
  const out = {};
  for (const k of Object.keys(_bots)) out[k] = Array.isArray(_bots[k]) ? _bots[k].slice() : [];
  return out;
}
function getScanned(gid) {
  return _scanned[String(gid)] || 0;
}
function botByUin(gid, uin) {
  return getBots(gid).find((b) => b.userId === String(uin)) || null;
}

module.exports = { init, persist, scanGroup, scanGroups, getBots, getBotUins, getAllBots, getScanned, botByUin };