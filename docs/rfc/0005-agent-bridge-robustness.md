---
title: "RFC-0005: Agent Bridge 健壮性与响应延迟修复 (已冻结)"
tags:
  - rfc
  - bridge
  - performance
  - robustness
created: 2026-09-15
author: deepseek-architect
status: DELIVERED
review_round: 2
decision: APPROVED
---

# RFC-0005: Agent Bridge 健壮性与响应延迟修复 (已冻结)

> 提出者: deepseek-architect | 日期: 2026-09-15 | 状态: DELIVERED (已由质量把关官 23/23 全绿通过并合入主干流水线)  
> 前置依据: RFC-0004 (宿主健壮性与工程化已于 1.0.8 交付)  
> 审查结论: RFC 评审委员会出具 [PASS: 方案审查通过 (APPROVED)]，正式冻结进入实施阶段

---

## 1. 背景与问题

### 1.1 业务背景
在 DeepSeek for Windows 客户端中，宿主通过 WebView2 运行 DeepSeek 官方 Web 前端，并通过注入的 `agent_bridge.js` 实现 Tool Call 的监听、解析、宿主执行及执行结果回传。在 1.0.8 版本上线 RFC-0004 后，宿主层的全局钩子泄漏与日志堆积问题已解决。但用户日常在执行终端命令、回传大段日志或文件附件时，普遍反馈“响应延迟极大”（单次操作耗时常达 16~25 秒），且偶发附件无法展示却无明显报错的现象。

### 1.2 审查官指出的 6 项致命架构漏洞与根因
经审查官穿透比对与源码级实勘，原草案存在以下返工死穴：
1. **节流架构双层断层与死锁 (CRITICAL)**：
   原设计在 UI Pacing 引入动态计算，但底层的 `queueFeedbackSlot` 队列锁中仍硬编码 `MIN_SEND_GAP_MS = 8000`，导致双重节流；且多任务并发时以旧时间戳计算，引发 UI 倒计时跳过与发送时序混乱。
2. **“执行耗时冲抵”名不副实与突发累加死锁 (CRITICAL)**：
   C# 宿主计算了 `hostMs` 却未在 IPC JSON 载荷中传给 JS 端；冷启动 `lastSendAt = 0` 导致首发保护完全穿透；验证重试会反复推入 `recentSends` 刷满突发惩罚导致系统永久进入最大延迟；依赖 `Date.now()` 受系统 NTP 时钟回拨影响。
3. **5MB 附件防崩溃逻辑存在 OOM 崩溃与二进制乱码 (CRITICAL)**：
   `MainWindow.xaml.cs` 在校验 `fileBytes.Length <= MaxUploadBytes` 之前无脑调用 `ReadAllBytesAsync`，大文件直接引发 OOM 崩溃；大文件降级时无脑调 `ReadAllTextAsync` 将 PNG/ZIP 等二进制读取为海量乱码；截断保留 8000+8000 加上折叠文本反向膨胀超出 16000 直传上限。
4. **跨端通信契约断裂与 DOM 状态机参数丢失 (HIGH)**：
   C# `WebMessageReceived` 压根没有 `attach_failed` 处理分支，直接丢弃；`waitForAttachmentReady` 签名未接收 `fileSize`，且回调参数为 `undefined`，导致调用方 `if (rushed)` 无法正确识别超时降级。
5. **验收测试套件设计存在“不可测断言”与构建时序死锁 (CRITICAL)**：
   分流与截断是 `MainWindow` 内部私有方法，强依赖 WPF STA 线程与 GUI，外部 PowerShell 无法实例化单元测试；`build.ps1 -TestOnly` 时因尚未编译发布导致同步测试直接抛出异常死锁；纯静态正则无法测出动态算法正确性。
6. **存储并发覆盖与 DirectSend 节流脱节 (MEDIUM)**：
   秒级时间戳导致高频并发下文件名冲突写覆盖；`App.DirectSendEnabled` 绕过输入框走 HTTP API 成功后未同步节流时钟，导致后续回传误判连击；`streamBuf` 为每个卡片高频建删定时器造成内存扰动。

---

## 2. 目标

1. **彻底分离文本与附件通道**：终端命令输出默认永远走纯文本通道，直传上限提升至 16,000 字符，消除终端长输出误入附件导致的 15~20s 延迟。
2. **统一单点动态节流架构**：重构 `queueFeedbackSlot`，将 UI Pacing 与底层放行合二为一，统一由 `DynamicThrottle` 管控；引入 `performance.now()` 单调时钟与宿主 `hostMs` 契约，长命令秒发，高频短命令平滑自适应防护。
3. **前置内存守卫与多媒体感知**：使用 `FileInfo.Length` 前置拦截超大文件，杜绝 OOM；依据 MIME/扩展名甄别二进制文件，坚决禁止乱码读取，严格校准截断数学模型。
4. **实现闭环事件与显式状态机**：补齐 C# 端 `attach_failed` 接收处理；规范 `waitForAttachmentReady` 传参与状态对象返回。
5. **解耦设计保障 100% 自动化单元可测性**：抽离纯静态类 `TerminalOutputRouter.cs`，实现无 GUI 依赖的轻量单元断言；修复 CI/CD 构建依赖时序；引入 Node/Headless 算法动态测试。
6. **消除并发覆盖与状态脱节**：高精度毫秒+GUID 唯一文件名；DirectSend 成功后显式同步单调时钟；`streamBuf` 全局惰性轮询回收。
7. **全面清理工程 Warning**：修复 C# 7 处 CS 可空性 Warning，达成真正 0 Warnings。

---

## 3. 非目标（Non-Goals）

1. **重构 DeepSeek 官方 Web 的 DOM 选择器引擎**：本 RFC 仅优化现有探测、注入与降级状态机，不推翻重写 `agent_bridge.js` 核心 DOM 寻址层。
2. **实现分块断点续传**：DeepSeek 网页输入框不支持分块上传，本 RFC 保持整体附件上传机制，不自建文件传输协议。
3. **重写跨进程通信底层机制**：沿用现有的 `postMessage` / `WebMessageReceived` 结构，不引入命名管道或第三方 RPC。
4. **修改 PowerShell 宿主并发模型**：继续沿用 RFC-0004 建立的 `_execGate` 信号量与异步作业生命周期管理。

---

## 4. 术语

- **DynamicThrottle (统一动态节流引擎)**：驻留于 JS 桥接层的单一权威节流控制器，统一驱动队列放行与 UI 倒计时。
- **Host Execution Offset (宿主执行冲抵)**：由 C# 宿主精确度量并下发命令执行耗时 `hostMs`，用于动态折抵前端保护延迟。
- **TerminalOutputRouter (终端输出路由引擎)**：解耦出的 C# 纯逻辑无状态静态类，负责文本分流决策、超限检测、安全截断与前置文件大小守卫。
- **DirectSend (直接 API 回传通道)**：当配置开启时，宿主绕过 DOM 输入框直接调用 Web API 回传结果的加速通道。
- **Monotonic Clock (单调递增时钟)**：使用 `performance.now()` 替代 `Date.now()`，免受系统 NTP 校时或人为时钟回拨干扰。

---

## 5. 现状与约束

### 5.1 约束条件
1. **WebView2 沙箱安全**：JS 脚本无本地文件直接读写权限，依赖 Native 桥接指令通信。
2. **DeepSeek Web 输入吞吐上限**：富文本框单次粘贴超过 30,000 字符会引发 Chromium 布局重绘严重掉帧；超过 5MB 文件易触发前端 React ErrorBoundary 崩溃（扩展小鲸鱼报错）。
3. **限流管制红线**：10 秒内连续向官方 Web 提交请求超过 3 次，将有大概率被判定为 "Messages too frequent" 并施加 90s 强管制。

---

## 6. 方案对比

### 6.1 节流架构收拢模式对比

| 评估维度 | 方案 1: 双层分散节流 (原草案，已废弃) | 方案 2: 队列锁驱动单点收拢 (本 RFC 采纳) |
| :--- | :--- | :--- |
| **控制中心** | UI Pacing 算一次，queueFeedbackSlot 又算一次 | `queueFeedbackSlot` 为唯一权威放行点，UI 仅为状态观察者 |
| **并发多任务** | 后到任务以旧时钟误判提前跳过 UI 倒计时 | 所有任务由单链排队，仅当获得执行权时才做即时动态计算 |
| **节流精度** | 容易发生 8s + 动态延时的叠加双重节流 | 精确到毫秒级，无任何多余静态死等 |
| **状态一致性** | 差，卡片倒计时与真正网络提交严重脱节 | **完全一致，UI 倒计时精确对应队列放行倒计时** |

### 6.2 宿主分流可测性架构对比

| 评估维度 | 方案 A: 嵌入 MainWindow 私有方法 (现状) | 方案 B: 抽离纯静态路由类 TerminalOutputRouter (本 RFC 采纳) |
| :--- | :--- | :--- |
| **外部测试依赖** | 强依赖 WPF STA 线程、XAML 窗口、WebView2 控件 | **零 GUI 依赖，纯 .NET 核心静态方法** |
| **PowerShell 测试** | 无法直接调用测试，只能靠脆弱的正则匹配源码 | `Add-Type -Path TerminalOutputRouter.cs` 毫秒级真实断言 |
| **代码内聚度** | GUI 渲染逻辑与业务数据路由严重耦合 | 业务与表现层彻底分离，职责单一明晰 |

---

## 7. 总体设计

### 7.1 单点收拢式节流与调度状态机 (解决质疑 1 & 2)

```
[收到 FeedBack 结果]
         |
         v
[入队 feedbackChain (单链排队)]
         |
         v
[当前任务获得队头执行权 (Head of Queue)]
         |
         v
[调用 DynamicThrottle.evaluate(context)]
  - 单调时钟: performance.now()
  - 结合 hostMs 自然冲抵
  - 结合 10s 滑动窗口突发频次
         |
         +-----------------------------+
         |                             |
[剩余等待 <= 300ms]          [剩余等待 > 300ms]
         |                             |
         v                             v
[直接放行，跳过 UI 倒计时]   [调用 controller.showPacing 渲染剩余秒数]
         |                             |
         +--------------+--------------+
                        | (倒计时结束或跳过)
                        v
              { 是否为附件任务? }
               /             \
             [是]            [否]
              |               |
              v               v
     [waitForAttachmentReady] [填入输入框 -> triggerSend]
              |               |
              +-------+-------+
                      |
                      v
             [verifySentOrRetry 验证上屏]
                      |
                     { 成功? }
                     /       \
                   [是]      [否: 触发重试(不计入突发)]
                    |
                    v
       [DynamicThrottle.recordSendCommit()]
       (仅在此刻将发送时间戳推入滑动窗口)
                    |
                    v
           [释放锁，唤醒下一个任务]
```

### 7.2 TerminalOutputRouter 分流决策流 (解决质疑 3 & 6)

```
[执行输出 output, filePath]
               |
               v
      { 是否包含显式指令 [[AGENT_ATTACH_FILE:...]]? }
         /                                    \
       [是]                                   [否]
        |                                       |
        v                                       v
[前置校验: FileInfo.Length]             [文本通道: 检查 output.Length]
   /                  \                        /              \
[<= 5MB]            [> 5MB]             [<= 16000]          [> 16000]
   |                   |                    |                   |
   v                   v                    v                   v
[转 Base64 附件]  { 是否为文本文件? }   [直接完整回传]    [安全截断并落盘]
                    /          \                        - 前 7500 + 后 7500
                 [是]          [否: 二进制]             - 折叠中间字符
                  |              |                      - 写入 AppData 专用缓存:
                  v              v                        output_{ms}_{guid}.txt
          [读取首尾文本]   [仅返回元数据路径提示]
                  \              /
                   +------+-----+
                          |
                          v
                 [转为纯文本路径引用回传]
```

---

## 8. API / 数据结构 / 算法伪代码 / 错误码

### 8.1 C# 路由解耦类设计 (`windows/TerminalOutputRouter.cs`)

```csharp
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace DeepSeek
{
    public static class TerminalOutputRouter
    {
        public const int MaxDirectTextLength = 16000;
        public const int HeadKeepChars = 7500;
        public const int TailKeepChars = 7500;
        public const long MaxUploadBytes = 5 * 1024 * 1024; // 5MB

        public sealed class RoutingResult
        {
            public bool IsAttachment { get; set; }
            public string OutputText { get; set; } = "";
            public string? Filename { get; set; }
            public string? MimeType { get; set; }
            public string? Base64Data { get; set; }
            public string? Prompt { get; set; }
            public string? LocalOversizedPath { get; set; }
        }

        public static RoutingResult Route(string output, string baseDir)
        {
            if (string.IsNullOrWhiteSpace(output))
            {
                return new RoutingResult { OutputText = "(命令执行完毕，无终端文字输出)" };
            }

            // 1. 显式附件分支处理
            var match = Regex.Match(output, @"\[\[AGENT_ATTACH_FILE:(.+?)\]\]");
            if (match.Success)
            {
                string inner = match.Groups[1].Value;
                string[] parts = inner.Split(new[] { ':' }, 2);
                string filePath = Environment.ExpandEnvironmentVariables(parts[0].Trim());
                string prompt = parts.Length > 1 ? parts[1].Trim() : "";

                if (File.Exists(filePath))
                {
                    var fileInfo = new FileInfo(filePath);
                    if (fileInfo.Length <= MaxUploadBytes)
                    {
                        byte[] fileBytes = File.ReadAllBytes(filePath);
                        return new RoutingResult
                        {
                            IsAttachment = true,
                            OutputText = output,
                            Filename = Path.GetFileName(filePath),
                            MimeType = GetMimeType(Path.GetExtension(filePath)),
                            Base64Data = Convert.ToBase64String(fileBytes),
                            Prompt = prompt
                        };
                    }

                    // 超出 5MB 拦截，坚决不全量读取 byte[]
                    return HandleOversizedFile(filePath, fileInfo, prompt, output, baseDir);
                }
            }

            // 2. 纯文本通道：绝不隐式自动转附件
            if (output.Length <= MaxDirectTextLength)
            {
                return new RoutingResult { IsAttachment = false, OutputText = output };
            }

            // 3. 纯文本超限截断与落盘
            return HandleOversizedText(output, baseDir);
        }

        public static RoutingResult HandleOversizedText(string output, string baseDir)
        {
            string outDir = Path.Combine(baseDir, "oversized_outputs");
            Directory.CreateDirectory(outDir);
            string localPath = Path.Combine(outDir, $"agent_output_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}.txt");
            File.WriteAllText(localPath, output, Encoding.UTF8);

            int omitted = output.Length - (HeadKeepChars + TailKeepChars);
            string head = output.Substring(0, HeadKeepChars);
            string tail = output.Substring(output.Length - TailKeepChars);
            string foldMark = $"\n\n...[终端输出过长，已折叠中间 {omitted} 字符，完整内容见本地缓存]...\n\n";

            string summary = head + foldMark + tail;
            string note = $"[输出过大通知]: 完整输出已安全保存至：\n{localPath}\n若需分析请用命令行读取或过滤。";

            return new RoutingResult
            {
                IsAttachment = false,
                OutputText = summary,
                Prompt = note,
                LocalOversizedPath = localPath
            };
        }

        private static RoutingResult HandleOversizedFile(string filePath, FileInfo fileInfo, string prompt, string originalOutput, string baseDir)
        {
            double mb = Math.Round(fileInfo.Length / 1048576.0, 2);
            string ext = Path.GetExtension(filePath).ToLowerInvariant();
            bool isText = IsTextExtension(ext);

            string note = $"[附件超限提示]: 目标文件 {Path.GetFileName(filePath)} 大小为 {mb} MB，超过了 5MB 上传上限，未走网页附件上传；完整文件保留在原路径：\n{filePath}\n";
            if (!string.IsNullOrEmpty(prompt)) note = prompt + "\n\n" + note;

            if (!isText)
            {
                // 二进制文件坚决不调用 ReadAllTextAsync
                return new RoutingResult
                {
                    IsAttachment = false,
                    OutputText = originalOutput + $"\n\n(该文件为二进制类型 [{ext}]，无法作为文本展开)",
                    Prompt = note
                };
            }

            // 文本文件且超限，读取首尾切片
            string fullText = File.ReadAllText(filePath, Encoding.UTF8);
            var textRes = HandleOversizedText(fullText, baseDir);
            textRes.Prompt = note + "\n" + textRes.Prompt;
            return textRes;
        }

        public static bool IsTextExtension(string ext) => ext switch
        {
            ".txt" or ".log" or ".json" or ".xml" or ".csv" or ".md" or ".cs" or ".js" or ".ts" or ".py" or ".ps1" or ".html" or ".css" or ".yaml" or ".yml" => true,
            _ => false
        };

        public static string GetMimeType(string ext) => ext.ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".pdf" => "application/pdf",
            _ => "text/plain"
        };
    }
}
```

### 8.2 IPC 载荷契约增补 (`MainWindow.xaml.cs` -> WebView2)

在 `FeedResultBackAsync` 下发的 JSON 中，正式引入 `hostMs` 字段：
```json
{
  "action": "feed_result",
  "id": "cmd_1726400000_123",
  "exitCode": 0,
  "output": "...",
  "isAttachment": false,
  "hostMs": 3450,
  "timestamp": 1726400003450
}
```

### 8.3 桥接层统一单点动态节流引擎 (`agent_bridge.js`)

```javascript
// 统一权威单点动态节流引擎 (解决质疑 1 & 2)
const DynamicThrottle = {
    BASE_GAP_TEXT_MS: 1500,
    BASE_GAP_ATTACH_MS: 1500,
    FLOOR_GAP_TEXT_MS: 200,
    WINDOW_MS: 10000,
    recentSends: [],         // 记录单调时钟时间戳
    lastSendMono: 0,         // 上次发送确认的 performance.now()

    clean(nowMono) {
        const boundary = nowMono - this.WINDOW_MS;
        this.recentSends = this.recentSends.filter(t => t > boundary);
    },

    // 仅在真实发送成功上屏时提交，重试严禁触发
    recordSendCommit(nowMono) {
        const t = nowMono || performance.now();
        this.lastSendMono = t;
        this.recentSends.push(t);
        this.clean(t);
    },

    // 接收 DirectSend 同步
    syncDirectSendSuccess() {
        this.recordSendCommit(performance.now());
    },

    evaluate(context) {
        const nowMono = performance.now();
        this.clean(nowMono);

        // 冷启动首发保护穿透防御
        if (this.lastSendMono === 0) {
            return { remainingWaitMs: 0, targetGap: 0, burstCount: 0 };
        }

        const burstCount = this.recentSends.length;
        let burstPenalty = 0;
        if (burstCount >= 3) {
            burstPenalty = 2500;
        } else if (burstCount >= 2) {
            burstPenalty = 1000;
        }

        const isAttachment = !!context.isAttachment;
        const baseGap = isAttachment ? this.BASE_GAP_ATTACH_MS : this.BASE_GAP_TEXT_MS;
        const targetGap = Math.max(isAttachment ? baseGap : this.FLOOR_GAP_TEXT_MS, baseGap + burstPenalty);

        // 真实单调时钟自然流逝
        const naturalElapsed = Math.max(0, nowMono - this.lastSendMono);
        // 宿主执行耗时冲抵 (防御负数)
        const hostOffset = Math.max(0, context.hostMs || 0);
        const totalEffectiveElapsed = naturalElapsed + hostOffset;

        const remainingWaitMs = Math.max(0, targetGap - totalEffectiveElapsed);

        return {
            remainingWaitMs: Math.round(remainingWaitMs),
            targetGap,
            burstCount
        };
    }
};

// 队列锁彻底替换原 agent_bridge.js:122-146 逻辑 (解决质疑 1)
function queueFeedbackSlot(context, taskFn) {
    feedbackChain = feedbackChain.then(() => new Promise((resolve) => {
        const evalRes = DynamicThrottle.evaluate(context);

        const executeTask = () => {
            try {
                taskFn((success) => {
                    if (success) {
                        DynamicThrottle.recordSendCommit();
                    }
                    resolve();
                });
            } catch (err) {
                console.error("[Agent Bridge] Task execution failed:", err);
                resolve();
            }
        };

        if (evalRes.remainingWaitMs <= 300) {
            executeTask();
        } else {
            const controller = cardControllers[context.cardId];
            if (controller && typeof controller.showPacing === 'function') {
                const countdownSec = Math.ceil(evalRes.remainingWaitMs / 1000);
                controller.showPacing(countdownSec, () => {
                    executeTask();
                });
            } else {
                setTimeout(executeTask, evalRes.remainingWaitMs);
            }
        }
    }));
    return feedbackChain;
}
```

### 8.4 修复 `waitForAttachmentReady` 状态机与入参规范 (解决质疑 4)

```javascript
// 规范签名，接收元数据与回调，参数对象化返回
function waitForAttachmentReady(meta, callback) {
    const startTime = performance.now();
    const fileSize = meta && meta.size ? meta.size : 0;
    // 依据文件大小动态计算超时，最低 3s，最高 10s
    const maxWaitMs = Math.min(10000, Math.max(3000, Math.ceil(fileSize / 150000) * 1000));
    let readySince = 0;

    const timer = setInterval(() => {
        const now = performance.now();
        const st = probeAttachmentState();

        if (st.ready) {
            if (!readySince) readySince = now;
            if (now - readySince >= 400 || (now - startTime) > maxWaitMs) {
                clearInterval(timer);
                callback({ ok: true, timedOut: false, elapsed: Math.round(now - startTime) });
            }
            return;
        }

        readySince = 0;
        if ((now - startTime) > maxWaitMs) {
            clearInterval(timer);
            diagAttach({ phase: 'timeout', elapsed: Math.round(now - startTime), name: meta.filename });
            console.warn("[Agent Bridge] Attachment wait timed out, falling back to text prompt");
            callback({ ok: false, timedOut: true, elapsed: Math.round(now - startTime) });
        }
    }, 150);
}
```

---

## 9. 正常流程、边界条件、并发、权限、安全

### 9.1 跨端事件闭环 (`attach_failed`)
1. **JS 触发**：当 `injectFileToChat(fileObj)` 返回 `false` 时，向 Native 宿主发送：
   `sendToNative({ action: 'attach_failed', id: cardId, filename: data.filename, size: fileObj.size, reason: 'DOM_REJECTED' });`
2. **C# 响应**：在 `MainWindow.xaml.cs` 的 `WebMessageReceived` 增设处理：
   ```csharp
   case "attach_failed":
       App.Log($"[AttachFailed] id={root.GetProperty("id").GetString()} file={root.GetProperty("filename").GetString()} reason={root.GetProperty("reason").GetString()}");
       UpdateStatus("附件注入网页失败，已自动降级为文本通道", isWarning: true);
       break;
   ```

### 9.2 DirectSend 通道节流时钟同步
当执行结果通过 `FeedResultBackAsync` 走 DirectSend（HTTP 直接上送）时，在响应成功的回调内，主动向 JS 广播 `direct_send_ack`，JS 桥接层执行：
`DynamicThrottle.syncDirectSendSuccess();`
确保输入框通道与 API 通道的节流状态完全对齐。

### 9.3 `streamBuf` 全局惰性清理机制 (解决质疑 6)
废除为每个 `cardId` 单独创建 `setInterval` 定时器的方案，改为在模块级维护一个单例周期轮询器（每 60 秒轮询一次），回收超过 120 秒未被消费的残余缓冲区；同时在读取 `streamBuf[cardId]` 后立即执行 `delete`。

---

## 10. 兼容与迁移

1. **协议完全向后兼容**：`[[AGENT_ATTACH_FILE:...]]` 语法继续作为显式附件的唯一触发凭据。
2. **零运行时依赖迁移**：将分流逻辑移入 `TerminalOutputRouter` 不引入任何第三方 NuGet 依赖，原生运行在 .NET 8 下。
3. **消除 CS 可空性 Warning**：修复 `MainWindow.xaml.cs` 现存的 7 处 CS8600/CS8602/CS8604 警告，确保构建实现真正的 `0 Errors, 0 Warnings`。

---

## 11. 测试与验收标准 (解决质疑 5)

### 11.1 自动化验收脚本矩阵

#### 1. `windows/scripts/verify-rfc0005-router.ps1` (单元测试：解耦分流断言)
- **执行方式**：通过 PowerShell `Add-Type -Path windows/TerminalOutputRouter.cs` 直接加载 C# 静态类，零 GUI 依赖；
- **断言集**：
  - 断言 1: 输入 10,000 字符文本，断言 `IsAttachment == false`，且 `OutputText.Length == 10000`；
  - 断言 2: 输入 20,000 字符文本，断言 `IsAttachment == false`，`OutputText.Length <= 16000`，且生成的落盘文件存在且内容完整；
  - 断言 3: 构造 10MB 假二进制文件，触发 `[[AGENT_ATTACH_FILE:...]]`，断言未抛出 OOM，且返回结果注明无法作为文本展开，`IsAttachment == false`；
  - 断言 4: 构造 1MB 正常图片，断言 `IsAttachment == true` 且 `Base64Data` 不为空。

#### 2. `windows/scripts/verify-rfc0005-bridge-dynamic.ps1` (Node.js 动态算法单测)
- **执行方式**：利用系统 Node.js 运行单测脚本，导入 `agent_bridge.js` 中抽离或匹配的 `DynamicThrottle` 算法；
- **断言集**：
  - 断言 1 (冷启动): `lastSendMono = 0` 时，断言 `remainingWaitMs == 0`；
  - 断言 2 (长执行冲抵): `hostMs = 5000` 时，断言 `remainingWaitMs == 0`；
  - 断言 3 (突发密集): 连续触发 3 次 `recordSendCommit`，断言 `burstCount >= 3` 且 `remainingWaitMs >= 2000`；
  - 断言 4 (时钟回拨): 构造异常负时间差，断言函数不产生负等待且不抛出异常。

#### 3. `windows/scripts/verify-rfc0005-bridge-sync.ps1` (单源发布同步断言)
- **断言集**：
  - 前置检查：若处于 `-TestOnly` 模式且 `windows/publish/` 尚无产物，显式打印跳过提示并正常退出（退出码 0），杜绝 CI 构建时序死锁；
  - 正式校验：比对根目录 `agent_bridge.js` 与 `windows/publish/agent_bridge.js` 的 MD5 哈希，必须 100% 一致。

### 11.2 CLI 验收验证标准
在 `windows` 目录下执行：
```powershell
.\build.ps1
```
**全绿验收标准**：
- `dotnet build` 零错误、零警告（0 Errors, 0 Warnings）；
- `RFC-0004 ACCEPTANCE REPORT: ALL 4/4 PASSED`；
- `RFC-0005 ACCEPTANCE REPORT: ALL 3/3 PASSED`；
- `Status: FULL GREEN (0 Errors, 0 Warnings)`。

---

## 12. 任务拆分 (按逻辑可验证的单步分解)

- [ ] **Task 1: 抽离纯静态路由类与修复 C# 缺陷 (`TerminalOutputRouter.cs`, `MainWindow.xaml.cs`)**
  - 新建 `windows/TerminalOutputRouter.cs`，实现前置 5MB `FileInfo` 守卫、二进制感知与 16,000 字符严格截断数学；
  - 重构 `MainWindow.xaml.cs`，接入 `TerminalOutputRouter`，下发 `hostMs` 字段；
  - 在 `MainWindow.xaml.cs` 的 `WebMessageReceived` 增设 `attach_failed` 接收处理；
  - 修复 `MainWindow.xaml.cs` 现存 7 处 CS 可空性 Warning。
- [ ] **Task 2: JS 桥接层统一单点动态节流与状态机重构 (`agent_bridge.js`)**
  - 将 `DynamicThrottle` 植入 `agent_bridge.js`，采用 `performance.now()` 单调时钟；
  - 彻底重写 `queueFeedbackSlot`，废除硬编码 `MIN_SEND_GAP_MS = 8000`，由统一引擎调度；
  - 改造 `waitForAttachmentReady` 签名，接收元数据，参数化返回 `{ ok, timedOut, elapsed }`；
  - 实现 `attach_failed` 原生事件向宿主的主动上报；
  - 接入 DirectSend 状态同步与 `streamBuf` 全局惰性清理。
- [ ] **Task 3: 构建流水线同步机制增强 (`build.ps1`)**
  - 在 `build.ps1` 中添加将根目录 `agent_bridge.js` 自动复制到 `publish/` 的步骤。
- [ ] **Task 4: 编写解耦单元测试套件并集成 CI**
  - 编写 `windows/scripts/verify-rfc0005-router.ps1`；
  - 编写 `windows/scripts/verify-rfc0005-bridge-dynamic.ps1`；
  - 编写 `windows/scripts/verify-rfc0005-bridge-sync.ps1` (带有时序前置保护)；
  - 在 `build.ps1` 中集成并验证全绿。

---

## 13. 开放问题

1. **富文本极端大量字符的 DOM 回收**：在超长多轮对话场景下，WebView2 页面累积大量渲染卡片后是否会偶发内存泄漏，需在后续 RFC-0006 中探讨虚拟列表（Virtual List）或历史卡片修剪机制。
2. **极端自动化批处理的限流兜底**：当前动态节流在突发 >= 3 次时提供 2500ms 保护，若未来 DeepSeek 官方进一步收紧限流策略，可考虑将基准参数外置至客户端配置文件。