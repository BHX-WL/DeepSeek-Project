// core/collector.js — 采集器：OneBot 事件 → 存储；@全体/公告/吵架信号检测
const L = require("./logger");
const store = require("./store");
const config = require("./config");
const hotspots = require("./hotspots");

class Collector {
  constructor(client) {
    this.client = client;
    this.groupMeta = new Map();     // gid -> {name, memberCount}
    this._lastGroupRefresh = 0;
    this._conflictWindows = new Map(); // gid -> [{time, user_id, msg, seq}]
    this.onEvent = null;            // 上层关注的事件回调：(gid, evt) => void
    this.onConflict = null;         // 吵架候选回调：(gid, window, messages) => void
    this.stopped = false;
  }

  // 指定群过滤：config.watch.groups 非空时只采集列表内的群；空 = 全部群
  isWatchedGroup(gid) {
    try {
      const list = config.get("watch.groups");
      if (!Array.isArray(list) || list.length === 0) return true;
      return list.includes(String(gid));
    } catch { return true; }
  }

  // 当前指定群列表（供 UI/定时任务使用）
  watchGroups() {
    try {
      const list = config.get("watch.groups");
      return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
    } catch { return []; }
  }

  attach() {
    this.client.onEvent((evt) => this._handle(evt));
    // 预拉取热点库（微博热搜），保证消息匹配时有缓存；失败静默
    hotspots.ensureFetched();
  }

  _handle(evt) {
    if (this.stopped) return;
    try {
      if (evt.post_type === "message" && evt.message_type === "group") this._onGroupMessage(evt);
      else if (evt.post_type === "notice") this._onNotice(evt);
    } catch (e) {
      L.error("[collector] handle error:", e.message);
    }
  }

  // ---------- 群消息 ----------
  _onGroupMessage(evt) {
    const gid = String(evt.group_id);
    if (!this.isWatchedGroup(gid)) return; // 只采集指定群，其他群不处理
    const { text, atAll, atMe, mentions, images, faces } = parseMessage(evt);
    // 热点/热梗检测：命中微博热搜则标记（fire-and-forget 拉取，未拉取过则为空）
    let hotHits = [];
    try {
      if (hotspots.enabled() && text) {
        hotHits = hotspots.matchHotspots(text);
        if (hotHits.length === 0) hotHits = hotspots.matchKeywords(text).map((k) => ({ title: k, keyword: true }));
      }
    } catch (e) { L.debug("[collector] hotspot match skip:", e.message); }
    const msg = {
      time: new Date(evt.time * 1000).toISOString(),
      seq: String(evt.message_id || "").slice(0, 64),
      groupId: gid,
      userId: String(evt.user_id || "").slice(0, 32),
      nickname: String(evt.sender?.card || evt.sender?.nickname || evt.user_id || "").slice(0, 100),
      text: String(text || "").slice(0, 2000),
      atAll,
      atMe,
      mentions: (mentions || []).slice(0, 20).map((m) => String(m).slice(0, 32)),
      images: Number(images) || 0,
      faces: Number(faces) || 0,
      hotHits: (hotHits || []).slice(0, 10).map((h) => ({ title: String(h.title || "").slice(0, 100), rank: h.rank ?? null })),
      raw: String(evt.raw_message || "").slice(0, 2000),
    };
    store.appendMessage(gid, msg);
    const g = store.upsertGroup({
      groupId: gid,
      groupName: this.groupMeta.get(gid)?.name,
    });

    // @全体 = 大事
    if (atAll && config.get("summarize.includeAtAll")) {
      this._fireEvent(gid, {
        kind: "at_all",
        title: `${msg.nickname} @了全体成员`,
        text,
        time: msg.time,
        msg,
      });
    }
    // 有人提到了机器人自己
    if (atMe) {
      this._fireEvent(gid, { kind: "at_me", title: `${msg.nickname} 提到了机器人`, text, time: msg.time, msg });
    }

    // 吵架窗口检测
    this._trackConflict(gid, msg);
    this.onEvent?.(gid, msg);
  }

  // ---------- 通知（公告/撤回/管理） ----------
  _onNotice(evt) {
    const gid = String(evt.group_id);
    if (!this.isWatchedGroup(gid)) return; // 只采集指定群
    const t = evt.notice_type;
    const time = new Date(evt.time * 1000).toISOString();
    if (t === "group_recall") {
      // 用户要求：撤回不是"大事"，忽略，不记录事件
      return;
    }
    if (t === "group_admin") {
      const set = evt.set;
      this._fireEvent(gid, {
        kind: "admin_change",
        title: `${evt.user_id} ${set ? "成为" : "被撤销"}管理员`,
        time,
      });
      return;
    }
    if (t === "group_decrease") {
      this._fireEvent(gid, {
        kind: "member_left",
        title: `${evt.user_id} 退出了群${evt.sub_type === "kick" ? "（被踢）" : ""}`,
        time,
      });
      return;
    }
    if (t === "group_increase") {
      this._fireEvent(gid, {
        kind: "member_joined",
        title: `${evt.user_id} 加入了群`,
        time,
      });
      return;
    }
    // 公告相关 notice（NapCat 扩展可能推送）
    if (t === "group_notice" || t === "group_essence" || t === "group_poke") {
      this._fireEvent(gid, { kind: t, title: `群通知：${t}`, text: JSON.stringify(evt), time });
    }
  }

  // ---------- 吵架窗口 ----------
  _trackConflict(gid, msg) {
    try {
      const cfg = config.get("summarize");
      if (!cfg.includeConflicts) return;
      const win = this._conflictWindows.get(gid) || [];
      const windowMs = cfg.conflictWindowMin * 60000;
      const now = Date.parse(msg.time);
      // 清理过期
      while (win.length && now - Date.parse(win[0].time) > windowMs) win.shift();
      win.push(msg);
      // 窗口上限防护：最多保留 500 条，防止极端刷屏撑爆内存
      if (win.length > 500) win.splice(0, win.length - 500);
      this._conflictWindows.set(gid, win);
      if (win.length >= cfg.conflictMessageMin) {
        const first = win[0];
        // 简单信号：时间窗内高密度 + 存在明显冲突词
        const density = win.length / (cfg.conflictWindowMin || 10);
        const conflictScore = scoreConflict(win);
        if (conflictScore >= 2 || density >= cfg.conflictMessageMin / cfg.conflictWindowMin) {
          this._conflictWindows.set(gid, []); // 防重复
          this.onConflict?.(gid, {
            from: first.time,
            to: msg.time,
            count: win.length,
            users: new Set(win.map((m) => m.userId)).size,
            score: conflictScore,
            messages: win.slice(-30),
          });
        }
      }
      // Map 上限防护：超过 200 个群时清理最久未更新的（防群数量无限增长）
      if (this._conflictWindows.size > 200) {
        const oldest = [...this._conflictWindows.entries()].sort((a, b) => (Date.parse(a[1]?.[0]?.time || 0) - Date.parse(b[1]?.[0]?.time || 0)))[0];
        if (oldest) this._conflictWindows.delete(oldest[0]);
      }
    } catch (e) { L.debug("[collector] conflict track skip:", e.message); }
  }

  // ---------- 大事事件 ----------
  _fireEvent(gid, evt) {
    // 字段长度防护：远端/LLM 数据可能超长，截断防 JSONL 无限膨胀
    const clip = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) : s);
    const full = {
      ...evt,
      title: clip(evt.title, 300),
      text: clip(evt.text, 2000),
      summary: clip(evt.summary, 4000),
      groupId: gid,
      savedAt: new Date().toISOString(),
    };
    store.appendEvent(gid, full);
    L.info(`[collector] event ${evt.kind} in ${gid}: ${clip(evt.title, 100)}`);
    this.onEvent?.(gid, full);
  }

  // ---------- 群信息刷新 ----------
  async refreshGroupList() {
    try {
      const list = await this.client.getGroupList();
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const g of list) {
        const meta = store.upsertGroup({
          groupId: g.group_id,
          groupName: g.group_name,
          memberCount: g.member_count,
        });
        this.groupMeta.set(String(g.group_id), { name: g.group_name, memberCount: g.member_count });
        out.push(meta);
      }
      return out;
    } catch (e) {
      L.warn("[collector] refreshGroupList error:", e.message);
      return store.listGroups();
    }
  }

  // ---------- 历史回拉 ----------
  // NapCat 的 get_group_msg_history 在 message_seq=0 时读取 QQNT 本地数据库的"最近 N 条"，
  // count 越大回溯越深（实测 1500 可覆盖本地数周缓存）。翻页游标依赖内存短号映射，
  // 重启后失效，因此这里用"大 count 单次拉取 + 去重排序"，最大化利用本地历史缓存。
  // 注意：本地无缓存时 NapCat 可能报"消息0不存在"（视为空）；大群大数据可能超时（逐步降级）。
  async backfillHistory(gid, days = 3, maxCount = 1500) {
    if (!safeGid(gid)) { L.warn(`[collector] backfill 非法群号: ${gid}`); return 0; }
    const since = Date.now() - days * 86400000;
    let pulled = 0;
    try {
      // 单次大 count 拉取本地历史；超时/失败则逐步降级到更小 count
      let arr = null;
      for (const cnt of [maxCount, 1000, 500, 200, 100]) {
        try {
          const res = await this.client.getGroupMsgHistory(gid, 0, cnt);
          const cand = Array.isArray(res) ? res : (res && res.messages) || [];
          if (Array.isArray(cand) && cand.length > 0) { arr = cand; break; }
          // 空数组 = 本地无缓存，直接结束
          if (Array.isArray(cand)) break;
        } catch (e) {
          const msg = String(e?.message || "");
          // 本地无缓存（NapCat 报"消息0不存在"）视为正常空结果
          if (/消息0不存在|not exist|不存在/.test(msg)) break;
          L.warn(`[collector] backfill ${gid} count=${cnt} error:`, msg);
          // 超时/失败：降级到更小 count 重试
        }
        arr = null;
      }
      if (!Array.isArray(arr) || arr.length === 0) return 0;

      // 去重（按 message_id / message_seq）
      const seen = new Set();
      const uniq = arr.filter((m) => {
        const k = String(m.message_id || m.message_seq || m.real_seq || "");
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // 按时间排序（接口返回可能乱序）
      const sorted = uniq
        .map((m) => ({ ...m, _t: Number(m.time || 0) }))
        .sort((a, b) => a._t - b._t)
        .filter((m) => m._t > 0 && m._t * 1000 >= since); // 只保留窗口内且有时间的消息

      for (const m of sorted) {
        this._onGroupMessage({
          post_type: "message",
          message_type: "group",
          group_id: Number(gid),
          user_id: m.user_id,
          message_id: m.message_id,
          time: m.time,
          sender: m.sender || {},
          message: m.message,
          raw_message: m.raw_message || "",
        });
        pulled++;
      }
    } catch (e) {
      L.warn(`[collector] backfill ${gid} error:`, e.message);
    }
    L.info(`[collector] backfill ${gid}: pulled ${pulled} messages`);
    return pulled;
  }

  // ---------- 公告轮询 ----------
  async refreshAnnouncements(gid) {
    if (!safeGid(gid)) { L.warn(`[collector] refreshAnnouncements 非法群号: ${gid}`); return 0; }
    try {
      const anns = await this.client.getGroupAnnouncements(gid);
      if (!anns) return 0;
      const list = Array.isArray(anns) ? anns : (anns.announcements || anns.data || []);
      let added = 0;
      for (const a of list) {
        const time = a.time || a.publish_time || Date.now();
        const text = typeof a.message === "string" ? a.message : (a.message?.text || a.content || a.text || "");
        const record = {
          groupId: String(gid),
          id: String(a.notice_id || a.fid || a.id || a.msg_id || time),
          title: (text || "").slice(0, 60) || "(无标题)",
          content: text,
          publisher: String(a.sender_id || a.publisher?.uin || a.user_id || ""),
          time: new Date(time * 1000).toISOString(),
        };
        const existing = store.listAnnouncements(String(gid));
        if (!existing.some((e) => e.id === record.id)) {
          store.appendAnnouncement(String(gid), record);
          added++;
          this._fireEvent(String(gid), {
            kind: "announcement",
            title: `新公告：${record.title}`,
            text: record.content.slice(0, 200),
            time: record.time,
          });
        }
      }
      return added;
    } catch (e) {
      L.warn(`[collector] refreshAnnouncements ${gid} error:`, e.message);
      return 0;
    }
  }

  stop() {
    this.stopped = true;
  }
}

// ---------- gid 安全校验 ----------
// 群号来自远端 NapCat 或 IPC 参数，必须为纯数字（防路径穿越/注入到 OneBot 请求）
const GID_RE = /^\d{1,20}$/;
function safeGid(gid) {
  const s = String(gid == null ? "" : gid).trim();
  return GID_RE.test(s) ? s : null;
}

// ---------- 消息解析 ----------
function parseMessage(evt) {
  const segs = Array.isArray(evt.message) ? evt.message : [];
  let text = "";
  let atAll = false;
  let atMe = false;
  const mentions = [];
  let images = 0;
  let faces = 0;
  const pushText = (s) => { if (s) text += (text ? " " : "") + s; };
  for (const s of segs) {
    if (!s || !s.type) continue;
    switch (s.type) {
      case "text": pushText(s.data?.text || ""); break;
      case "at":
        if (s.data?.qq === "all") { atAll = true; pushText("@全体成员"); }
        else { mentions.push(String(s.data.qq)); pushText(`@${s.data.qq}`); }
        break;
      case "image": images++; pushText("[图片]"); break;
      case "face": faces++; break;
      case "record": pushText("[语音]"); break;
      case "video": pushText("[视频]"); break;
      case "file": pushText(`[文件]${s.data?.name || ""}`); break;
      case "reply": pushText("[回复]"); break;
      case "json": pushText("[卡片消息]"); break;
      default: break;
    }
  }
  if (evt.raw_message && !text) {
    text = evt.raw_message.replace(/\[CQ:[^\]]+\]/g, " ").trim();
  }
  return { text: text.trim(), atAll, atMe, mentions, images, faces };
}

// ---------- 冲突词打分 ----------
const CONFLICT_WORDS = ["你他妈","傻逼","煞笔","滚","闭嘴","有病","脑残","垃圾","废物","吵什么","别吵","不服","怼","骂","撕","拉黑","退群","举报","服了","无语","呵呵","呵呵呵","好意思","要点脸","不要脸","恶心","烦死","气死"];
function scoreConflict(messages) {
  let score = 0;
  const texts = messages.map((m) => m.text || "");
  for (const t of texts) {
    for (const w of CONFLICT_WORDS) if (t.includes(w)) score++;
  }
  // 高频互相回复也加分
  if (texts.length >= 6) score += 1;
  return score;
}

module.exports = { Collector, parseMessage };

