# QQ 群大事监控全家桶（ImgOCR + QQ Sentinel + NapCat）

## 🚀 一键安装（推荐）

> **Windows 用户**：下载并双击 `一键安装.bat`，脚本会自动下载安装包并启动安装程序。
> 或直接下载安装包：[**ImgOCR.Setup.0.2.0.exe**（208MB）](https://github.com/BHX-WL/DeepSeek-Project/releases/latest) ← **点击即下载**

安装流程：同意免责声明 → 安装 → 打开「大事汇总器全家桶」→ 按首次引导操作（**用小号扫码登录**）。

> 需要源码/自己构建的开发者请看下方「从源码构建」。

---# QQ 群大事监控全家桶（ImgOCR + QQ Sentinel + NapCat）

一个安装包 = 三件套，互相联动，**用户第一眼看到的是大事汇总器**：

| 组件 | 作用 |
|---|---|
| **大事汇总器（QQ Sentinel）** | QQ 群监控 + 热点匹配 + 每日大事汇总（DeepSeek AI 版 / 本地统计版）+ 机器人检测 |
| **图片识别（ImgOCR）** | 本地 OCR（tesseract.js，离线中英文模型）+ 群图拉取；后台运行，提供本地 OCR 服务供大事汇总器调用 |
| **NapCat 魔改版** | QQ 连接底座：独立数据目录隔离大号、token 通道下载群图、登录二维码自动弹出（Windows Photos） |

## 核心功能

- **群大事监控**：只采集指定群（严格只读，不发送任何消息）；公告 / @全体 / 冲突检测；历史回拉
- **每日汇总**：每日 22:00 自动；有 DeepSeek Key 用 AI 版，无 Key 自动降级本地统计版（消息统计 + 关键词 + 活跃成员 + 公告/事件）
- **热点库**：微博 / 抖音 / B站 热榜免费接口，消息热梗标记 + 汇总参考
- **机器人检测**：扫描群成员 `is_robot` 字段，界面标注「🤖 机器人」，自动并入汇总忽略列表
- **图片识别**：本地 OCR 纯离线；全文搜索；可选 DeepSeek 文本总结
- **全家桶互调**：大事汇总器「时间线 → 识别群内图片」调用 imgocr 的本地 OCR 服务（127.0.0.1:8765，令牌鉴权，仅本机）
- **二维码登录**：NapCat 需要登录时，二维码自动弹出到 Windows Photos（绕开 WPS 等第三方劫持）；**弹出前强制风险警告，引导使用小号**；登录后自动关闭查看器
- **防护**：安装前 NSIS 免责声明页 + 首次运行强制免责确认；IPC 发送方校验；全部文本转义防 XSS；路径白名单；日志脱敏；只读护栏

## 首次使用

1. 安装 QQ（QQNT 新版）并登录一次（任意账号）
2. 运行安装包 → 阅读并同意免责声明
3. 打开后第一眼是大事汇总器 → 自动拉起 NapCat → 二维码自动弹出（Windows Photos）
4. **请使用专门的小号扫码**（不要用个人主号 —— 主号登录存在隐私与账号风险）
5. 勾选要监控的群；可选填 DeepSeek API Key

## 从源码构建

```bash
# 图片识别（hub）
cd imgocr
npm install
npm run tessdata:fetch      # 下载 OCR 离线模型（或放入 resources/tessdata）
npm start

# 大事汇总器
cd qq-sentinel
npm install
npm start
```

打包全家桶安装包（Windows）：

```bash
cd qq-sentinel
npm run build                    # ① qq-sentinel 打包到 dist\qq-sentinel-win32-x64（含内置语义模型 models/）
robocopy dist\qq-sentinel-win32-x64\resources\app ..\imgocr\bundle-qq-sentinel\app /E   # ② 同步组装源（覆盖旧 app）
cd ..\imgocr
npx electron-builder --win nsis  # ③ 全家桶安装包（after-pack 会校验语义模型在包内，缺失则终止）
```

> 模型分发闭环：内置语义模型约 129MB 随包内置、不入 git（qq-sentinel/models/ 已 ignore）。安装包构建时若缺模型会直接报错，不会静默发出降级版。
> 干净验收：可用环境变量 `QQS_USER_DATA=<空目录>` 让 qq-sentinel 把配置/存储/日志放到指定目录（多开/首次运行验收用）。

## 免责声明

使用本软件即表示同意 [docs/免责声明.txt](docs/免责声明.txt)。**强烈建议使用专门的小号**，监控 QQ 群存在账号风控风险，请遵守 QQ 平台规则与当地法律法规。

## 开源许可

MIT License，见 [LICENSE](LICENSE)。内置第三方：Electron (MIT)、tesseract.js (Apache-2.0)、ws (MIT)、express (MIT)、NapCatQQ (MIT)。