# QQ 群大事监控器 (QQ Sentinel)

一个独立的 Electron 桌面应用：通过 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11 协议）监听 QQ 群，自动采集群消息、群公告、@全体成员事件，并用 DeepSeek API 汇总每日大事、识别群内吵架冲突。

## 功能

- **群列表**：自动发现并展示所有群，可单独开关关注
- **大事时间线**：@全体、新公告、撤回、管理变动、进退群、冲突等事件实时记录
- **每日汇总**：DeepSeek 按天总结群内真正重要的事（公告/通知/决定/矛盾），忽略闲聊；无 DeepSeek Key / Ollama 时自动用内置轻量模型做本地语义聚类总结（离线免费），仍无模型则降级本地统计版
- **吵架识别**：规则初筛（冲突词+消息密度）→ LLM 精判，标记冲突等级与参与人
- **历史回拉**：连接后自动拉取最近 N 天消息（默认 3 天）
- **NapCat 管理**：内置下载安装/启动/停止 NapCat
- **公告轮询**：每 30 分钟检查一次新公告

## 快速开始

1. `npm install`（需 Node 18+）
2. 准备 NapCat：
   - 方式 A：应用内「NapCat」页点击「下载安装 NapCat」，运行后按提示扫码登录小号
   - 方式 B：已有 NapCat，在设置里填 OneBot WS 地址
3. 连接模式（设置页）：
   - **反向 WS（推荐）**：应用监听 3002 端口，在 NapCat 配置 `config/onebot11_<QQ号>.json` 的 `websocketClients` 里加 `{"url":"ws://127.0.0.1:3002/","enable":true}`，NapCat 自动连入并自动重连
   - **正向 WS**：NapCat 开启 OneBot 11 正向 WebSocket（默认端口 3001），应用直接连接
4. 填写 DeepSeek API Key（设置页，或环境变量 `DEEPSEEK_API_KEY`）
5. `npm start` 启动，点「连接」

## 测试

```bash
npm test          # 单元测试（node:test，53 项：config/logger/onebot/store/bots/ollama/export）
npm run test:integration  # 集成脚本（只读护栏 / 指定群 / 全链路 mock）
```

## 构建

```bash
npm run build          # electron-packager → dist/qq-sentinel-win32-x64（全家桶打包流程沿用）
npm run dist           # electron-builder → dist-eb/win-unpacked（electron-builder 26；当前机器受 npm.ps1 × Windows PowerShell 5.1 兼容问题限制，建议在 pwsh 7 / CI 环境执行）
```

## 开发

```bash
npm start           # 运行
npm run build       # 打包 Windows x64
node tools/mock-onebot.js   # Mock 服务器（模拟群消息，用于无机器人测试）
node tools/test-pipeline.js # 全链路集成测试
```

## 架构

```
main.js            Electron 主进程：窗口、IPC、定时任务
core/config.js     配置读写
core/onebot.js     OneBot 11 客户端（WS 事件 + HTTP API）
core/collector.js  采集器：事件解析、@全体检测、冲突窗口、历史回拉、公告轮询
core/store.js      JSONL 本地存储（零原生依赖，exFAT 友好）
core/summarizer.js DeepSeek 汇总引擎：每日大事 + 冲突精判
core/napcat.js     NapCat 实例管理（下载/启动/停止）
renderer/          UI（总览/群列表/时间线/报告/NapCat/设置）
```

## 数据位置

- 配置：`%APPDATA%/qq-sentinel/config.json`
- 数据：`%APPDATA%/qq-sentinel/data/store/`（groups.json + messages/*.jsonl + events/*.jsonl）
- 日志：`%APPDATA%/qq-sentinel/data/logs/sentinel.log`

## 注意

- NapCat 走非官方协议，**强烈建议使用不常用的小号**，有封号风险
- 机器人需在目标群内才能收到消息
- 降封号风险：主动 API 节流/保守默认/风控自动暂停（设置页「风控与采集克制」可调）
- 内置语义总结模型约 129MB（随安装包分发，开箱即用）；关键词命中与汇总报告联动详见报告页


## ⚠️ 只读承诺（重要）

本软件**只能采集信息**，**禁止对 QQ 做任何写操作**——不发送消息、不撤回、不建群/退群、不改群资料、不踢人/禁言、不处理加群请求、不操作精华/公告以外的任何写入。

技术保障（三层）：

1. **API 白名单**：core/onebot.js 的 READ_ONLY_ACTIONS 只允许查询类 API（get_*/_get_*），其余 action 一律拒绝（core/onebot.js call() 入口拦截）。
2. **发送方法已删除**：sendGroupMsg / sendGroupForward 等写入能力已从代码中移除，未来新增写操作需显式违反护栏。
3. **反向/正向模式同样拦截**：ReverseOneBotServer.call 同样走白名单。

验证：
ode tools/test-readonly.js（写操作全部被拒，只读操作全部放行）。

> 即使未来代码误调用写操作 API，也会在 call() 入口被 只读模式：禁止操作 <action> 拒绝，不会到达 NapCat。
## 🎯 指定群爬取

默认采集全部群。可在「群列表」页顶部指定爬取群（输入群号添加，或勾选群列表里的开关）：

- **指定了群** → 只采集/汇总/回拉这些群，其他群的消息**完全不处理、不入库**
- **未指定**（空）→ 采集全部群
- 改动即时生效，无需重启

验证：`node tools/test-watchgroups.js`
## 🚀 自动启动

设置页「启动」面板：

- **开机自动启动本软件**：写入 Windows 注册表 Run 键（`HKCU\...\Run` 的 `QQSentinel` 项），开机随系统自动运行。
- **连接时自动启动 NapCat**：点击连接（或开机自动连接）时，若 NapCat 已安装但未运行，自动启动它。

**全自动流程**：开机 → 本软件自启 → 自动连接 →（必要时）自动拉起 NapCat → 自动回拉指定群历史并持续采集。

验证：`node tools/test-autostart.js`（注册表 add/query/delete 往返）
## 💻 打包版与桌面快捷方式

- 独立打包版：`dist\qq-sentinel-win32-x64\qq-sentinel.exe`（免安装，含 Chromium）
- 桌面快捷方式：「QQ群大事监控器」已创建在桌面，双击即可启动
- 打包版开机自启：设置页勾选后注册表指向打包 exe

**首次使用三步**：
1. 双击桌面「QQ群大事监控器」启动
2. 设置页填 DeepSeek API Key；NapCat 页下载安装 NapCat 并扫码登录小号
3. 设置页选连接模式（推荐反向 WS）+ 保存 → 点「连接」开始采集