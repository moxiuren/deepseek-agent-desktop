---
title: "RFC-0005: Agent Bridge 健壮性与响应延迟修复"
tags:
  - rfc
  - bridge
  - performance
created: 2026-09-15
author: deepseek-agent
status: draft
---

# RFC-0005: Agent Bridge 健壮性与响应延迟修复

> 提出者: deepseek-agent | 日期: 2026-09-15 | 状态: 待评审
> 触发: 用户反馈"回传文件/图片延迟明显"，经源码级实测定位
> 前置: RFC-0004 (宿主健壮性) 已上线 1.0.8，但未触及桥接层

## 1. 背景

RFC-0004 修复了 C# 宿主层（全局钩子、日志轮转、版本对齐），已上线 1.0.8。
但用户日常遇到的"回传文件/图片慢"痛点位于另一层——附件回传通道，
涉及 C# 分流逻辑 + JS 桥接层注入逻辑，RFC-0004 一行未动。

本 RFC 记录全部实测问题，供策划排期。

## 2. 问题总览

| ID | 严重度 | 位置 | 一句话 |
|----|--------|------|--------|
| P1 | 高 | MainWindow.xaml.cs L1320 | 输出 >6000 字符被强制走附件通道 |
| P2 | 中 | MainWindow.xaml.cs L1590 | MaxUploadBytes=5MB，超限降级文本 |
| P3 | 高 | agent_bridge.js L1774 | 附件注入失败静默降级，故障不可见 |
| P4 | 中 | agent_bridge.js L90/L1486 | 8s 等待 + 8s 发送间隔，固定耗时叠加 |
| P5 | 低 | agent_bridge.js L1830 vs L90 | 提示语写"3s 节流"，常量实为 8000ms |
| P6 | 低 | agent_bridge.js streamBuf | 按 id 累积流，id 复用可能串台 |

## 3. 详细问题清单
### P1 [高] 长文本输出被强制走附件通道（延迟元凶）
**位置**: windows/MainWindow.xaml.cs L1320
**现状代码**:
if (output.Length > 6000)   // 超过 6000 字符即打包附件
{
    int bytesLen = Encoding.UTF8.GetByteCount(output);
    if (bytesLen <= MaxUploadBytes)
    {
        string tempFile = ...agent_output_*.txt;
        await File.WriteAllTextAsync(tempFile, output, Encoding.UTF8);
        byte[] fileBytes = await File.ReadAllBytesAsync(tempFile);
        string b64 = Convert.ToBase64String(fileBytes);
        await FeedResultBackAsync(id, exitCode, output, isAttachment: true, ...);
    }
    return;
}
**影响**: 任何 >6000 字符的终端输出（如 Get-Content 大文件、日志读取）被强制转成 base64 附件，走"注入聊天框 -> 等上传 -> 发送"重通道。一次延迟约 15-20 秒（base64 + 8s 等待 + 8s 间隔）。
**建议**:
- 方案 A（推荐）: 阈值 6000 提高到 20000+，纯文本输出尽量走文本通道
- 方案 B: 增加类型判断——text/plain 类永不自动走附件，仅 image/二进制才走
- 方案 C: 长文本改为"截断 + 本地文件路径引用"，不打包
**风险**: 阈值调高后超长文本可能触发聊天框输入限制；需实测 DeepSeek 输入框上限。
### P2 [中] MaxUploadBytes 上限降级
**位置**: windows/MainWindow.xaml.cs L1590
**现状**: private const int MaxUploadBytes = 5 * 1024 * 1024; (5MB)
**影响**: 超过 5MB 的附件降级为文本引用（见 L1299 / L1323 分支）。行为本身合理，但与 P1 叠加时，大输出可能既不走附件、又被截断。
**建议**: 保持 5MB，但降级路径需明确提示用户"完整内容在哪"。

### P3 [高] 附件注入失败静默降级
**位置**: agent_bridge.js L1771-1776
**现状代码**:
if (injectFileToChat(fileObj)) { __attachInjectedAt = Date.now(); }
else {
    fileObj = null;
    try { diagAttach({ phase: 'inject-failed', name: data.filename || '' }); } catch (_) {}
}
**影响**:
- injectFileToChat 依赖 DeepSeek 前端 DOM 选择器；网站改版即失效
- 失败后仅写 diag 日志，用户侧无任何提示，静默降级为纯文本
- 模型侧可能收到上一轮旧回执，造成"缓存/错位"错觉
**建议**:
- 失败时 console.error 显式输出
- 通过 sendToNative({action:'attach_failed', ...}) 通知原生层
- 反馈文本明确标注"[附件注入失败，已降级文本]"
**风险**: 低。仅增加可见性，不改流程。
### P4 [中] 固定耗时叠加（8s + 8s）
**位置**: agent_bridge.js L90, L1486
**现状**:
const MIN_SEND_GAP_MS = 8000;                               // L90
function waitForAttachmentReady(callback, maxWaitMs = 8000) // L1486
**影响**: 每次附件回传至少 8s 等待 + 8s 发送间隔 = 16s 起。该设计为防 DeepSeek "Messages too frequent" 限流保险（BACKOFF_MS=90000）。
**建议**:
- waitForAttachmentReady 改自适应: 小文件 3s、大文件按体积算（上限 15s）
- MIN_SEND_GAP_MS 分级: 纯文本保持 8s 保守值；附件场景可降至 4s（附件本身耗时长，连续发送概率低）
**风险**: 中。调低间隔可能提高限流概率，需灰度观察 BACKOFF 触发率。

### P5 [低] 常量与提示语不一致
**位置**: agent_bridge.js L1830 附近
**现状**: 界面提示语写"正在通过 3s 节流安全通道自动发送"，但常量 MIN_SEND_GAP_MS = 8000（8s）。
**建议**: 提示语改为读取常量值，避免文档与行为脱节。
**风险**: 极低。纯文案。
### P6 [低] streamBuf 按 id 累积可能串台
**位置**: agent_bridge.js L100, L1685
**现状**:
const streamBuf = {};
streamBuf[data.id] = String(streamBuf[data.id] || '') + data.chunk;
try { streamedText = String(streamBuf[cardId] || ''); delete streamBuf[cardId]; }
**影响**: 若 cardId 复用而 delete 未及时，旧内容可能混入新回执。
**建议**: 使用 cardId + 递增序号作 key，或接收完成立即清理。
**风险**: 低。属健壮性加固。

## 4. 改进建议汇总（按优先级）
**必做（P1 + P3）**:
1. P3: 附件注入失败显式告警（JS 侧，零编译，零风险）—— 先让故障可见
2. P1: 长文本分流策略调整（C# 侧，需重编译）—— 根治延迟
**建议（P4）**:
3. P4: 8s 双等待自适应/分级（JS 侧，需灰度）
**顺手（P5 + P6）**:
4. P5: 文案与常量对齐
5. P6: streamBuf key 唯一化
## 5. 验收标准建议
- [ ] P1: 构造 10000 字符输出，验证走文本通道而非附件，端到端 < 3s
- [ ] P3: 模拟 injectFileToChat 失败，验证日志有 attach_failed 且反馈文本明确标注
- [ ] P4: 附件场景端到端耗时下降 >= 30%
- [ ] P5: grep 确认提示语无硬编码秒数
- [ ] 全部通过后，build.ps1 的 RFC-0005 测试套件全绿

## 6. 附: RFC-0004 遗留观察（供参考，非阻塞）
跑 RFC-0004 验收测试时发现两处小瑕疵：
1. **build.ps1 报告失真**: 脚本结尾打印 "FULL GREEN (0 Errors, 0 Warnings)"，但实测 dotnet build 有 7 个 CS 可空性 warning（MainWindow.xaml.cs L322/773/1197/1203/1634）。建议修文案或真修 warning。
2. **"55MB" 语义**: CleanupLegacyDesktopLogSafe 实际逻辑是删除任意非空的 deepseek_debug.log，不判断大小。"55MB" 只是 verify-log-cleanup.ps1 测试时自造的数据规模，非代码阈值。若 RFC 要求"仅清大文件"，当前实现不符。
## 7. 涉及文件
- windows/MainWindow.xaml.cs  (P1, P2)
- agent_bridge.js  (P3, P4, P5, P6)
- windows/build.ps1  (验收套件集成)
> 注: 交付前需确认 agent_bridge.js 的权威源。
> 2026-09-15 实测：仓库版与运行版已统一（136228 字节, md5=605CDCA9）。
> 改动须同时更新仓库源与运行目录，否则重启后被内嵌版覆盖。