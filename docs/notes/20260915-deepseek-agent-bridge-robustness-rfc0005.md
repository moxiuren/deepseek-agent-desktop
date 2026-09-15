---
title: "RFC-0005 Agent Bridge 健壮性与响应延迟修复"
tags:
  - project
  - rfc
  - deepseek-agent
  - architecture
  - bridge
  - performance
  - robustness
category: "AI / Desktop / Bridge Performance"
status: "delivered"
entity_path: "C:/Users/Admin/Documents/Projects/deepseek-mac"
created: 2026-09-15
delivered_date: 2026-09-15
version: "1.0.9"
base_sha: "73fe6cb512e022f1c841e17417e4e1a06a2e8870"
merge_commit: "6fb21a9"
changelog_commit: "1a1ed13"
release_commit: "048b83a"
---

# RFC-0005 Agent Bridge 健壮性与响应延迟修复

> RFC 规格书：`docs/rfc/0005-agent-bridge-robustness.md`（状态 DELIVERED / COMPLETED）  
> 源码仓库：`C:\Users\Admin\Documents\Projects\deepseek-mac` (Git: `moxiuren/deepseek-agent-desktop`，主干已合入)  
> 交付版本：`v1.0.9`  
> 质检结论：[PASS: 质量与安全把关核验通过 (APPROVED FOR SHIP)]，23/23 深度断言全绿  

---

## 核心痛点与交付成果

在 DeepSeek for Windows 桌面端运行中，早期版本存在终端长输出误入附件流导致 16~25s 严重卡顿、双层节流硬编码死等 8 秒、大文件无前置内存守卫导致 OOM 以及二进制文件乱码读取等痛点。

本次 RFC-0005 交付实现了：
1. **秒级响应与动态冲抵**：彻底废除静态 8 秒等待死等，终端长输出默认走 16,000 字符纯文本直传，配合宿主真实执行耗时 `hostMs` 冲抵，消除 16~25s 响应卡顿。
2. **纯静态路由架构解耦**：抽离纯逻辑无状态类 `TerminalOutputRouter.cs`，彻底摆脱 WPF STA 线程与 GUI 依赖，具备 100% 独立自动化测试能力。
3. **前端单点权威节流**：在 `agent_bridge.js` 中构建基于 `performance.now()` 单调时钟驱动的 `DynamicThrottle`，统一管理单链队列锁与 UI 倒计时。
4. **OWASP 安全与防暴内存守卫**：调用 `ReadAllBytes` 前严格校验 `FileInfo.Length <= MaxUploadBytes` (5MB)，非文本超限文件拒绝解码并安全降级，生成高精度 GUID 防碰撞缓存文件。
5. **DOM 状态机闭环与 IPC 健壮性**：`waitForAttachmentReady` 依据文件大小动态计算 3~10s 超时并返回结构化对象；补齐宿主 `attach_failed` IPC 接收闭环；DirectSend 成功后强同步单调时钟；`streamBuf` 全局 60s 惰性回收。
6. **零警告编译基线**：清理 C# 全部可空性与模式匹配 CS 警告，达成严格 0 Warning(s), 0 Error(s)。

---

## 核心技术决策与架构比对

### 1. 终端输出路由解耦 (`TerminalOutputRouter.cs`)
- **常量规范**：`MaxDirectTextLength = 16000`、`HeadKeepChars = 7500`、`TailKeepChars = 7500`、`MaxUploadBytes = 5 * 1024 * 1024` (5MB)。
- **截断与折叠模型**：超过 16,000 字符的纯文本输出，保留前 7,500 字符与后 7,500 字符，并在中间嵌入提示语及持久化磁盘全量路径。
- **Windows 路径防误判**：针对形如 `C:\workspace\file.png:Prompt` 的带参指令，采用 `inner.Length > 2 && inner[1] == ':' && (inner[2] == '\\' || inner[2] == '/')` 严格防误判，杜绝盘符冒号被截断。

### 2. 前端单点权威动态节流 (`agent_bridge.js`)
- **废除硬编码**：移除旧有 `MIN_SEND_GAP_MS = 8000`。
- **单链队列锁**：所有任务由 `queueFeedbackSlot` 单链排队，仅当获得放行权时依据即时上下文调用 `DynamicThrottle.evaluate(context)` 计算动态间隔。
- **单调递增时钟**：采用 `performance.now()` 替代 `Date.now()`，杜绝 NTP 校时或用户改时钟导致的时钟回拨问题。
- **耗时冲抵与自适应梯级**：宿主回传真实 `hostMs` 执行耗时，自动扣减等待时间；同时提供 0~3 次连发阶梯防护（3000ms / 5000ms / 8000ms），防范官方 Web 90 秒封禁。

### 3. DOM 状态机与附件生命周期
- **动态超时**：`waitForAttachmentReady(fileSize, ...)` 根据大小在 3,000ms ~ 10,000ms 间动态计算超时，并返回 `{ ok: boolean, timedOut: boolean, elapsed: number }`。
- **DirectSend 状态同步**：HTTP API 直传通道回传成功时，调用 `DynamicThrottle.syncDirectSendSuccess()` 同步单调时钟。
- **惰性清理机制**：废弃每个任务独立的定时器，由单例 `setInterval(..., 60000)` 统一回收超过 120 秒未更新的 `streamBuf` 条目。

---

## 任务交付与提交历史

- `56977e9`: docs(rfc): add RFC-0005 (bridge robustness) + RFC-0004 acceptance report
- `a206b25`: docs(rfc): finalize RFC-0005 frozen specifications
- `57bf133`: feat(windows): decouple TerminalOutputRouter and resolve nullability warnings
- `e80fca4`: feat(bridge): implement DynamicThrottle and single-authority queue feedback pacing
- `b84c30a`: build(pipeline): sync root agent_bridge.js to publish output
- `73fe6cb`: test(ci): deliver decoupled verification test suite for RFC-0005 and achieve full green
- `b3c274e`: gatekeeper: add independent verification suite for RFC-0005
- `6fb21a9`: merge: merge feature/rfc-0005 (Gate 2 Approved)
- `1a1ed13`: docs(changelog): update CHANGELOG.md for v1.0.9 (RFC-0005)
- `048b83a`: chore(release): bump version to 1.0.9 and align verification scripts

---

## Gate 2 验收与把关官双核验结论

### 静态与安全审计 (Zero Defects)
- **OWASP 凭据审计**：命中 0 处硬编码 Secret、Token、API Key。
- **OOM 内存守卫**：在调用 `File.ReadAllBytes` 前执行严格的文件大小预检，超 5MB 拦截率 100%。
- **二进制安全**：杜绝非文本后缀超限调用 `ReadAllText` 导致乱码崩溃。
- **编译质量**：`dotnet build -c Release` 达到严格 0 Warning(s), 0 Error(s)。

### 动态断言套件全绿
- **CI 流水线**：`pwsh -NoProfile -File windows/build.ps1` 顺利通过，RFC-0004 (4/4) + RFC-0005 (3/3) 全绿通过。
- **TestOnly 模式**：`pwsh -NoProfile -File windows/build.ps1 -TestOnly` 消除编译依赖死锁，平滑放行。
- **把关官独立套件**：`GatekeeperVerification.ps1` 深度覆盖 6 大阶段 23 项断言（静态契约、OWASP、编译无警告、路由动态断言、动态节流沙箱、单源同步一致性），**23/23 全部通过 (FULL PASS)**。

### 签批状态
[GATE-PASS: APPROVED FOR SHIP] 准予放行，已正式合并入主干流水线并归档发布。
