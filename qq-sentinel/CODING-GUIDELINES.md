# 防护性代码规范（新增代码必须遵守）

本文件是 DSH 桌面客户端新增代码的强制防护清单。任何新增/修改的代码（主进程、渲染层、协议层）提交前必须逐条自查。

## 0. 已有防护设施（优先复用）

| 设施 | 位置 | 作用 |
|---|---|---|
| 主进程全局守卫 | `main.js` | `uncaughtException`/`unhandledRejection` 不退出进程、写 crash.log、通知渲染层 |
| IPC 安全包装 | `preload.js` `safeInvoke` | 渲染层 IPC 调用永不产生未处理拒绝，错误归一化为 `{ok:false,error}` |
| 渲染层全局守卫 | `app.js` `reportCrash` | 未捕获错误/拒绝限频提示 |
| localStorage 包装 | `app.js` `lsGet/lsSet/lsDel` | 存储禁用时静默降级 |
| 帧处理隔离 | `app.js` onFrames | 单帧异常不影响后续帧 |
| 渲染降级 | `renderTimeline` | 单节点失败跳过，整体失败显示占位 |

## 1. 异步操作防护

- ✅ 所有 `async` 函数体包 `try/catch`（或调用点有明确兜底）
- ✅ 所有防重入标记（`xxxLoading`/`xxxPending`）在 **`finally`** 中释放（不是只放在成功路径）
- ✅ `await` 的 API 调用必须校验返回（`res.ok` 分支齐全，`res.error` 有兜底）
- ✅ 不静默吞错：`catch {}` 至少 `console.error`；用户可感知的错误用 `toast`

## 2. 数据访问防护

- ✅ 数组/对象访问用可选链（`?.`）与空值合并（`??`）
- ✅ 遍历前判空：`Array.isArray(x) && x.length`
- ✅ 数字/索引边界：`Number.isSafeInteger`、clamp 到 `[0, len)`、防死循环（循环内索引必须前进且有上限保护）
- ✅ 会话/事件数据（可能来自主机）不假设字段齐全，缺失给默认值

## 3. 安全防护

- ✅ 用户可控数据拼入 `innerHTML` 必须 `escapeHtml()`
- ✅ spawn 外部命令：参数数组化 + `shell:false`（或参数严格字符集白名单）
- ✅ 本地文件读取：扩展名/路径白名单校验
- ✅ base64/上传：大小上限

## 4. 生命周期防护

- ✅ 定时器/监听器：明确清理路径（组件销毁/会话切换时）
- ✅ DOM 引用：使用前判空（`$("id")` 可能不存在）
- ✅ 窗口关闭/进程退出：清理流、子进程、句柄

## 5. 渲染防护（UI 新增代码）

- ✅ 长循环内单条目 `try/catch`（一条坏数据不中断整体）
- ✅ 大列表遵循窗口化模式（`RENDER_WINDOW` + 懒加载 + 裁剪）
- ✅ 流式/高频更新走增量路径（`_needsUpdate` + `updateNodeContent`），不全量重建
- ✅ 渲染函数整体包 `try/catch` + 降级提示

## 6. 新增代码自查清单（提交前过一遍）

```
□ 异步函数 try/catch/finally 齐全？
□ 防重入标记 finally 释放？
□ API 返回 res.ok/error 全分支？
□ 可选链/空值合并覆盖可选字段？
□ 数组/索引/数字边界校验？
□ innerHTML 拼接处 escapeHtml？
□ spawn/文件读写的安全校验？
□ 定时器/监听器清理？
□ 长循环单条目容错？
□ 全局守卫覆盖漏网（确认不新增静默崩溃路径）？
```

## 7. 冒烟回归

- 新增/修改功能后跑 `DSH_SMOKE=1 DSH_MODE=smoke electron .`，确保 CONNECTED/APPROVAL/QUESTION/SKIN/CTX/PATH 全绿。
- 涉及流式的改动加跑 `DSH_MODE=roundtrip`。