// renderer/app.js — 渲染层：导入队列、OCR 进度、结果列表、全文搜索、可选 DeepSeek 总结
// 防护：所有注入 DOM 的文本一律转义；所有来自 IPC 的数据视为不可信；输入长度截断。
"use strict";

(function () {
  const api = window.imgocr;
  if (!api) return;

  // ---------- 工具 ----------
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c] || c);
  }
  function cap(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) : s;
  }
  const $ = (id) => document.getElementById(id);
  function fmtTime(ms) {
    if (!ms) return "";
    try {
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch { return ""; }
  }
  function fmtConf(c) {
    if (typeof c !== "number" || !isFinite(c)) return "";
    return Math.round(c * 100) + "%";
  }
  function showMsg(id, text, ms) {
    const elm = $(id);
    if (!elm) return;
    elm.textContent = text;
    if (ms) setTimeout(() => { if (elm.textContent === text) elm.textContent = ""; }, ms);
  }

  // ---------- 状态 ----------
  let pendingPaths = [];
  let batchTotal = 0;
  let batchDone = 0;
  let lastQuery = "";
  let summarizing = new Set();

  // ---------- 队列渲染 ----------
  function renderQueue() {
    const q = $("queue");
    const list = $("queue-list");
    if (!pendingPaths.length) {
      q.hidden = true;
      return;
    }
    q.hidden = false;
    $("queue-count").textContent = "（" + pendingPaths.length + " 张）";
    list.textContent = "";
    const frag = document.createDocumentFragment();
    pendingPaths.slice(0, 200).forEach((p, i) => {
      const name = cap(p.split(/[\\/]/).pop() || p, 120);
      const row = document.createElement("div");
      row.className = "queue-row";
      row.dataset.path = p;
      row.dataset.index = String(i);
      const idx = document.createElement("span");
      idx.className = "q-idx";
      idx.textContent = String(i + 1);
      const nm = document.createElement("span");
      nm.className = "q-name";
      nm.textContent = name;
      nm.title = p;
      const st = document.createElement("span");
      st.className = "q-status";
      st.textContent = "等待";
      row.appendChild(idx);
      row.appendChild(nm);
      row.appendChild(st);
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  function setQueueRowStatus(index, text) {
    const row = document.querySelector('#queue-list .queue-row[data-index="' + String(index) + '"]');
    if (row) row.querySelector(".q-status").textContent = text;
  }

  // ---------- 结果渲染 ----------
  function renderResults(entries) {
    const list = $("result-list");
    list.textContent = "";
    if (!entries || !entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "暂无结果。导入图片后点击「开始识别」。";
      list.appendChild(empty);
      $("result-count").textContent = "（0）";
      return;
    }
    $("result-count").textContent = "（" + entries.length + "）";
    const frag = document.createDocumentFragment();
    entries.forEach((e) => {
      const card = document.createElement("div");
      card.className = "card result";
      card.dataset.id = esc(e.id || "");
      // 头部
      const head = document.createElement("div");
      head.className = "r-head";
      const name = document.createElement("span");
      name.className = "r-name";
      name.textContent = cap(e.fileName || "未命名", 200);
      name.title = e.filePath || "";
      const meta = document.createElement("span");
      meta.className = "r-meta muted";
      const parts = [fmtTime(e.ocrAt || e.addedAt)];
      if (e.confidence != null) parts.push("置信度 " + fmtConf(e.confidence));
      if (e.durationMs) parts.push(cap(e.durationMs, 10) + "ms");
      parts.push(cap((e.languages || []).join("+"), 40));
      meta.textContent = parts.filter(Boolean).join(" · ");
      head.appendChild(name);
      head.appendChild(meta);
      card.appendChild(head);
      // 状态徽章
      const badge = document.createElement("span");
      badge.className = "badge " + esc(e.status || "pending");
      badge.textContent = e.status === "done" ? "已识别" : e.status === "error" ? "失败" : "等待";
      head.appendChild(badge);
      // 分类/总结
      if (e.category) {
        const cat = document.createElement("div");
        cat.className = "r-cat";
        cat.textContent = "分类：" + cap(e.category, 40);
        card.appendChild(cat);
      }
      if (e.summary) {
        const sum = document.createElement("div");
        sum.className = "r-sum";
        sum.textContent = "摘要：" + cap(e.summary, 600);
        card.appendChild(sum);
      }
      // 文本
      const pre = document.createElement("pre");
      pre.className = "r-text";
      pre.textContent = e.status === "error"
        ? "识别失败：" + cap(e.error || "未知错误", 500)
        : cap(e.text || "（未识别到文字）", 20000);
      if (pre.textContent.length > 5000) {
        pre.classList.add("trunc");
      }
      card.appendChild(pre);
      // 操作按钮
      const ops = document.createElement("div");
      ops.className = "r-ops";
      const mkBtn = (label, fn, extra) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = "mini" + (extra ? " " + extra : "");
        b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
        return b;
      };
      const id = e.id || "";
      ops.appendChild(mkBtn(e.status === "done" && e.text ? "复制文本" : null, () => copyText(e.text || ""), ""));
      ops.appendChild(mkBtn(e.status === "done" && e.text && !e.summary ? "DeepSeek 总结" : null, () => doSummarize(id), ""));
      ops.appendChild(mkBtn("删除", () => doDelete(id), "danger"));
      card.appendChild(ops);
      frag.appendChild(card);
    });
    list.appendChild(frag);
    // 点击截断文本展开
    list.querySelectorAll("pre.trunc").forEach((pre) => {
      pre.addEventListener("click", () => pre.classList.toggle("trunc"));
    });
  }

  function copyText(text) {
    if (!text) return;
    try {
      navigator.clipboard.writeText(text).then(
        () => showMsg("stats", "已复制", 2000),
        () => legacyCopy(text)
      );
    } catch { legacyCopy(text); }
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showMsg("stats", "已复制", 2000);
    } catch { showMsg("stats", "复制失败", 2000); }
  }

  async function refresh() {
    const q = cap($("search").value || "", 200);
    lastQuery = q;
    const r = await api.list({ query: q, limit: 500 });
    if (!r || !r.ok) { showMsg("stats", (r && r.error) || "读取失败", 3000); return; }
    renderResults(r.entries || []);
    const st = await api.stats();
    if (st && st.ok && st.stats) {
      const s = st.stats;
      $("stats").textContent = "共 " + s.count + " 条（成功 " + s.done + " / 失败 " + s.error + "）";
      if (q) $("stats").textContent += " · 搜索: " + cap(q, 50);
    }
  }

  async function doDelete(id) {
    if (!id) return;
    if (!window.confirm("删除该条识别记录？")) return;
    const r = await api.remove(id);
    if (r && r.ok) refresh();
    else showMsg("stats", (r && r.error) || "删除失败", 3000);
  }

  async function doSummarize(id) {
    if (!id || summarizing.has(id)) return;
    summarizing.add(id);
    showMsg("stats", "正在请求 DeepSeek 总结…", 0);
    try {
      const r = await api.summarize(id);
      if (r && r.ok) {
        showMsg("stats", "总结完成", 2000);
      } else {
        showMsg("stats", (r && r.error) || "总结失败", 5000);
      }
      refresh();
    } finally {
      summarizing.delete(id);
    }
  }

  // ---------- 导入 ----------
  async function pickAndQueue(promise) {
    if (batchTotal > 0) return;
    const r = await promise();
    if (!r || !r.ok) { showMsg("stats", (r && r.error) || "导入失败", 3000); return; }
    const paths = (r.paths || []).slice(0, 200);
    if (!paths.length) return;
    // 去重（与已有待识别队列去重）
    const seen = new Set(pendingPaths);
    const fresh = paths.filter((p) => !seen.has(p));
    if (!fresh.length) { showMsg("stats", "这些图片已在队列中", 3000); return; }
    pendingPaths = pendingPaths.concat(fresh).slice(0, 200);
    renderQueue();
    $("btn-run").disabled = false;
  }

  // ---------- 开始识别 ----------
  async function runOcr() {
    if (!pendingPaths.length || batchTotal > 0) return;
    const langs = [];
    if ($("lang-zh").checked) langs.push("chi_sim");
    if ($("lang-en").checked) langs.push("eng");
    if (!langs.length) { showMsg("stats", "请至少勾选一种语言", 3000); return; }
    batchTotal = pendingPaths.length;
    batchDone = 0;
    $("btn-run").disabled = true;
    $("btn-files").disabled = true;
    $("btn-folder").disabled = true;
    $("btn-cancel").hidden = false;
    $("queue-progress").hidden = false;
    updateProgressBar();
    pendingPaths.forEach((p, i) => setQueueRowStatus(i, "排队"));
    const paths = pendingPaths.slice();
    pendingPaths = [];
    renderQueue();
    try {
      const r = await api.runOcr({ paths: paths, langs: langs });
      if (!r || !r.ok) { showMsg("stats", (r && r.error) || "识别失败", 5000); }
      else { showMsg("stats", "完成：" + r.okCount + "/" + r.total + " 张识别成功", 5000); }
    } catch {
      showMsg("stats", "识别中断", 3000);
    } finally {
      batchTotal = 0;
      batchDone = 0;
      $("btn-run").disabled = true;
      $("btn-files").disabled = false;
      $("btn-folder").disabled = false;
      $("btn-cancel").hidden = true;
      $("queue-progress").hidden = true;
      $("queue").hidden = true;
      renderQueue();
      refresh();
    }
  }

  function updateProgressBar() {
    const bar = $("queue-progress-bar");
    if (!bar) return;
    const pct = batchTotal ? Math.round((batchDone / batchTotal) * 100) : 0;
    bar.style.width = pct + "%";
  }

  // ---------- 进度事件 ----------
  api.onProgress((p) => {
    if (!p) return;
    if (p.type === "batch") {
      batchTotal = p.total || 0;
      batchDone = 0;
      updateProgressBar();
    } else if (p.type === "start") {
      batchDone++;
      updateProgressBar();
    } else if (p.type === "worker") {
      if (p.status === "recognizing text" && typeof p.progress === "number") {
        showMsg("stats", "识别中 " + Math.round(p.progress * 100) + "%", 0);
      }
    }
    if (p.type === "done" || p.type === "error") {
      showMsg("stats", p.type === "done" ? "识别完成，刷新结果…" : "识别失败：" + cap(p.error || "", 120), 1500);
      refresh();
    }
  });

  // ---------- DeepSeek Key ----------
  async function initConfig() {
    const r = await api.getConfig();
    if (!r || !r.ok) return;
    if (r.version) $("version").textContent = "v" + cap(r.version, 30);
    if (!r.deepseekConfigured) {
      $("key-section").hidden = false;
    }
  }

  // ---------- 事件绑定 ----------
  $("btn-files").addEventListener("click", () => pickAndQueue(() => api.pickFiles()));
  $("btn-folder").addEventListener("click", () => pickAndQueue(() => api.pickFolder()));
  $("btn-run").addEventListener("click", runOcr);
  $("btn-cancel").addEventListener("click", async () => {
    $("btn-cancel").disabled = true;
    await api.cancelOcr();
    showMsg("stats", "正在取消…", 1500);
    setTimeout(() => { $("btn-cancel").disabled = false; }, 1200);
  });
  $("search").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") refresh();
  });
  $("btn-save-key").addEventListener("click", async () => {
    const key = cap($("key-input").value || "", 512).trim();
    const r = await api.setKey(key);
    if (r && r.ok) {
      $("key-section").hidden = true;
      showMsg("stats", "Key 已保存", 2000);
    } else {
      showMsg("key-status", (r && r.error) || "保存失败", 4000);
    }
  });


  // ---------- NapCat 图片来源 ----------
  let napcatGroups = [];
  let napcatSelected = new Set();

  function saveNapcatConfig(listen) {
    api.napcatSaveConfig({
      wsUrl: cap($("napcat-ws").value || "", 200),
      groups: Array.from(napcatSelected).map(Number),
      listen: listen !== undefined ? listen : $("napcat-listen").checked,
      qrPath: cap($("napcat-qr").value || "", 1024)
    }).then((r) => { if (r && !r.ok) showMsg("napcat-status", r.error, 4000); });
  }

  function renderNapcatGroups() {
    const box = $("napcat-groups");
    box.textContent = "";
    if (!napcatGroups.length) { box.textContent = "（尚未加载群列表）"; return; }
    const frag = document.createDocumentFragment();
    napcatGroups.forEach((g) => {
      const label = document.createElement("label");
      label.className = "chip group-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = napcatSelected.has(g.groupId);
      cb.addEventListener("change", () => {
        if (cb.checked) napcatSelected.add(g.groupId); else napcatSelected.delete(g.groupId);
        saveNapcatConfig();
      });
      const span = document.createElement("span");
      span.textContent = cap(g.groupName, 40) + " (" + g.groupId + ")";
      label.appendChild(cb);
      label.appendChild(span);
      frag.appendChild(label);
    });
    box.appendChild(frag);
  }

  async function loadNapcatGroups() {
    $("napcat-status").textContent = "连接中…";
    const r = await api.napcatListGroups();
    if (!r || !r.ok) { $("napcat-status").textContent = (r && r.error) || "连接失败"; return; }
    napcatGroups = (r.groups || []).slice(0, 200);
    if (!napcatSelected.size && napcatGroups.length) napcatGroups.forEach((g) => napcatSelected.add(g.groupId));
    renderNapcatGroups();
    $("napcat-status").textContent = "已连接，群数: " + napcatGroups.length;
  }

  async function refreshNapcatStatus() {
    const r = await api.napcatStatus();
    if (!r || !r.ok) return;
    $("napcat-ws").value = r.wsUrl || "ws://127.0.0.1:3001";
    $("napcat-listen").checked = Boolean(r.listen);
    if (r.qrPath) $("napcat-qr").value = r.qrPath;
    if (r.groups && r.groups.length) r.groups.forEach((g) => napcatSelected.add(g));
    $("napcat-status").textContent = r.connected ? "已连接 NapCat" : "未连接（点「连接并加载群列表」）";
  }

  async function napcatFetchImages() {
    if (batchTotal > 0) return;
    if (!napcatSelected.size) { showMsg("napcat-status", "请先选择群", 3000); return; }
    $("napcat-status").textContent = "拉取中…";
    const r = await api.napcatFetch({ groups: Array.from(napcatSelected).map(Number), perGroup: 100 });
    if (!r || !r.ok) { $("napcat-status").textContent = (r && r.error) || "拉取失败"; return; }
    const paths = (r.images || []).map((x) => x.filePath).filter(Boolean);
    const seen = new Set(pendingPaths);
    const fresh = paths.filter((p) => !seen.has(p));
    pendingPaths = pendingPaths.concat(fresh).slice(0, 200);
    renderQueue();
    $("btn-run").disabled = pendingPaths.length === 0;
    $("napcat-status").textContent = "拉到 " + paths.length + " 张（新增 " + fresh.length + "，失败 " + (r.failed || 0) + "）";
  }

  async function loadNapcatPending() {
    const r = await api.napcatPending();
    if (!r || !r.ok) return;
    const paths = (r.paths || []).filter(Boolean);
    const seen = new Set(pendingPaths);
    const fresh = paths.filter((p) => !seen.has(p));
    pendingPaths = pendingPaths.concat(fresh).slice(0, 200);
    renderQueue();
    $("btn-run").disabled = pendingPaths.length === 0;
    if (fresh.length) showMsg("napcat-status", "缓存中新增 " + fresh.length + " 张", 3000);
  }

  $("btn-napcat-connect").addEventListener("click", () => {
    napcatSelected.clear();
    saveNapcatConfig();
    loadNapcatGroups();
  });
  $("btn-napcat-fetch").addEventListener("click", napcatFetchImages);
  $("btn-napcat-pending").addEventListener("click", loadNapcatPending);
  $("btn-napcat-showqr").addEventListener("click", async () => {
    saveNapcatConfig();
    const r = await api.napcatShowQr();
    showMsg("napcat-status", r && r.opened ? "已在图片查看器中打开二维码" : "未检测到登录二维码（NapCat 可能在正常运行）", 4000);
  });
  $("btn-napcat-clear-pending").addEventListener("click", async () => {
    await api.napcatClearPending();
    showMsg("napcat-status", "缓存已清空", 2000);
  });
  $("napcat-listen").addEventListener("change", () => saveNapcatConfig($("napcat-listen").checked));
  api.onNapcatNewImages((p) => {
    const paths = (p && p.paths) || [];
    if (!paths.length) return;
    const seen = new Set(pendingPaths);
    const fresh = paths.filter((x) => !seen.has(x));
    pendingPaths = pendingPaths.concat(fresh).slice(0, 200);
    renderQueue();
    $("btn-run").disabled = pendingPaths.length === 0;
  });

  // ---------- 全家桶 ----------
  async function refreshBridgeStatus() {
    const r = await api.bridgeStatus();
    if (!r || !r.ok) { $("bridge-status").textContent = "OCR 服务未运行"; return; }
    $("bridge-status").textContent = r.running
      ? "✅ OCR 服务运行中：127.0.0.1:" + r.port + " · 令牌 " + (r.token ? r.token.slice(0, 6) + "…" : "-")
      : "OCR 服务未启动";
  }
  $("btn-open-sentinel").addEventListener("click", async () => {
    const r = await api.openSentinel();
    showMsg("bridge-status", r && r.ok ? "已启动大事汇总器" : (r && r.error) || "启动失败", 3000);
  });

  // ---------- 首次引导 ----------
  const GUIDE_STEPS = [
    { t: "认识全家桶", d: "一个安装包 = 三个工具：本应用（图片识别 + 全家桶入口）、大事汇总器（QQ 群监控 + 每日大事）、NapCat（QQ 连接底座，魔改支持群图下载）。" },
    { t: "首次使用三步走", d: "① 电脑先装好 QQ（QQNT 新版）并登录一次；② 点上方「打开大事汇总器」，它会自动拉起 NapCat；③ 登录二维码会<b>自动弹出到系统图片查看器</b>，用手机 QQ 扫码即完成。" },
    { t: "开始干活", d: "大事汇总器里勾选要监控的群；本应用里可导入图片识别，或从「QQ 群图片来源」拉取群图 OCR；每日 22:00 自动汇总大事。" },
    { t: "可选增强", d: "设置 DeepSeek API Key 可让汇总更智能；不设置也能用（本地统计版汇总 + 机器人自动检测）。热点库（微博/抖音/B站）联网自动更新。" }
  ];
  function renderGuide() {
    $("guide-body").innerHTML = GUIDE_STEPS.map((s, i) =>
      '<div class="guide-step"><div class="guide-num">' + (i + 1) + '</div><div><h4>' + esc(s.t) + '</h4><p>' + s.d + '</p></div></div>'
    ).join("");
  }
  function openGuide() { renderGuide(); $("guide-modal").classList.remove("hidden"); }
  function closeGuide() { $("guide-modal").classList.add("hidden"); }
  try {
    if (!localStorage.getItem("imgocr.guideShown")) openGuide();
  } catch {}
  $("btn-guide").addEventListener("click", openGuide);
  $("btn-guide-close").addEventListener("click", closeGuide);
  $("btn-guide-done").addEventListener("click", () => {
    try { if ($("guide-noshow").checked) localStorage.setItem("imgocr.guideShown", "1"); } catch {}
    closeGuide();
  });

  // ---------- 帮助中心 ----------
  const HELP_SECTIONS = [
    { t: "🚀 快速开始", html:
      "<ol><li>安装 QQ（QQNT 新版）并登录一次（任意账号）</li>" +
      "<li>打开本应用（图片识别 = 全家桶入口）</li>" +
      "<li>点「🧰 全家桶互调 → 打开大事汇总器」→ 自动拉起 NapCat</li>" +
      "<li>二维码自动弹到系统图片查看器 → 手机 QQ 扫码登录（首次）</li>" +
      "<li>大事汇总器勾选监控群；本应用导入图片或拉取群图开始识别</li></ol>" },
    { t: "📷 图片识别", html:
      "<ul><li><b>导入</b>：图片 / 文件夹 / 批量，只读不修改源文件</li>" +
      "<li><b>识别</b>：tesseract.js 纯本地，中文+英文离线模型；串行队列、进度显示、可取消</li>" +
      "<li><b>结果库</b>：本地 JSONL 存档（原子写入），全文搜索，可删除</li>" +
      "<li><b>DeepSeek 总结（可选）</b>：对识别文字做分类+摘要，Key 仅存本机、仅 https</li></ul>" },
    { t: "📡 QQ 群图片来源（NapCat）", html:
      "<ul><li><b>连接</b>：默认 127.0.0.1:3001；「连接并加载群列表」后勾选群</li>" +
      "<li><b>拉取</b>：拉所选群最近图片（经 NapCat 魔改 token 通道下载真实文件）</li>" +
      "<li><b>监听</b>：勾选「实时监听」自动把新群图加入队列</li>" +
      "<li><b>只读承诺</b>：只查询和下载图片，绝不发送任何消息、不做任何写操作</li></ul>" },
    { t: "🧰 全家桶互调", html:
      "<ul><li>本应用提供本地 OCR 服务（<code>127.0.0.1:8765</code>，令牌鉴权，仅本机）</li>" +
      "<li>大事汇总器「时间线 → 识别群内图片」会调用它，把群图 OCR 结果写进大事时间线</li>" +
      "<li>两边可互相「打开」：本应用打开大事汇总器，大事汇总器打开本应用</li></ul>" },
    { t: "🔑 二维码登录与恢复", html:
      "<ul><li>首次使用或小号会话失效时，NapCat 会生成二维码，<b>自动弹出到系统图片查看器</b>（每约 2 分钟刷新自动重弹）</li>" +
      "<li>也可点「立即打开二维码」手动查看</li>" +
      "<li>二维码文件位置可自定义（默认自动查找全家桶内嵌 NapCat）</li></ul>" },
    { t: "🤖 机器人检测与忽略", html:
      "<ul><li>大事汇总器自动扫描群成员（<code>is_robot</code> 字段），群列表里标注「🤖 机器人」</li>" +
      "<li>检测到的机器人自动加入汇总忽略列表，避免刷屏污染每日大事</li>" +
      "<li>「设置 → 监听」可关闭自动忽略</li></ul>" },
    { t: "📝 大事汇总器", html:
      "<ul><li>监控：只采集指定群（可勾选），支持历史回拉、公告、@全体、冲突检测</li>" +
      "<li>热点：微博/抖音/B站热榜免费接口，消息热梗标记 + 汇总参考</li>" +
      "<li>汇总：每日 22:00 自动；有 DeepSeek Key 用 AI 版，无 Key 自动用本地统计版（消息统计+关键词+成员活跃度+公告/事件）</li>" +
      "<li>机器人检测：自动标注并忽略</li></ul>" },
    { t: "❓ 常见问题", html:
      "<ul><li><b>QQ 升级后 NapCat 提示 PacketBackend 不支持</b>：QQ 新版刚发布，NapCat 偏移数据未跟进；不影响本全家桶功能（登录/群列表/历史/图片下载都走文件服务）。等 NapCat 更新或降回旧版 QQ。</li>" +
      "<li><b>找不到 QQ.exe</b>：在大事汇总器「设置 → 小号 QQ」里手动填 QQ 路径</li>" +
      "<li><b>OCR 服务连不上</b>：确认本应用在运行（8765 端口在听）；令牌自动互认</li>" +
      "<li><b>小号掉线</b>：二维码会自动弹出，扫码即恢复；每台电脑登录态相互独立</li>" +
      "<li><b>不要用带 BOM 的编辑器改配置</b>：config.json 必须无 BOM（用应用界面改最稳）</li></ul>" },
    { t: "🔧 数据与安全", html:
      "<ul><li>所有数据存本机：识别结果（%APPDATA%\imgocr）、汇总/消息（%APPDATA%\qq-sentinel）、小号 QQ 独立数据目录（默认 D:\QQNT-MULTI-DATA）</li>" +
      "<li>只读原则：不修改图片源文件、不发送 QQ 消息；OCR 桥仅限本机 + 令牌</li>" +
      "<li>卸载即删除应用本体；如需清除全部数据请手动删除上述目录</li></ul>" }
  ];
  function renderHelp() {
    $("help-body").innerHTML = HELP_SECTIONS.map((s) =>
      '<details class="help-sec"><summary>' + esc(s.t) + '</summary><div class="help-body">' + s.html + '</div></details>'
    ).join("");
  }
  $("btn-help").addEventListener("click", () => { renderHelp(); $("help-modal").classList.remove("hidden"); });
  $("btn-help-close").addEventListener("click", () => { $("help-modal").classList.add("hidden"); });
  // Esc 关闭弹窗
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("help-modal").classList.add("hidden"); $("guide-modal").classList.add("hidden"); } });
  // 点击遮罩关闭
  ["help-modal", "guide-modal"].forEach((id) => { $(id).addEventListener("click", (e) => { if (e.target === $(id)) $(id).classList.add("hidden"); }); });


  // ---------- 更新日志 ----------
  const CHANGELOG_TEXT = "v0.2.0（2026-08-19）全家桶发布\n🆕 全家桶整合：大事汇总器 + 图片识别 + NapCat 一个安装包，互相调用\n🆕 免责声明：安装前 + 首次强制确认；协议中心（免责/用户协议/隐私/开源许可）\n🆕 二维码登录：自动弹 Windows Photos + 风险警告（用小号）+ 登录后自动关闭\n🆕 机器人检测：自动标注 is_robot 成员并忽略其刷屏\n🆕 本地统计汇总：无 DeepSeek 自动降级（统计+关键词+活跃成员）\n🆕 OCR 互调桥：大事汇总器识别群图 → 图片识别本地 OCR（令牌鉴权）\n🆕 后台运行：图片识别隐藏驻留托盘，自动拉起大事汇总器（第一眼）\n🆕 首次引导 + 帮助中心 + 一键安装脚本\n🔒 安全加固：IPC 发送方校验 / 路径白名单 / XSS 转义 / 日志脱敏\n✅ 修复：启动崩溃（safeHandle 递归）、控制台窗口、撤回忽略、打包 NapCat 依赖\n\nv0.1.0（2026-08）图片识别工具\n本地 OCR（离线中英文）、JSONL 存档 + 全文搜索、NapCat 群图拉取、DeepSeek 总结（可选）";
  $("btn-changelog").addEventListener("click", () => { $("changelog-body").textContent = CHANGELOG_TEXT; $("changelog-modal").classList.remove("hidden"); });
  $("btn-changelog-close").addEventListener("click", () => { $("changelog-modal").classList.add("hidden"); });

  // ---------- 免责声明与协议 ----------
  const DISCLAIMER_TEXT =
"图片识别工具全家桶（图片识别 + 大事汇总器 + NapCat）\n" +
"安装免责声明与使用须知\n\n" +
"【使用前必读】使用即表示您已阅读并同意以下全部内容：\n\n" +
"1. 用途声明\n本软件仅用于个人学习、研究与日常信息整理。使用者应遵守《腾讯软件许可及服务协议》、QQ 平台规则及所在国家/地区的法律法规。\n\n" +
"2. 账号风险\n软件需要登录一个 QQ 账号（强烈建议使用专门的小号）以读取群消息。登录后该账号可读取所监控群的全部消息，并可能触发 QQ 官方风控，存在限制登录、封号等风险。由此产生的任何后果由使用者自行承担，开发者不承担任何责任。\n\n" +
"3. 隐私与数据\n除可选的 DeepSeek 文本总结（仅向官方 API 发送文本内容）外，本软件不在线传输任何数据：识别结果、消息记录、配置均保存在本机。使用者应对自行配置监控内容所涉及的个人信息负责，并妥善保管本机数据。\n\n" +
"4. 第三方组件\n本软件内置 NapCat（MIT 许可）、Tesseract OCR（Apache-2.0）等第三方组件，其行为与更新不受本项目控制。\n\n" +
"5. 无担保与免责\n本软件按\"现状\"提供，不提供任何明示或默示担保。因使用本软件造成的任何直接或间接损失（包括但不限于账号损失、数据丢失、法律纠纷），开发者概不负责。\n\n" +
"6. 禁止用途\n禁止将本软件用于任何非法目的，包括但不限于入侵、骚扰、侵犯他人隐私、批量骚扰等。";

  const AGREEMENTS = [
    { t: "免责声明", html: "<pre class=\"disc-pre\">" + DISCLAIMER_TEXT + "</pre>" },
    { t: "用户协议", html:
      "<ol><li>本软件按\"现状\"提供，不保证持续可用、无错误或无中断。</li>" +
      "<li>您仅可将本软件用于合法、合规的个人用途；不得用于任何违反法律法规或 QQ 平台规则的行为。</li>" +
      "<li>您对使用本软件的行为及后果（含登录账号）负全部责任。</li>" +
      "<li>开发者有权随时更新、修改或停止本软件，恕不另行通知。</li>" +
      "<li>卸载本软件即视为终止本协议；删除应用本体后，本机留存的数据由您自行处置。</li></ol>" },
    { t: "隐私政策", html:
      "<p><b>本地存储</b>：识别结果、消息记录、配置、机器人名单等全部保存在本机用户目录（%APPDATA%\\imgocr、%APPDATA%\\qq-sentinel），不会上传。</p>" +
      "<p><b>网络请求</b>：仅以下场景联网——① 热点库：微博/抖音/B站公开接口；② OCR 语言模型首次下载（可选离线包）；③ DeepSeek 文本总结（仅当您主动配置 API Key 并使用时，发送识别文本到官方 API）。</p>" +
      "<p><b>日志脱敏</b>：本地日志会自动隐藏 API Key、Token 等敏感信息。</p>" +
      "<p><b>第三方</b>：NapCat 与 QQ 之间的通信受腾讯协议约束，相关内容请查阅腾讯官方声明。</p>" },
    { t: "开源与第三方许可", html:
      "<p>本软件基于以下开源项目构建，各自按对应许可发布：</p>" +
      "<ul><li><b>Electron</b> — MIT</li><li><b>tesseract.js / tesseract.js-core</b> — Apache-2.0</li><li><b>ws</b> — MIT</li><li><b>express</b> — MIT</li><li><b>NapCatQQ</b> — MIT</li><li><b>tessdata 语言模型（eng/chi_sim）</b> — Apache-2.0</li></ul>" +
      "<p class=\"muted\">完整许可文本见各项目官方仓库。</p>" },
  ];
  function renderAgreements() {
    $("agreements-body").innerHTML = AGREEMENTS.map(function (s) {
      return "<details class=\"help-sec\"><summary>" + esc(s.t) + "</summary><div class=\"help-body\">" + s.html + "</div></details>";
    }).join("");
  }
  function openAgreements() { renderAgreements(); $("agreements-modal").classList.remove("hidden"); }
  function closeAgreements() { $("agreements-modal").classList.add("hidden"); }

  // 首次使用：强制免责确认
  async function initDisclaimer() {
    try {
      const r = await api.disclaimerStatus();
      if (!r || !r.ok || r.accepted) return;
      $("disclaimer-body").innerHTML = "<pre class=\"disc-pre\">" + esc(DISCLAIMER_TEXT) + "</pre>";
      $("disclaimer-modal").classList.remove("hidden");
    } catch {}
  }
  $("btn-agreements").addEventListener("click", openAgreements);
  $("btn-agreements-close").addEventListener("click", closeAgreements);
  $("btn-disclaimer-view").addEventListener("click", openAgreements);
  $("btn-disclaimer-quit").addEventListener("click", () => api.quitApp());
  $("disclaimer-agree").addEventListener("change", () => {
    $("btn-disclaimer-ok").disabled = !$("disclaimer-agree").checked;
  });
  $("btn-disclaimer-ok").addEventListener("click", async () => {
    const r = await api.disclaimerAccept();
    if (r && r.ok) $("disclaimer-modal").classList.add("hidden");
  });

  // ---------- 启动 ----------
  initConfig();
  refresh();
  refreshNapcatStatus();
  refreshBridgeStatus();
})();