// renderer/app.js — 渲染层逻辑
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const api = window.sentinelApi;
let state = { groups: [], events: {}, reports: {}, conn: false, currentGroup: null };

// ---------- 工具 ----------
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function groupName(gid) {
  const g = state.groups.find((x) => x.groupId === String(gid));
  return g ? g.name : `群${gid}`;
}

const ENGINE_LABEL = { deepseek: "DeepSeek", ollama: "Ollama", semantic: "本地语义", local: "本地统计" };
function engineBadge(engine) {
  if (!engine || !ENGINE_LABEL[engine]) return "";
  return '<span class="engine-badge" title="总结引擎">' + esc(engine ? ENGINE_LABEL[engine] : "") + "</span>";
}

const KIND_LABEL = {
  at_all: "全体", announcement: "公告", recall: "撤回", admin_change: "管理",
  member_left: "退群", member_joined: "进群", conflict: "冲突", at_me: "提到我",
  daily: "汇总", summary: "汇总", group_notice: "通知", group_essence: "精华", group_poke: "戳一戳", keyword: "关键词",
};

// ---------- 事件渲染 ----------
function renderEvent(evt) {
  const kind = evt.kind || "";
  // 防御：汇总文本中若残留撤回行（旧数据），过滤不显示
  if (evt.summary && /recall/i.test(evt.summary)) {
    evt = Object.assign({}, evt, { summary: evt.summary.split("\n").filter((l) => !/^-\s*\[.*\]\s*recall:/i.test(l)).join("\n") });
  }
  const tag = KIND_LABEL[kind] || kind;
  const body = evt.summary || evt.text || evt.reason || "";
  return `<div class="event-item ${esc(kind)}">
    <div class="event-head">
      <span class="event-title"><span class="event-tag">${esc(tag)}</span>${esc(evt.title || "")}</span>
      <span class="event-time">${fmtTime(evt.time || evt.createdAt)}${engineBadge(evt.engine)}</span>
    </div>
    ${body ? `<div class="event-body">${esc(body)}</div>` : ""}
  </div>`;
}

function fillEvents(el, events, emptyText = "暂无大事记录") {
  events = (events || []).filter((e) => e.kind !== "recall"); // 撤回不是大事，不显示
  if (!events || events.length === 0) {
    el.innerHTML = `<div class="empty">${esc(emptyText)}</div>`;
    return;
  }
  el.innerHTML = events.map(renderEvent).join("");
}

// ---------- 总览 ----------
async function renderOverview() {
  const stats = await api.appStats();
  const gs = stats.groups || [];
  const totalMsgs = gs.reduce((a, g) => a + (g.messages || 0), 0);
  const watched = gs.filter((g) => g.watched).length;
  let recentEvents = [];
  for (const g of gs) {
    const evts = await api.eventsGet(g.groupId, 20);
    recentEvents = recentEvents.concat(evts.filter((e) => e.kind !== "daily"));
  }
  recentEvents.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  recentEvents = recentEvents.slice(0, 30);
  // 热点库状态（多平台缓存）
  let hotTxt = "-";
  try {
    const h = await api.hotspotsStatus();
    if (h && h.cached && h.platforms) {
      const parts = [];
      if (h.platforms.weibo?.count) parts.push(`微博${h.platforms.weibo.count}`);
      if (h.platforms.douyin?.count) parts.push(`抖音${h.platforms.douyin.count}`);
      if (h.platforms.bilibili?.count) parts.push(`B站${h.platforms.bilibili.count}`);
      hotTxt = parts.length ? parts.join(" ") : "热点库空";
    } else if (h && h.cached) hotTxt = `${h.count} 条热点`;
  } catch {}

  $("#overview-stats").innerHTML = `
    <div class="stat-card"><div class="num">${gs.length}</div><div class="lbl">监听群数</div></div>
    <div class="stat-card"><div class="num">${watched}</div><div class="lbl">正在关注</div></div>
    <div class="stat-card"><div class="num">${totalMsgs}</div><div class="lbl">累计消息</div></div>
    <div class="stat-card"><div class="num">${state.conn ? "在线" : "离线"}</div><div class="lbl">机器人连接</div></div>
    <div class="stat-card"><div class="num" style="font-size:13px">${esc(hotTxt)}</div><div class="lbl">热点库</div></div>
  `;
  fillEvents($("#overview-events"), recentEvents);
}

// ---------- 指定爬取群管理 ----------
async function getSpecGroups() {
  try {
    const w = await api.configGet("watch");
    return Array.isArray(w?.groups) ? w.groups.filter(Boolean).map(String) : [];
  } catch { return []; }
}

async function renderSpecGroups() {
  const list = await getSpecGroups();
  const box = $("#spec-list");
  const hint = $("#spec-hint");
  if (!box) return;
  if (list.length === 0) {
    box.innerHTML = '<span class="spec-hint">未指定 → 当前采集全部群（要只采部分：关掉不采的群，或点「从群列表选择」）</span>';
    if (hint) hint.textContent = "提示：指定群后，只有这些群的消息会被采集/汇总，其他群一律不处理。";
    return;
  }
  box.innerHTML = list.map((gid) => (
    '<span class="spec-chip">群 ' + esc(gid) + ' <span class="del" data-del="' + esc(gid) + '" title="移出">✕</span></span>'
  )).join("");
  if (hint) hint.textContent = "已指定 " + list.length + " 个群，其他群不采集。";
  box.querySelectorAll(".del").forEach((d) => {
    d.addEventListener("click", async () => {
      const gid = d.dataset.del;
      const cur = await getSpecGroups();
      const w = await api.configGet("watch") || {};
      await api.configSet("watch", { ...w, groups: cur.filter((g) => g !== gid) });
      toast("已移出群 " + gid);
      renderSpecGroups();
      renderGroups();
    });
  });
}

async function addSpecGroup() {
  const input = $("#spec-gid-input");
  const gid = (input.value || "").trim();
  if (!/^\d+$/.test(gid)) { toast("请输入纯数字群号"); return; }
  const cur = await getSpecGroups();
  if (cur.includes(gid)) { toast("该群已在指定列表中"); return; }
  const w = await api.configGet("watch") || {};
  await api.configSet("watch", { ...w, groups: [...cur, gid] });
  input.value = "";
  toast("已指定群 " + gid + "（只采集该群）");
  renderSpecGroups();
  renderGroups();
}

// ---------- 从群列表选择（小号所在的群 → 勾选要采集的群） ----------
let _pickGroups = [];   // 当前模态框数据 [{groupId,name,memberCount,checked}]
let _pickKeyword = "";  // 搜索关键词

async function openSpecPicker() {
  const modal = $("#spec-pick-modal");
  const listBox = $("#spec-pick-list");
  const hint = $("#spec-pick-hint");
  if (!modal) return;
  listBox.innerHTML = '<div class="spec-pick-empty">正在从小号拉取群列表…</div>';
  if (hint) hint.textContent = "";
  $("#spec-pick-search").value = "";
  $("#spec-pick-count").textContent = "";
  modal.classList.remove("hidden");

  // 拉取小号所在的全部群（只读）
  let res;
  try { res = await api.groupsFromRemote(); } catch (e) { res = { ok: false, error: e?.message || e }; }
  if (!res || !res.ok) {
    listBox.innerHTML = '<div class="spec-pick-empty">❌ 拉取群列表失败：' + esc(res?.error || "未知错误") + '<br><span style="font-size:12px">请确认已连接 NapCat 且小号在线</span></div>';
    return;
  }
  const cur = await getSpecGroups();
  const remote = Array.isArray(res.groups) ? res.groups : [];
  _pickGroups = remote.map((g) => ({
    groupId: String(g.groupId ?? ""),
    name: String(g.name ?? "").trim() || "群" + (g.groupId ?? ""),
    memberCount: Number(g.memberCount || 0),
    checked: cur.includes(String(g.groupId)),
  })).filter((g) => g.groupId);
  if (!_pickGroups.length) {
    listBox.innerHTML = '<div class="spec-pick-empty">小号当前不在任何群中</div>';
    return;
  }
  renderSpecPickList();
}

function renderSpecPickList() {
  const listBox = $("#spec-pick-list");
  const kw = _pickKeyword.trim().toLowerCase();
  const shown = _pickGroups.filter((g) =>
    !kw || g.groupId.includes(kw) || g.name.toLowerCase().includes(kw)
  );
  const checkedCount = _pickGroups.filter((g) => g.checked).length;
  $("#spec-pick-count").textContent = `共 ${_pickGroups.length} 个群，已选 ${checkedCount} 个`;
  if (!shown.length) {
    listBox.innerHTML = '<div class="spec-pick-empty">没有匹配的群</div>';
    return;
  }
  listBox.innerHTML = shown.map((g, i) => `
    <label class="spec-pick-item">
      <input type="checkbox" data-idx="${i}" ${g.checked ? "checked" : ""}>
      <span class="gname">${esc(g.name)}</span>
      <span class="gmeta">${esc(g.groupId)} · ${Number(g.memberCount) || "?"} 人</span>
      ${g.checked ? '<span class="gtag">已指定</span>' : ""}
    </label>
  `).join("");
  // 注意：shown 的索引对应 _pickGroups 的索引（过滤后仍用原索引），点击时同步回 _pickGroups
  listBox.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      const idx = Number(input.dataset.idx);
      if (_pickGroups[idx]) _pickGroups[idx].checked = input.checked;
      renderSpecPickList(); // 刷新计数与"已指定"标签
    });
  });
}

async function applySpecPicker() {
  const picked = _pickGroups.filter((g) => g.checked).map((g) => g.groupId);
  const w = await api.configGet("watch") || {};
  await api.configSet("watch", { ...w, groups: picked });
  closeSpecPicker();
  toast(picked.length ? `已指定 ${picked.length} 个群（只采集这些群）` : "已清空指定群（将采集全部群）");
  renderSpecGroups();
  renderGroups();
}

function closeSpecPicker() {
  const modal = $("#spec-pick-modal");
  if (modal) modal.classList.add("hidden");
  _pickGroups = [];
  _pickKeyword = "";
}

// ---------- 群列表 ----------
async function renderGroups() {
  const gs = await api.groupsList();
  state.groups = gs;
  const wrap = $("#groups-list");
  if (!gs.length) {
    wrap.innerHTML = `<div class="empty">暂无群。连接机器人后自动发现群，或刷新。</div>`;
    return;
  }
  let botsAll = {};
  try { botsAll = (await api.botsGetAll()).bots || {}; } catch {}
  const spec = await getSpecGroups();
  const inSpec = (gid) => spec.length === 0 || spec.includes(String(gid));
  wrap.innerHTML = gs.map((g) => `
    <div class="group-card">
      <label class="watch-toggle switch" title="勾选 = 加入指定爬取群">
        <input type="checkbox" data-gid="${esc(g.groupId)}" ${inSpec(g.groupId) ? "checked" : ""}>
        <span class="slider"></span>
      </label>
      <div class="gname">${esc(g.name)}</div>
      <div class="gmeta">群号 ${esc(g.groupId)} · ${Number(g.memberCount) || "?"} 人</div>
      <div class="gstat">${Number(g.messages) || 0} 条消息 · 最近 ${fmtTime(g.lastActive) || "-"}</div>
      ${(botsAll[String(g.groupId)] || []).length ? `<div class="gbots">🤖 机器人：${(botsAll[String(g.groupId)] || []).map((b) => esc(b.nickname)).join("、")}</div>` : ""}
    </div>
  `).join("");
  $$("#groups-list .switch input").forEach((input) => {
    input.addEventListener("change", async () => {
      const gid = String(input.dataset.gid || "");
      try {
        const cur = await getSpecGroups(); // [] = 采集全部
        const w = await api.configGet("watch") || {};
        if (input.checked) {
          // 开：把该群加入白名单
          const next = cur.includes(gid) ? cur : [...cur, gid];
          await api.configSet("watch", { ...w, groups: next });
          toast(cur.length === 0 ? "已只采集群 " + gid + "（其余群停止）" : "已指定群 " + gid + "（开始采集）");
        } else {
          // 关：必须显式落白名单（空=全部，不能靠"移除"表达"排除一个"）
          const allIds = (state.groups || []).map((g) => String(g.groupId));
          const base = cur.length ? cur : allIds;          // 空=全部 → 以可见全部群为基线
          const next = base.filter((x) => x !== gid);
          if (next.length === 0) {
            // 排除最后一个群会退回"全部"语义 → 与用户意图相反，阻止并说明
            input.checked = true; // 还原开关
            toast("不能取消最后一个群：清空指定=采集全部。请改用「从群列表选择」明确要采集的群");
            renderGroups();
            return;
          }
          await api.configSet("watch", { ...w, groups: next });
          toast("已停止采集群 " + gid + "（其余 " + next.length + " 个群继续）");
        }
        renderSpecGroups();
        renderGroups(); // 刷新各开关状态，避免"看似全选"的错觉
      } catch (e) {
        toast("设置失败：" + (e?.message || e));
      }
    });
  });
  // 填充下拉
  fillGroupSelects();
}

$("#btn-scan-bots").addEventListener("click", async () => {
  toast("正在检测各群机器人…");
  const r = await api.botsScan();
  if (r && r.ok) {
    const n = Object.values(r.all || {}).reduce((s, arr) => s + arr.length, 0);
    toast("✅ 检测完成，共标注 " + n + " 个机器人");
    renderGroups();
  } else {
    toast("检测失败：" + ((r && r.error) || "未知"));
  }
});

function fillGroupSelects() {
  const opts = state.groups.map((g) => `<option value="${esc(g.groupId)}">${esc(g.name)}</option>`).join("");
  $("#timeline-group").innerHTML = opts;
  $("#report-group").innerHTML = opts;
  if (state.currentGroup) {
    $("#timeline-group").value = state.currentGroup;
    $("#report-group").value = state.currentGroup;
  }
}

// ---------- 时间线 ----------
async function renderTimeline() {
  const gid = $("#timeline-group").value;
  if (!gid) { $("#timeline-events").innerHTML = `<div class="empty">请先选择一个群</div>`; return; }
  state.currentGroup = gid;
  const evts = await api.eventsGet(gid, 200);
  fillEvents($("#timeline-events"), evts, "该群暂无大事记录");
}

// ---------- 报告 ----------
// datetime-local 值（本地时间）→ ISO 字符串（UTC），带时区偏移，保证语义正确
function dtLocalToISO(v) {
  if (!v) return null;
  const d = new Date(v); // 浏览器会把 "YYYY-MM-DDTHH:mm" 当本地时间解析
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function renderReports() {
  const gid = $("#report-group").value;
  if (!gid) { $("#report-list").innerHTML = `<div class="empty">请先选择一个群</div>`; return; }
  state.currentGroup = gid;
  const evts = await api.eventsGet(gid, 500);
  const reports = evts.filter((e) => e.kind === "daily" || e.kind === "summary" || e.kind === "conflict");
  fillEvents($("#report-list"), reports, "暂无汇总报告，点击「默认汇总」或选择时段生成");
}

// ---------- 连接状态 ----------
async function refreshStatus() {
  const st = await api.botStatus();
  state.conn = st.connected;
  const el = $("#conn-status");
  if (st.connected) {
    el.textContent = `已连接 ${st.selfId ? `(${st.selfId})` : ""}`;
    el.classList.add("on");
    $("#btn-connect").textContent = "断开";
  } else {
    el.textContent = "未连接";
    el.classList.remove("on");
    $("#btn-connect").textContent = "连接";
  }
}

// ---------- 设置加载/保存 ----------
async function loadSettings() {
  const d = await api.configGet("deepseek");
  const n = await api.configGet("napcat");
  const w = await api.configGet("watch");
  const s = await api.configGet("summarize");
  const h = await api.configGet("hotspots");
  const o = await api.configGet("ocr");
  const nt = await api.configGet("notify");
  const llm = await api.configGet("ollama");
  const sm = await api.configGet("summarize");
  const mo = await api.configGet("monitor");
  $("#set-ds-key").value = d.apiKey || "";
  $("#set-ds-model").value = d.model || "";
  $("#set-ds-base").value = d.baseUrl || "";
  if (sm) $("#set-summary-mode").value = sm.mode || "auto";
  if (llm) {
    $("#set-ollama-enabled").checked = llm.enabled !== false;
    $("#set-ollama-url").value = llm.url || "http://127.0.0.1:11434";
    $("#set-ollama-model").value = llm.model || "qwen2.5:7b";
  }
  $("#set-mode").value = n.mode || "forward";
  $("#set-ws-url").value = n.wsUrl || "";
  $("#set-reverse-port").value = n.reversePort || 3002;
  $("#set-token").value = n.token || "";
  $("#set-history-days").value = w.collectHistoryDays ?? 3;
  $("#set-daily-hour").value = s.dailyHour ?? 22;
  if (mo) {
    $("#set-announce-min").value = mo.announcePollMinutes ?? 60;
    $("#set-api-interval").value = mo.apiMinIntervalMs ?? 250;
    $("#set-botscan-auto").checked = !!mo.botScanAuto;
    $("#set-botscan-hours").value = mo.botScanHours ?? 24;
    $("#set-botscan-hours").disabled = !mo.botScanAuto;
  }
  $("#set-default-days").value = s.defaultDays ?? 7;
  $("#set-groups").value = (w.groups || []).join(",");
  $("#set-history-days").min = 0;
  $("#set-qq-path").value = n.qqPath || "";
  $("#set-data-dir").value = n.dataDir || "D:\\QQNT-MULTI-DATA";
  $("#set-conflicts").checked = !!s.includeConflicts;
  $("#set-auto-ignore-bots").checked = s.autoIgnoreBots !== false;
  $("#set-conflict-win").value = s.conflictWindowMin ?? 10;
  $("#set-conflict-min").value = s.conflictMessageMin ?? 8;
  $("#set-hotspots").checked = h.enabled !== false;
  $("#set-hotspots-cache").value = h.cacheMinutes ?? 15;
  $("#set-ocr-url").value = (o && o.bridgeUrl) || "http://127.0.0.1:8765";
  $("#set-ocr-token").value = (o && o.bridgeToken) || "";
  if (nt) {
    $("#set-notify-enabled").checked = nt.enabled !== false;
    $("#set-notify-atall").checked = nt.atAll !== false;
    $("#set-notify-ann").checked = nt.announcement !== false;
    $("#set-notify-conflict").checked = nt.conflict !== false;
    $("#set-notify-daily").checked = nt.daily !== false;
    $("#set-notify-focus").checked = nt.focusSilent !== false;
  }
  const hp = h.platforms || ["weibo", "douyin", "bilibili"];
  $("#set-hot-weibo").checked = hp.includes("weibo");
  $("#set-hot-douyin").checked = hp.includes("douyin");
  $("#set-hot-bilibili").checked = hp.includes("bilibili");
  // 启动相关：开机自启状态（注册表）、NapCat 自动启动
  try {
    const as = await api.autostartGet();
    $("#set-autostart").checked = !!(as && as.enabled);
    $("#set-auto-launch-napcat").checked = n.autoLaunch !== false;
  } catch {}
}

async function saveSettings() {
  await api.configSet("deepseek", {
    apiKey: $("#set-ds-key").value.trim(),
    model: $("#set-ds-model").value.trim() || "deepseek-chat",
    baseUrl: $("#set-ds-base").value.trim() || "https://api.deepseek.com",
  });
  await api.configSet("napcat", {
    mode: $("#set-mode").value,
    wsUrl: $("#set-ws-url").value.trim() || "ws://127.0.0.1:3001",
    reversePort: parseInt($("#set-reverse-port").value, 10) || 3002,
    token: $("#set-token").value.trim(),
    autoLaunch: $("#set-auto-launch-napcat").checked,
    qqPath: $("#set-qq-path").value.trim(),
    dataDir: $("#set-data-dir").value.trim() || "D:\\QQNT-MULTI-DATA",
  });
  // 开机自启写注册表
  try {
    const as = await api.autostartSet($("#set-autostart").checked);
    if (!as.ok) toast("开机自启设置失败：" + (as.error || ""));
  } catch {}

  await api.configSet("watch", {
    collectHistoryDays: parseInt($("#set-history-days").value, 10) || 3,
    groups: $("#set-groups").value.split(",").map((s) => s.trim()).filter(Boolean),
  });
  await api.configSet("monitor", {
    announcePollMinutes: parseInt($("#set-announce-min").value, 10) || 60,
    apiMinIntervalMs: parseInt($("#set-api-interval").value, 10) || 250,
    botScanAuto: $("#set-botscan-auto").checked,
    botScanHours: parseInt($("#set-botscan-hours").value, 10) || 24,
  });
  await api.configSet("summarize", {
    dailyHour: parseInt($("#set-daily-hour").value, 10) || 22,
    defaultDays: parseInt($("#set-default-days").value, 10) || 7,
    mode: $("#set-summary-mode").value,
    includeConflicts: $("#set-conflicts").checked,
    conflictWindowMin: parseInt($("#set-conflict-win").value, 10) || 10,
    conflictMessageMin: parseInt($("#set-conflict-min").value, 10) || 8,
    autoIgnoreBots: $("#set-auto-ignore-bots").checked,
  });
  await api.configSet("ocr", {
    bridgeUrl: $("#set-ocr-url").value.trim() || "http://127.0.0.1:8765",
    bridgeToken: $("#set-ocr-token").value.trim(),
  });
  await api.configSet("hotspots", {
    enabled: $("#set-hotspots").checked,
    cacheMinutes: parseInt($("#set-hotspots-cache").value, 10) || 15,
    platforms: ["weibo", "douyin", "bilibili"].filter((p) => {
      const el = { weibo: $("#set-hot-weibo"), douyin: $("#set-hot-douyin"), bilibili: $("#set-hot-bilibili") }[p];
      return el && el.checked;
    }),
  });
  await api.configSet("notify", {
    enabled: $("#set-notify-enabled").checked,
    atAll: $("#set-notify-atall").checked,
    announcement: $("#set-notify-ann").checked,
    conflict: $("#set-notify-conflict").checked,
    daily: $("#set-notify-daily").checked,
    focusSilent: $("#set-notify-focus").checked,
  });
  await api.configSet("ollama", {
    enabled: $("#set-ollama-enabled").checked,
    url: $("#set-ollama-url").value.trim() || "http://127.0.0.1:11434",
    model: $("#set-ollama-model").value.trim() || "qwen2.5:7b",
  });
  const hint = $("#settings-saved");
  hint.textContent = "✓ 已保存";
  hint.classList.add("show");
  setTimeout(() => { hint.textContent = ""; hint.classList.remove("show"); }, 2000);
  toast("设置已保存");
}

// ---------- NapCat 状态 ----------
async function renderNapcat() {
  const st = await api.napcatStatus();
  const el = $("#napcat-status");
  el.innerHTML = `
    <div class="stat-cards" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      <div class="stat-card"><div class="num">${st.installed ? "✅" : "❌"}</div><div class="lbl">已安装</div></div>
      <div class="stat-card"><div class="num">${st.running ? "▶️" : "⏸️"}</div><div class="lbl">运行中</div></div>
      <div class="stat-card"><div class="num">${st.installing ? "…" : "-"}</div><div class="lbl">安装中</div></div>
    </div>
    <div style="margin-top:10px;font-size:12.5px;color:var(--muted)">
      安装目录：<code>${esc(st.dir)}</code><br>
      模式：<code>${esc(st.mode || "injector")}</code>（注入器 ${st.injectorReady ? "✅" : "❌ 缺失，回退官方启动器"}）<br>
      QQ 路径：<code>${esc(st.qqPath || "未探测到")}</code><br>
      小号独立数据目录：<code>${esc(st.dataDir || "-")}</code>
    </div>
  `;
}

// ---------- 导航 ----------
function switchTab(tab) {
  state.activeTab = tab; // 记录当前 tab（bot:event 据此刷新总览）
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  if (tab === "overview") renderOverview();
  if (tab === "groups") { renderSpecGroups(); renderGroups(); }
  if (tab === "timeline") renderTimeline();
  if (tab === "reports") { initReportPeriod(); renderReports(); renderKwBar(); }
  if (tab === "napcat") renderNapcat();
  if (tab === "settings") loadSettings();
}

// 初始化自定义时段默认值：开始=7天前 0 点，结束=今天现在（本地时间）
function initReportPeriod() {
  const since = $("#summary-since");
  const until = $("#summary-until");
  if (!since || !until) return;
  if (since.value && until.value) return; // 已设置过则保留
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const fmtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  since.value = fmtLocal(weekAgo);
  until.value = fmtLocal(now);
}

// ---------- 事件绑定 ----------
  // 关键词命中记录模态框
  async function openKwHits() {
    const gid = $("#timeline-group").value;
    if (!gid) { toast("请先在时间线选择群"); return; }
    const box = $("#kw-hits-list");
    const hint = $("#kw-hits-hint");
    if (box) box.innerHTML = '<div class="empty">加载中…</div>';
    if (hint) hint.textContent = "";
    const hits = await api.kwHitsList(gid, 500);
    const list = Array.isArray(hits) ? hits : [];
    $("#kw-hits-modal").classList.remove("hidden");
    if (!list.length) {
      if (box) box.innerHTML = '<div class="empty">该群暂无关键词命中记录（先在设置页添加关键词）</div>';
      return;
    }
    if (box) box.innerHTML = list.map((h) => `
      <div class="event-item kw-hit">
        <div class="event-head">
          <span class="event-title"><span class="event-tag">关键词</span>🔑 ${esc((h.words || []).join("、"))}</span>
          <span class="event-time">${fmtTime(h.time || h.savedAt)}</span>
        </div>
        <div class="event-body">${esc((h.nickname ? h.nickname + "：" : "") + (h.text || ""))}</div>
      </div>`).join("");
    if (hint) hint.textContent = "共 " + list.length + " 条（最近 " + list.length + " 条）";
  }
  function closeKwHits() { $("#kw-hits-modal").classList.add("hidden"); }
  $("#btn-kw-hits").addEventListener("click", openKwHits);

  // 报告页：监控词管理条
  async function getKwList() {
    const w = await api.configGet("watch");
    return Array.isArray(w && w.keywords) ? w.keywords.filter(Boolean).map(String) : [];
  }
  async function renderKwBar() {
    const chips = $("#kw-chips");
    if (!chips) return;
    const list = await getKwList();
    if (!list.length) { chips.innerHTML = '<span class="spec-hint">未设置 → 先在上方输入监控词并点“添加”</span>'; return; }
    chips.innerHTML = list.map((k) =>
      '<span class="spec-chip">🔑 ' + esc(k) + ' <span class="del" data-del="' + esc(k) + '" title="移除监控词">✕</span></span>'
    ).join("");
    chips.querySelectorAll(".del").forEach((d) => d.addEventListener("click", async () => {
      const kw = d.dataset.del;
      const w = await api.configGet("watch") || {};
      await api.configSet("watch", { ...w, keywords: (Array.isArray(w.keywords) ? w.keywords : []).filter((x) => String(x) !== kw) });
      toast("已移除监控词：" + kw);
      renderKwBar();
    }));
  }
  async function addKwWord() {
    const input = $("#kw-add-input");
    const word = (input.value || "").trim();
    if (!word) { toast("请输入关键词"); return; }
    const w = await api.configGet("watch") || {};
    const cur = Array.isArray(w.keywords) ? w.keywords.map(String) : [];
    if (cur.some((x) => x.toLowerCase() === word.toLowerCase())) { toast("该词已在监控列表"); return; }
    await api.configSet("watch", { ...w, keywords: [...cur, word] });
    input.value = "";
    toast("已添加监控词：" + word + "（命中即重点记录）");
    renderKwBar();
  }
  $("#btn-kw-add").addEventListener("click", addKwWord);
  $("#kw-add-input").addEventListener("keydown", (ev) => { if (ev.key === "Enter") addKwWord(); });
function bind() {
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  $("#btn-connect").addEventListener("click", async () => {
    if (state.conn) {
      await api.botDisconnect();
      toast("已断开");
      refreshStatus();
      return;
    }
    toast("正在连接…");
    const r = await api.botConnect();
    if (r && r.ok === false) {
      // 连接被拒绝（如 NapCat 未安装）：显示具体原因
      toast("❌ " + (r.error || "连接失败"), 6000);
      if (r.needNapcat) {
        setTimeout(() => { toast("提示：请先在「NapCat」页下载安装 NapCat 并扫码登录", 6000); }, 200);
      }
    } else {
      toast("已发起连接，等待 NapCat 响应…");
      setTimeout(refreshStatus, 1500);
    }
  });

  // 连接过程反馈
  api.on("bot:connecting", (p) => { if (p?.hint) toast(p.hint, 4000); });
  api.on("bot:connect-failed", (p) => {
    toast("❌ " + (p?.error || "连接失败"), 8000);
    refreshStatus();
  });

  $("#btn-summarize").addEventListener("click", async () => {
    toast("正在汇总全部群…");
    const r = await api.summaryAll();
    if (r.ok) toast(`汇总完成：${r.results.filter((x) => x.ok).length}/${r.results.length} 个群成功`);
    else toast("汇总失败：" + (r.error || ""));
    if (state.activeTab === "reports") renderReports();
  });

  $("#btn-refresh-groups").addEventListener("click", async () => {
    toast("刷新群列表…");
    await api.botStatus();
    await renderGroups();
  });

  $("#btn-ocr-images").addEventListener("click", async () => {
  const gid = $("#timeline-group").value;
  if (!gid) { toast("请先选择一个群"); return; }
  const limit = parseInt($("#ocr-img-limit").value, 10) || 10;
  toast("正在拉取群图并调用图片识别工具…");
  const r = await api.ocrGroupImages({ gid, limit });
  if (r && r.ok) {
    toast(r.total ? "✅ 识别 " + r.okCount + "/" + r.total + " 张，结果已写入时间线" : (r.note || "无图片"));
    renderTimeline();
  } else {
    toast("识别失败：" + ((r && r.error) || "未知"));
  }
});

$("#btn-ocr-ping").addEventListener("click", async () => {
  const r = await api.ocrPing();
  $("#ocr-ping-hint").textContent = r && r.ok ? "✅ 图片识别服务在线" + (r.tokenFound ? "（令牌已就绪）" : "（未找到令牌，请设置）") : "❌ " + ((r && r.error) || "连接失败");
});

$("#btn-open-imgocr").addEventListener("click", async () => {
  const r = await api.hubOpenImgocr();
  toast(r && r.ok ? "已打开图片识别工具" : "打开失败：" + ((r && r.error) || ""));
});

$("#btn-backfill").addEventListener("click", async () => {
    const gid = $("#timeline-group").value;
    if (!gid) { toast("请先选择一个群"); return; }
    const days = parseInt($("#backfill-days").value, 10) || 3;
    toast(`正在回拉群 ${gid} 历史（${days} 天）…`);
    const r = await api.backfill(gid, days);
    toast(`回拉完成：${r.pulled} 条`);
    renderTimeline();
  });

  $("#btn-backfill-all").addEventListener("click", async () => {
    const days = parseInt($("#backfill-days").value, 10) || 3;
    toast(`正在回拉全部指定群历史（${days} 天）…`);
    const r = await api.backfillAll(days);
    const okN = (r.results || []).filter((x) => x.pulled > 0).length;
    const total = (r.results || []).reduce((s, x) => s + (x.pulled || 0), 0);
    toast(`回拉完成：${okN}/${(r.results || []).length} 个群，共 ${total} 条`);
    renderTimeline();
    renderGroups();
  });

  // 默认汇总：窗口 = max(上次汇总时间, 现在-默认天数) → 现在
  $("#btn-summary-default").addEventListener("click", async () => {
    const gid = $("#report-group").value;
    if (!gid) { toast("请先选择一个群"); return; }
    toast("正在默认汇总（一周/上次起）…");
    const r = await api.summaryRun(gid, { mode: "default" });
    if (r.ok) { toast("汇总完成：" + (r.stats?.messages || 0) + " 条消息"); renderReports(); }
    else toast("失败：" + (r.error || ""));
  });

  // 自定义时段汇总（单群）
  $("#btn-summary-period").addEventListener("click", async () => {
    const gid = $("#report-group").value;
    if (!gid) { toast("请先选择一个群"); return; }
    const since = dtLocalToISO($("#summary-since").value);
    const until = dtLocalToISO($("#summary-until").value);
    if (!since || !until) { toast("请选择开始和结束时间"); return; }
    toast("正在汇总该时段…");
    const r = await api.summaryRun(gid, { mode: "period", since, until });
    if (r.ok) { toast(`汇总完成（${r.stats?.messages || 0} 条消息）`); renderReports(); }
    else toast("失败：" + (r.error || ""));
  });

  // 自定义时段汇总（全部指定群）
  $("#btn-summary-period-all").addEventListener("click", async () => {
    const since = dtLocalToISO($("#summary-since").value);
    const until = dtLocalToISO($("#summary-until").value);
    if (!since || !until) { toast("请选择开始和结束时间"); return; }
    toast("正在为全部指定群汇总该时段…");
    const r = await api.summaryAll({ mode: "period", since, until });
    const okN = (r.results || []).filter((x) => x.ok).length;
    toast(`完成：${okN}/${(r.results || []).length} 个群`);
    renderReports();
  });

  $("#btn-napcat-launch").addEventListener("click", async () => {
    const r = await api.napcatLaunch();
    toast(r.ok ? "NapCat 已启动" : (r.error || "启动失败"));
    setTimeout(renderNapcat, 1000);
  });
  $("#btn-napcat-install").addEventListener("click", async () => {
    toast("开始下载安装 NapCat…（约几十 MB，请稍候）");
    const r = await api.napcatInstall({});
    if (r.ok) toast(`安装完成：${r.tag}`);
    else toast("安装失败：" + (r.error || ""));
    renderNapcat();
  });
  $("#btn-napcat-logs").addEventListener("click", async () => {
  const r = await api.napcatLogs();
  toast(r && r.ok ? "已打开 NapCat 日志目录" : (r && r.error) || "打开失败");
});

$("#btn-qr-show").addEventListener("click", async () => {
  const r = await api.qrShow();
  toast(r && r.opened ? "已打开登录二维码" : "未检测到登录二维码（NapCat 可能已登录）");
});

$("#btn-napcat-stop").addEventListener("click", async () => {
    await api.napcatStop();
    toast("已停止");
    renderNapcat();
  });

  $("#btn-spec-add").addEventListener("click", addSpecGroup);
  $("#spec-gid-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSpecGroup(); } });
  $("#btn-spec-pick").addEventListener("click", openSpecPicker);
  $("#btn-spec-pick-close").addEventListener("click", closeSpecPicker);
  $("#btn-spec-pick-apply").addEventListener("click", applySpecPicker);
  $("#spec-pick-search").addEventListener("input", (e) => { _pickKeyword = e.target.value; renderSpecPickList(); });
  $("#spec-pick-modal").addEventListener("click", (e) => { if (e.target.id === "spec-pick-modal") closeSpecPicker(); });
  $("#timeline-group").addEventListener("change", renderTimeline);
  $("#report-group").addEventListener("change", renderReports);
  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#set-botscan-auto").addEventListener("change", () => { $("#set-botscan-hours").disabled = !$("#set-botscan-auto").checked; });

  // 导出报告（.md / .json）
  async function doExport(format) {
    const gid = $("#report-group").value;
    if (!gid) { toast("请先选择群"); return; }
    const since = $("#summary-since").value ? dtLocalToISO($("#summary-since").value) : undefined;
    const until = $("#summary-until").value ? dtLocalToISO($("#summary-until").value) : undefined;
    const hint = $("#export-hint");
    if (hint) { hint.textContent = "导出中…"; hint.classList.add("show"); }
    const r = await api.reportExport({ gid, format, since, until });
    if (hint) setTimeout(() => { hint.textContent = ""; hint.classList.remove("show"); }, 2500);
    if (r && r.ok) toast("✅ 已导出：" + r.path, 5000);
    else if (r && r.canceled) toast("已取消导出");
    else toast("❌ 导出失败：" + ((r && r.error) || "未知错误"), 4000);
  }
  $("#btn-export-md").addEventListener("click", () => doExport("md"));
  $("#btn-export-json").addEventListener("click", () => doExport("json"));



  $("#btn-kw-hits-close").addEventListener("click", closeKwHits);



  // 实时事件
  api.on("bot:connected", () => { toast("✅ 机器人已连接"); refreshStatus(); });
  api.on("bot:disconnected", () => { toast("❌ 连接断开（将自动重连）"); refreshStatus(); });
  api.on("bot:risk", (p) => {
    const m = (p && p.message) || "";
    toast("⚠️ 疑似风控：主动拉取已自动暂停。建议停止小号操作并降低频率。" + (m ? "（" + m + "）" : ""), 8000);
    const el = $("#conn-status");
    if (el) { el.textContent = "⚠️ 风控暂停"; el.classList.remove("on"); }
  });
  api.on("bot:reconnecting", (p) => {
    const n = p?.attempt || 1;
    const el = $("#conn-status");
    if (el) { el.textContent = `重连中…(第${n}次)`; el.classList.remove("on"); }
    if (n === 1 || n % 5 === 0) toast(`⚠️ 正在自动重连（第${n}次）…`, 3000);
  });
  api.on("groups:updated", () => { renderGroups(); renderOverview(); });
  api.on("bots:updated", () => { renderGroups(); });
  api.on("summary:done", () => { renderReports(); });
  api.on("bot:event", (evt) => {
    // 实时事件只更新总览（避免频繁重绘）
    if (state.activeTab === "overview") renderOverview();
  });
}

// ---------- 防护层：全局错误守卫 ----------
window.addEventListener("error", (e) => {
  console.error("[app] 未捕获错误:", e.message);
  try { toast("界面异常：" + (e.message || "未知"), 4000); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[app] 未处理 Promise 拒绝:", e.reason instanceof Error ? e.reason.message : String(e.reason));
});


// ---------- 更新日志 ----------
const CHANGELOG_TEXT = `v0.4.0（2026-09）本地语义总结 + 关键词监控
🆕 本地语义总结：无 Key/无 Ollama 时用内置轻量模型（约129MB）做语义聚类要点总结，全离线免费；引擎显示“本地语义”
🆕 关键词监控：报告页设置监控词，命中→时间线重点事件+逐条存档；每份报告自带“关键词命中”统计
🆕 汇总报告按日分窗、复读提示、引擎标识

v0.3.0（2026-09）整理完善
🆕 测试体系：node:test 单元测试 53 项 + npm test（config 加固/只读护栏/存储/机器人/重连/Ollama/导出）
🆕 配置加固：schema 校验与越界钳制、外部修改热读 reload()、保存前 .bak 备份、合并防原型污染
🆕 连接韧性：断线自动重连（指数退避+抖动，界面显示第 n 次重连）
🆕 系统通知：@全体/公告/冲突/每日汇总 系统托盘通知，可开关、窗口聚焦免打扰
🆕 本地 AI：Ollama 支持（无 DeepSeek Key 也能 AI 汇总/判冲突，引擎可选 auto/deepseek/ollama/local）
🆕 报告导出：Markdown / JSON 导出当前群时段大事与消息样本
🔧 构建：引入 electron-builder 配置（npm run dist），保留 electron-packager 兼容全家桶流程

v0.2.0（2026-08-19）全家桶发布
🆕 全家桶整合：大事汇总器 + 图片识别 + NapCat 一个安装包，互相调用
🆕 免责声明：安装前 + 首次强制确认；协议中心（免责/用户协议/隐私/开源许可）
🆕 二维码登录：自动弹 Windows Photos + 风险警告（用小号）+ 登录后自动关闭
🆕 机器人检测：自动标注 is_robot 成员并忽略其刷屏
🆕 本地统计汇总：无 DeepSeek 自动降级（统计+关键词+活跃成员）
🆕 OCR 互调桥：大事汇总器识别群图 → 图片识别本地 OCR（令牌鉴权）
🆕 后台运行：图片识别隐藏驻留托盘，自动拉起大事汇总器（第一眼）
🆕 首次引导 + 帮助中心 + 一键安装脚本
🔒 安全加固：IPC 发送方校验 / 路径白名单 / XSS 转义 / 日志脱敏
✅ 修复：启动崩溃（safeHandle 递归）、控制台窗口、撤回忽略、打包 NapCat 依赖

v0.1.0（2026-08）图片识别工具
本地 OCR（离线中英文）、JSONL 存档 + 全文搜索、NapCat 群图拉取、DeepSeek 总结（可选）`;
$("#btn-changelog").addEventListener("click", () => { $("#changelog-body").textContent = CHANGELOG_TEXT; $("#changelog-modal").classList.remove("hidden"); });
$("#btn-changelog-close").addEventListener("click", () => { $("#changelog-modal").classList.add("hidden"); });

// ---------- 免责声明与协议（全家桶：大事汇总器为第一入口） ----------
const DISCLAIMER_TEXT =
"图片识别工具全家桶（图片识别 + 大事汇总器 + NapCat）\n" +
"安装免责声明与使用须知\n\n" +
"【使用前必读】使用即表示您已阅读并同意以下全部内容：\n\n" +
"1. 用途声明\n本软件仅用于个人学习、研究与日常信息整理。使用者应遵守《腾讯软件许可及服务协议》、QQ 平台规则及所在国家/地区的法律法规。\n\n" +
"2. 账号风险\n软件需要登录一个 QQ 账号（强烈建议使用专门的小号）以读取群消息。登录后该账号可读取所监控群的全部消息，并可能触发 QQ 官方风控，存在限制登录、封号等风险。由此产生的任何后果由使用者自行承担，开发者不承担任何责任。\n\n" +
"3. 隐私与数据\n消息采集与总结默认完全在本机进行：消息记录、事件、关键词命中、配置与机器人名单均保存在本机用户目录。联网仅发生在以下可选场景——① 热点库：拉取微博/抖音/B站公开热榜作为汇总背景；② AI 总结：仅当您主动配置 DeepSeek API Key 或本机运行 Ollama 时，才会把文本发送到对应服务；③ 内置“本地语义总结”使用随包离线模型，不联网、不上传任何消息。使用者应对自行配置监控内容所涉及的个人信息负责，并妥善保管本机数据。\n\n" +
"4. 第三方组件\n本软件内置 NapCat（MIT）、Tesseract OCR（Apache-2.0）、@xenova/transformers 与内置语义模型（Apache-2.0）等第三方组件，其行为与更新不受本项目控制。\n\n" +
"5. 无担保与免责\n本软件按“现状”提供，不提供任何明示或默示担保。因使用本软件造成的任何直接或间接损失（包括但不限于账号损失、数据丢失、法律纠纷），开发者概不负责。\n\n" +
"6. 禁止用途\n禁止将本软件用于任何非法目的，包括但不限于入侵、骚扰、侵犯他人隐私、批量骚扰等。";

const AGREEMENTS = [
  { t: "免责声明", html: "<pre style=\"white-space:pre-wrap;font-family:inherit;font-size:12.5px;line-height:1.7;margin:0\">" + DISCLAIMER_TEXT + "</pre>" },
  { t: "用户协议", html:
    "<ol style=\"padding-left:18px\"><li>本软件按“现状”提供，不保证持续可用、无错误或无中断。</li>" +
    "<li>您仅可将本软件用于合法、合规的个人用途；不得用于任何违反法律法规或 QQ 平台规则的行为。</li>" +
    "<li>您对使用本软件的行为及后果（含登录账号）负全部责任。</li>" +
    "<li>开发者有权随时更新、修改或停止本软件，恕不另行通知。</li>" +
    "<li>卸载本软件即视为终止本协议；本机留存的数据由您自行处置。</li></ol>" },
  { t: "隐私政策", html:
    "<p><b>本地存储</b>：识别结果、消息记录、大事事件、关键词命中记录、配置、机器人名单等全部保存在本机用户目录（%APPDATA%\\qq-sentinel 等），不会上传。</p>" +
    "<p><b>联网场景（默认关闭/可选）</b>：① 热点库：拉取微博/抖音/B站公开热榜用于汇总背景（可在设置关闭）；② DeepSeek API 总结：仅当您配置 Key 时发送文本；③ 本机 Ollama：仅当您配置本机地址时发送文本；④ 内置“本地语义总结”随包离线运行，不联网。</p>" +
    "<p><b>日志脱敏</b>：本地日志会自动隐藏 API Key、Token 等敏感信息。</p>" +
    "<p><b>第三方</b>：NapCat 与 QQ 之间的通信受腾讯协议约束，相关内容请查阅腾讯官方声明。</p>" },
  { t: "开源与第三方许可", html:
    "<p>本软件基于以下开源项目构建，各自按对应许可发布：</p>" +
    "<ul style=\"padding-left:18px\"><li><b>Electron</b> — MIT</li><li><b>tesseract.js / tesseract.js-core</b> — Apache-2.0</li><li><b>ws</b> — MIT</li><li><b>express</b> — MIT</li><li><b>NapCatQQ</b> — MIT</li><li><b>@xenova/transformers（本地语义引擎）</b> — Apache-2.0</li><li><b>paraphrase-multilingual-MiniLM-L12-v2（内置语义模型）</b> — Apache-2.0</li><li><b>tessdata 语言模型（eng/chi_sim）</b> — Apache-2.0</li></ul>" +
    "<p class=\"hint\">完整许可文本见各项目官方仓库。</p>" },
];

function renderAgreements() {
  $("#agreements-body").innerHTML = AGREEMENTS.map((s) =>
    "<details style=\"border:1px solid var(--border);border-radius:6px;margin-bottom:8px;padding:8px 10px\"><summary style=\"cursor:pointer;font-weight:600\">" + esc(s.t) + "</summary><div style=\"margin-top:6px;font-size:12.5px;color:#555;line-height:1.7\">" + s.html + "</div></details>"
  ).join("");
}
function openAgreements() { renderAgreements(); $("#agreements-modal").classList.remove("hidden"); }
function closeAgreements() { $("#agreements-modal").classList.add("hidden"); }

// ---------- 快速上手（首次同意免责后出现一次；帮助中心可再次打开） ----------
const ONBOARD_HTML = [
  "<p style=\"margin:0 0 8px\"><b>1️⃣ 连接与选群</b></p><ul style=\"margin:0 0 12px;padding-left:18px\">" +
  "<li>NapCat 页启动小号并登录；</li>" +
  "<li>在「群列表」勾选要监控的群（勾选=加入指定采集）。</li></ul>",
  "<p style=\"margin:0 0 8px\"><b>2️⃣ 设置关键词（可选）</b></p><ul style=\"margin:0 0 12px;padding-left:18px\">" +
  "<li>在「汇总报告」顶部添加监控词；命中后进时间线并逐条存档，报告自带命中统计。</li></ul>",
  "<p style=\"margin:0 0 8px\"><b>3️⃣ 生成汇总</b></p><ul style=\"margin:0 0 12px;padding-left:18px\">" +
  "<li>「汇总报告」点默认汇总（一周）或选自定义时段；</li>" +
  "<li>无 Key 也会用内置模型做本地语义总结（离线免费）；填 DeepSeek Key 或本机 Ollama 可获得云端/更强总结。</li></ul>",
  "<p style=\"margin:0 0 8px\"><b>4️⃣ 导出与提醒</b></p><ul style=\"margin:0 0 12px;padding-left:18px\">" +
  "<li>报告可导出 Markdown/JSON；设置页可开系统通知（@全体/公告/冲突/每日汇总）。</li></ul>",
  "<p style=\"color:var(--muted);font-size:12px\">设置 → 汇总引擎与本地 AI 可切换 DeepSeek / Ollama / 本地语义 / 本地统计。</p>"
].join("");
function maybeOnboard() {
  try {
    if (localStorage.getItem("qqs-onboard-v1")) return;
    $("#onboard-body").innerHTML = ONBOARD_HTML;
    $("#onboard-modal").classList.remove("hidden");
  } catch {}
}
function closeOnboard() {
  try { localStorage.setItem("qqs-onboard-v1", "1"); } catch {}
  $("#onboard-modal").classList.add("hidden");
}
$("#btn-onboard-ok").addEventListener("click", closeOnboard);
$("#btn-onboard-close").addEventListener("click", closeOnboard);

async function initDisclaimer() {
  try {
    const r = await api.disclaimerStatus();
    if (!r || !r.ok || r.accepted) { maybeOnboard(); return; }
    $("#disclaimer-body").innerHTML = "<pre style=\"white-space:pre-wrap;font-family:inherit;font-size:12.5px;line-height:1.7;margin:0\">" + esc(DISCLAIMER_TEXT) + "</pre>";
    $("#disclaimer-modal").classList.remove("hidden");
  } catch {}
}
$("#btn-agreements").addEventListener("click", openAgreements);
$("#btn-agreements-close").addEventListener("click", closeAgreements);
$("#btn-disclaimer-view").addEventListener("click", openAgreements);
$("#btn-disclaimer-quit").addEventListener("click", () => { try { window.close(); } catch {} });
$("#disclaimer-agree").addEventListener("change", () => {
  $("#btn-disclaimer-ok").disabled = !$("#disclaimer-agree").checked;
});
$("#btn-disclaimer-ok").addEventListener("click", async () => {
  const r = await api.disclaimerAccept();
  if (r && r.ok) { $("#disclaimer-modal").classList.add("hidden"); maybeOnboard(); }
});
// 全家桶页
$("#btn-family-open-imgocr").addEventListener("click", async () => {
  const r = await api.hubOpenImgocr();
  toast(r && r.ok ? "已打开图片识别工具" : "打开失败：" + ((r && r.error) || ""));
});
$("#btn-family-ping").addEventListener("click", async () => {
  const r = await api.ocrPing();
  $("#family-ping-hint").textContent = r && r.ok ? "✅ OCR 服务在线" + (r.tokenFound ? "" : "（未找到令牌）") : "❌ " + ((r && r.error) || "连接失败");
});

// ---------- 启动 ----------
(async function init() {
  try {
    await initDisclaimer();
    bind();
    state.activeTab = "overview";
    await refreshStatus();
    await renderOverview();
    await renderNapcat();
  } catch (e) {
    console.error("[app] 初始化失败:", e);
    try { toast("初始化异常：" + (e?.message || e), 5000); } catch {}
  }
})();

