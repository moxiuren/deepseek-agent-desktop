(function() {
    // Re-entry guard via the functional export (no extra marker global).
    if (typeof window !== 'undefined' && window.__agentBridge) return;
    // Defence-in-depth: any unexpected init failure must be LOUD, never silently leave the
    // native side calling into an undefined window.__agentBridge.
    try {

    // Cross-platform native bridge dispatcher (supports macOS WebKit & Windows Edge WebView2)
    function sendToNative(data) {
        try {
            if (window.chrome?.webview?.postMessage) {
                window.chrome.webview.postMessage(data);
            } else if (window.webkit?.messageHandlers?.agentBridge?.postMessage) {
                window.webkit.messageHandlers.agentBridge.postMessage(data);
            }
        } catch(e) {
            _origErr?.("[sendToNative error]", e);
        }
    }

    // Forward console logs to native host.
    // Wrapped in Proxy so toString checks still see native code.
    const _origLog = console.log;
    const _origErr = console.error;
    function stealthWrapFn(fn, trap) {
        try {
            return new Proxy(fn, { apply: function(t, th, args) { return trap(t, th, args); } });
        } catch (_) {
            return fn;
        }
    }
    console.log = stealthWrapFn(_origLog, function(t, th, args) {
        Reflect.apply(t, th, args);
        sendToNative({
            action: "log",
            message: Array.prototype.map.call(args, a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        });
    });
    console.error = stealthWrapFn(_origErr, function(t, th, args) {
        Reflect.apply(t, th, args);
        sendToNative({
            action: "log",
            message: "[JS_ERROR] " + Array.prototype.map.call(args, a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        });
    });

    console.log("[Agent Bridge] Initializing Tool Call Engine v4.3.26 (Cross-Platform Edition)...");

    // Dynamic OS detection for DeepSeek Planner instructions
    const isWindows = typeof navigator !== 'undefined' && (navigator.userAgent.includes("Windows") || (navigator.platform && navigator.platform.startsWith("Win")));
    const osPlatform = isWindows ? "Windows (PowerShell)" : "macOS (Zsh)";

    const SYSTEM_PROMPT = `【系统协议：本地 ${osPlatform} Agent 闭环模式已激活】
你是 DeepSeek Agent，拥有控制本机的执行权限。
开工第一步：先用 local_cmd 读你的灵魂文件 \`~/Documents/ObsidianVault/02-System-Rules/Agent-Soul.md\`，读完简短确认，之后一切按它行事（它是你唯一的长效记忆契约，会话重启即失忆）。

【你有的能力】（每轮只输出一个代码块，真实结果会自动回来）：
\`\`\`local_cmd
<PowerShell 命令> 或 agy -p "<完整无歧义指令>" --model gemini-3.8-flash-low --effort low --dangerously-skip-permissions
\`\`\`
\`\`\`write_file:目标路径
文件内容
\`\`\`
LONG FILES (>150 lines): do NOT paste via write_file (streaming truncates). Emit a local_cmd PowerShell generator instead (loops or Here-String) that creates the file, then verify with Get-Item .Length.
Start-Job works natively via host ThreadJob backend (same Job objects: Wait-Job/Receive-Job/Remove-Job all work). Prefer it for background work; local_cmd:async fence remains for the detached lane.
ASYNC LONG TASKS (over 60s, e.g. image gen): open the fence as local_cmd:async (fence-line local_cmd:async). The command runs detached without blocking the queue; progress polls automatically; the final result returns to session. Quick commands stay sync.
（查文件跑脚本走 local_cmd，工作目录 ~/Documents/Projects；写文件走 write_file 自动建目录；agy 的 -p 与免确认必须带，跨目录加 \`--add-dir "目录"\`；截屏用 agent-screenshot，挂大文件用 agent-attach，二者裸发单行即执行，也可包在 local_cmd 块里。）

【闭环规则】：每次只输出一个代码块等真实结果，不编造；收到结果再决策；做完直接总结。铁律六条：①write_file 内容没准备好就别发块，空块会被直接忽略（无回执）；②local_cmd 发前自查括号配对 ()[]{}，配不平桥接层不会执行；③连 9222/CDP 前先跑 Get-NetTCPConnection -LocalPort 9222，无监听直接报"端口已退役"，不硬连；④Exit:1 且报错含 not recognized / Unexpected token / Missing expression → 说明命令被提取错了，换写法重发，严禁原样重发；⑤命令源码禁连续三个反引号（渲染层提前闭合必碎成多块），围栏内容一律用 [char]96 拼接，写 Markdown 文件优先 write_file；⑥write_file 头路径一律用正斜杠（渲染层会吞掉反斜杠加下划线这类转义对，致静默落错位置）；必须用反斜杠时改走首行 file 指令注释行。
【搜索纪律】：禁裸扫全盘——用户目录根/盘符根/注册表递归必须带 -Depth（≤3），先 Desktop/Documents/Projects，禁 AppData；护栏会直接打回无 -Depth 的裸扫；确需全量加注释 #scan-ok。
请确认收到，并等待用户指令。`;

    let autoExecute = true;
    let isExecutingNow = false;
    let isFeedbackPending = false;
    let executingStartedAt = 0;
    let feedbackPendingStartedAt = 0;
    // Last dispatch signature for duplicate merging.
    let lastDispatch = { cmd: '', at: 0 };
    // Serializes feedback sends: each feedback fills+clicks only after the
    // previous send is confirmed (its completion request left) — never assume
    // a click worked, or stale text sits in the box with no retry.
    let feedbackChain = Promise.resolve();
    let prevSendAt = 0;
    let prevAcked = true;
    const BACKOFF_MS = 90000;
    let lastAutoSendAt = 0;
    let rateLimitBackoffUntil = 0;
    let lastRateLimitHandledAt = 0;
    let lastFeedbackForRetry = { text: '', at: 0 };
    let backoffRetried = false;

    // 统一权威单点动态节流引擎 (RFC-0005 Section 8.3)
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

            const isAttachment = !!(context && context.isAttachment);
            const baseGap = isAttachment ? this.BASE_GAP_ATTACH_MS : this.BASE_GAP_TEXT_MS;
            const targetGap = Math.max(isAttachment ? baseGap : this.FLOOR_GAP_TEXT_MS, baseGap + burstPenalty);

            // 真实单调时钟自然流逝
            const naturalElapsed = Math.max(0, nowMono - this.lastSendMono);
            // 宿主执行耗时冲抵 (防御负数)
            const hostOffset = Math.max(0, (context && context.hostMs) || 0);
            const totalEffectiveElapsed = naturalElapsed + hostOffset;

            let remainingWaitMs = Math.max(0, targetGap - totalEffectiveElapsed);

            // 限流退避兜底
            if (typeof rateLimitBackoffUntil !== 'undefined' && rateLimitBackoffUntil > 0) {
                const backoffRem = Math.max(0, rateLimitBackoffUntil - Date.now());
                if (backoffRem > remainingWaitMs) {
                    remainingWaitMs = backoffRem;
                }
            }

            return {
                remainingWaitMs: Math.round(remainingWaitMs),
                targetGap,
                burstCount
            };
        }
    };

    // v4.3.4 receipt integrity (P1.3): dispatch→result correlation + stream accumulation.
    const pendingDispatch = new Map();
    let lastDispatchAt = 0;
    const streamBuf = {};
    const streamBufTime = {};
    // RFC-0005 9.3: 全局 60s 惰性清理轮询器，回收超过 120s 未被消费的残余缓冲区
    setInterval(() => {
        try {
            const now = Date.now();
            for (const cid in streamBufTime) {
                if (now - streamBufTime[cid] > 120000) {
                    delete streamBuf[cid];
                    delete streamBufTime[cid];
                }
            }
        } catch (_) {}
    }, 60000);

    // v4.3.7 async lane (P1-b): background job poll timers keyed by cardId.
    const jobPollTimers = {};
    // v4.3.14 A' overlay 插件 thin API: 规划模式机械 enforcement + 单一 prompt 源。
    // local_cmd 文件意图不可解析——shell 侧仍靠提示词纪律；write_file 由机械层硬拒。
    let planMode = false;
    // v4.3.12 send-baseline: sampled at INJECT time (before our own send stamps the
    // request-time ack). verify compares against this, not against a post-send sample.
    let lastInjectAckBase = 0;
    function startJobPoll(cardId, jobId) {
        try { if (jobPollTimers[cardId]) clearInterval(jobPollTimers[cardId]); } catch (_) {}
        let n = 0;
        jobPollTimers[cardId] = setInterval(() => {
            n++;
            if (n > 200 || !cardControllers[cardId]) {
                try { clearInterval(jobPollTimers[cardId]); } catch (_) {}
                try { delete jobPollTimers[cardId]; } catch (_) {}
                return;
            }
            try { sendToNative({ action: 'job_poll', jobId: jobId, id: cardId }); } catch (_) {}
        }, 3000);
    }

    // 队列锁彻底替换原 agent_bridge.js 逻辑 (RFC-0005 Section 8.3)
    function queueFeedbackSlot(contextOrFn, maybeTaskFn) {
        const context = (typeof contextOrFn === 'function') ? {} : (contextOrFn || {});
        const taskFn = (typeof contextOrFn === 'function') ? contextOrFn : maybeTaskFn;

        feedbackChain = feedbackChain.then(() => new Promise((resolve) => {
            const evalRes = DynamicThrottle.evaluate(context);

            const executeTask = () => {
                const controller = context.cardId ? cardControllers[context.cardId] : null;
                if (controller && typeof controller.hidePacing === 'function') {
                    try { controller.hidePacing(); } catch (_) {}
                }
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
                const controller = context.cardId ? cardControllers[context.cardId] : null;
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
    // Timestamp (ms) of the last successful injectFileToChat, for upload correlation.
    let __attachInjectedAt = 0;
    let cardControllers = {};
    let blockWatchMap = new Map();
    let cmdWatchMap = new Map();
    let pendingFeedbackTimer = null;
    // Direct-loop virtual queue: replies arriving out-of-band are scanned here
    // and dispatched one at a time (the page stays a passive viewport).
    let virtualQueue = [];
    let directDepth = 0;
    let lastDirectReplySig = '';
    let lastDirectReplyAt = 0;
    // Processed/collapsed tracking lives in WeakSets, NOT data-* attributes,
    // so our bookkeeping leaves no DOM fingerprints.
    const processedBlocks = new WeakSet();
    const processedSignatures = new Set();
    function addProcessedSig(sig) {
        if (!sig) return;
        if (processedSignatures.size > 200) {
            const arr = Array.from(processedSignatures);
            processedSignatures.clear();
            arr.slice(-100).forEach(s => processedSignatures.add(s));
        }
        processedSignatures.add(sig);
    }
    const collapsedBubblesSet = new WeakSet();
    // Hide our window globals from enumeration (Object.keys/for-in).
    function hideGlobal(name) {
        try { Object.defineProperty(window, name, { enumerable: false }); } catch (_) {}
    }

    function isQuoteBalanced(cmd) {
        // NOTE: PowerShell's escape char is the BACKTICK, not backslash.
        // Treating \ as escape breaks every Windows path ending in \'
        // (the string then looks forever-unbalanced and the call never fires).
        // Also skip # line comments when outside quotes so apostrophes in comments (e.g. # Don't) don't wedge the parser.
        let inDouble = false;
        let inSingle = false;
        let escaped = false;
        const lines = String(cmd || '').split(/\r?\n/);
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            for (let i = 0; i < line.length; i++) {
                let ch = line[i];
                if (escaped) { escaped = false; continue; }
                if (ch === '`') { escaped = true; continue; }
                if (!inSingle && !inDouble && ch === '#') break;
                if (ch === '"' && !inSingle) inDouble = !inDouble;
                else if (ch === "'" && !inDouble) inSingle = !inSingle;
            }
        }
        return !inDouble && !inSingle;
    }

    function isBracketBalanced(cmd) {
        // v4.1: 与 isQuoteBalanced 同哲学——只做"等待"门，不做硬拒绝。
        // 跳过单/双引号串（含 PowerShell 反引号转义）与 # 行注释，只核 ()[]{} 配对+类型。
        const pairs = { ')': '(', ']': '[', '}': '{' };
        const stack = [];
        let inDouble = false, inSingle = false, escaped = false;
        const lines = String(cmd || '').split('\n');
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (escaped) { escaped = false; continue; }
                if (ch === '`') { escaped = true; continue; }
                if (!inSingle && !inDouble && ch === '#') break;
                if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
                if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
                if (inSingle || inDouble) continue;
                if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
                else if (ch === ')' || ch === ']' || ch === '}') {
                    if (!stack.length || stack.pop() !== pairs[ch]) return false;
                }
            }
        }
        return stack.length === 0 && !inDouble && !inSingle;
    }

    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes agent-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .agent-tool-card {
            transition: all 0.25s ease;
        }
    `;
    // NOTE (Windows/WebView2 port fix): this script is registered via
    // AddScriptToExecuteOnDocumentCreatedAsync, which -- unlike WKWebView's
    // .atDocumentStart on macOS -- fires when the document is COMPLETELY EMPTY:
    // both document.documentElement and document.head are still null. The original
    // eager `document.head.appendChild(style)` threw a TypeError, aborted this IIFE,
    // and left window.__agentBridge undefined, so every native call silently no-op'd
    // behind the `window.__agentBridge && ...` short-circuit. Defer until a root exists.
    function whenRootReady(fn) {
        if (document.head || document.documentElement) { fn(); return; }
        document.addEventListener('DOMContentLoaded', fn, { once: true });
        const t = setInterval(() => {
            if (document.head || document.documentElement) { clearInterval(t); fn(); }
        }, 30);
    }
    whenRootReady(() => {
        (document.head || document.documentElement).appendChild(style);
    });

    // 1. Floating HUD
    function createFloatingHUD() {
        if (document.getElementById('deepseek-agent-hud')) return;
        // Same document-creation hazard as the <style> insert above: the MutationObserver
        // watching documentElement can fire before <body> has been parsed.
        if (!document.body) return;

        const hud = document.createElement('div');
        hud.id = 'deepseek-agent-hud';
        hud.style.cssText = `
            position: fixed;
            top: 12px;
            right: 20px;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(255, 255, 255, 0.94);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(59, 130, 246, 0.35);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
            border-radius: 20px;
            padding: 5px 12px;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
            font-size: 12px;
            color: #1e293b;
            user-select: none;
        `;


        hud.innerHTML = `
            <div style="display: flex; align-items: center; gap: 6px; font-weight: 600;">
                <span id="agent-hud-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block;"></span>
                <span id="agent-hud-text" style="color: #0f172a;">Tool Call 引擎就绪</span>
            </div>
            <div style="width: 1px; height: 14px; background: #cbd5e1;"></div>
            <button id="agent-toggle-btn" style="
                background: rgba(0,0,0,0.05);
                color: #334155;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
                padding: 4px 8px;
                font-size: 11px;
                cursor: pointer;
            ">自动执行: 开</button>
        `;

        document.body.appendChild(hud);


        const toggleBtn = document.getElementById('agent-toggle-btn');
        toggleBtn.addEventListener('click', () => {
            autoExecute = !autoExecute;
            toggleBtn.textContent = autoExecute ? "自动执行: 开" : "自动执行: 暂停";
            toggleBtn.style.color = autoExecute ? "#334155" : "#ef4444";
            updateHUD(autoExecute ? "Tool Call 引擎就绪" : "已暂停自动执行", autoExecute ? "#10b981" : "#f59e0b");
        });
    }

    // v4.3.16 fallback inject: the overlay capsule is the primary protocol entry.
    // The core keeps a self-healing fallback that exists ONLY while the capsule is
    // absent (plugin failed to load / unloaded / removed). Either direction heals
    // within one scan tick: capsule appears -> fallback removed; capsule gone -> fallback added.
    // (New sessions also get the base protocol auto-injected — buttons are re-inject convenience.)
    function reconcileInjectFallback() {
        try {
            if (!document.body) return;
            const hasCapsule = !!document.getElementById('agent-mode-capsule');
            let fb = document.getElementById('agent-inject-fallback-btn');
            if (hasCapsule) {
                if (fb && fb.parentNode) { try { fb.parentNode.removeChild(fb); } catch (_) {} }
                return;
            }
            if (fb) return;
            const hud = document.getElementById('deepseek-agent-hud');
            if (!hud) return;
            fb = document.createElement('button');
            fb.id = 'agent-inject-fallback-btn';
            fb.title = 'overlay 胶囊缺失时的核心兜底（注入基础协议）';
            fb.style.cssText = 'background:#2563eb;color:#ffffff;border:none;border-radius:12px;padding:4px 10px;font-size:11px;font-weight:500;cursor:pointer;';
            fb.textContent = '注入协议';
            fb.addEventListener('click', () => { try { injectPrompt(SYSTEM_PROMPT, true); } catch (_) {} });
            hud.appendChild(fb);
        } catch (_) {}
    }

    function updateHUD(text, color) {
        const textEl = document.getElementById('agent-hud-text');
        const dotEl = document.getElementById('agent-hud-dot');
        if (textEl) textEl.textContent = text;
        if (dotEl) dotEl.style.background = color || "#10b981";
    }

    function escapeHtml(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // v4.3.4 DSML 污染净化（P0.1）。DeepSeek 客户端偶发把内部工具标记（DSML）
    // 当正文混入 local_cmd / write_file：形如 </parameter>、<invoke>、</calls>，
    // DSML 变体如 <|DSML| parameter>，竖线可能是 ASCII | / 全角 ｜(U+FF5C) / │(U+2502)。
    // 只剥离“尾部连续污染行/尾巴”，正文中间的不动，避免误伤正常内容。
    const DSML_TAG_LINE = /^\s*<\/?[^>\n]*DSML[^>\n]*>\s*$/i;
    const DSML_BARE_TAIL = /^\s*<\/?(parameter|invoke|calls|result)(\s[^>\n]*)?\/?>\s*$/i;
    function stripDsmlPollution(text) {
        try {
            let s = String(text == null ? '' : text);
            if (!/DSML/i.test(s) && !/<\/?(parameter|invoke|calls|result)[\s>\/]/i.test(s)) return s;
            const lines = s.split('\n');
            while (lines.length && (DSML_TAG_LINE.test(lines[lines.length - 1]) || DSML_BARE_TAIL.test(lines[lines.length - 1]))) lines.pop();
            s = lines.join('\n');
            s = s.replace(/(\s*<\/?[^>\n]*DSML[^>\n]*>\s*)+$/i, '');
            s = s.replace(/(\s*<\/?(parameter|invoke|calls|result)(\s[^>\n]*)?\/?>\s*)+$/i, '');
            return s;
        } catch (_) { return text; }
    }
    function utf8len(s) { try { return new TextEncoder().encode(String(s || '')).length; } catch (_) { return String(s || '').length; } }
    // v4.3.4 危险通配符拒收（P3.7）。Windows 下 Remove-Item -Filter 'X.*' 会连本体一起匹配。
    function refuseDangerousWildcard(cmd) {
        try {
            const c = String(cmd || '');
            if (/\bRemove-Item\b[^\n]*-Filter\s+['"][^'"]*\.\*['"]/i.test(c)) {
                return '[已拒绝] Remove-Item -Filter 含 ".*" 尾缀：在 Windows 下会额外匹配无后缀本体（如 X.md.* 命中 X.md），极易误删。请改用 Vault 唯一入口 02-System-Rules/tools/vs.py 预览确认后再删。';
            }
            if (/\bRemove-Item\b/i.test(c) && !/-WhatIf\b/i.test(c) &&
               /(?:^|\n)\s*Remove-Item\b[^\n]*?['"]?[^'"\n\s]*\*['"]?\s*$/im.test(c)) {
                return '[已拒绝] Remove-Item 目标以裸 * 结尾且无 -WhatIf。请先加 -WhatIf 预演，或走 vs.py 唯一入口。';
            }
        } catch (_) {}
        return null;
    }

    function extractPureCommand(blockNode) {
        let codeEl = blockNode.querySelector('.md-code-block-content code, pre code, code');
        let rawText = codeEl ? (codeEl.innerText || codeEl.textContent) : (blockNode.innerText || blockNode.textContent);

        // v4.3.19: strip fence delimiters ONLY at head/tail. Inner fence
        // lines (N-backtick outer wrapping ``` content, e.g. here-strings
        // writing markdown) are legitimate command content and must survive.
        const rawLines = (rawText || '').split(/\r?\n/);
        while (rawLines.length && !rawLines[0].trim()) rawLines.shift();
        while (rawLines.length && !rawLines[rawLines.length - 1].trim()) rawLines.pop();
        // leading open-fence line incl. "- ```local_cmd" list form (v4.3/v4.3.1)
        if (rawLines.length && /^\s*(-\s*)?`{3,}\s*(local_cmd|bash|sh|powershell|pwsh|write_file|write-file)\b/i.test(rawLines[0])) rawLines.shift();
        // trailing close-fence line
        if (rawLines.length && /^\s*`{3,}\s*$/.test(rawLines[rawLines.length - 1])) rawLines.pop();
        const lines = rawLines.filter(line => {
            const t = line.trim();
            if (!t) return false;
            if (t === 'Copy' || t === 'Download' || t === '复制' || t === '下载') return false;
            if (t.includes('local_cmdCopyDownload')) return false;
            if (/^(?:local_cmd|bash|sh|powershell|pwsh)\b/i.test(t)) return false;
            if (/local_cmd/i.test(t) && /(?:Copy|Download|复制|下载)/i.test(t)) return false;
            return true;
        });

        return stripDsmlPollution(lines.join('\n').trim());
    }

    // Direct File Output Protocol Helpers
    function isValidFilePath(p) {
        if (!p || typeof p !== 'string') return false;
        p = p.trim().replace(/^["'`]|["'`]$/g, '').replace(/-->|\*\/$/, '').trim();
        if (!p || p.length < 2) return false;
        if (p.includes(' ') || p.includes('\t') || p.includes('\n')) return false;

        const hasSlash = p.includes('/') || p.includes('\\');
        const hasExt = /\.[a-zA-Z0-9_-]{1,10}$/.test(p);
        const isSpecialFile = /^(?:Makefile|Dockerfile|Gemfile|Vagrantfile|Procfile|\.gitignore|\.env.*|\.bashrc|\.zshrc)$/i.test(p);

        return hasSlash || hasExt || isSpecialFile;
    }

    // Path sanitizer for write_file candidates: strips UI button residue and
    // trailing punctuation, then enforces isValidFilePath. Branches 1-3 MUST
    // go through this (they previously accepted any non-space token, so words
    // like "in"/"is" or placeholders became real files).
    function cleanPathCandidate(raw) {
        if (!raw || typeof raw !== 'string') return null;
        let p = raw.trim().replace(/^["'`]|["'`]$/g, '').trim();
        p = p.replace(/(?:Copy|Download|复制|下载)+$/g, '').trim();
        p = p.replace(/[.,;:)\]}`'"]+$/g, '').trim();
        if (!p || p.length < 2) return null;
        return isValidFilePath(p) ? p : null;
    }

    function detectFileWriteBlock(blockNode) {
        if (!blockNode) return null;

        const codeEl = blockNode.querySelector('.md-code-block-content code, pre code, code');
        const fullText = (blockNode.innerText || blockNode.textContent || '').trim();
        const banner = blockNode.querySelector('[class*="banner"], [class*="infostring"], [class*="header"], [class*="lang"]');
        const bannerText = (banner ? (banner.innerText || banner.textContent || '') : '').trim();
        const codeClass = codeEl ? (codeEl.className || '') : '';

        let filePath = null;
        let isExplicitWriteFile = false;

        // 1. Explicit write_file: in banner or header
        let m = bannerText.match(/(?:write_file|write-file):\s*([^\s\n\r]+)/i);
        if (m && m[1]) {
            filePath = cleanPathCandidate(m[1]);
            isExplicitWriteFile = !!filePath;
        }

        // 2. Explicit write_file: in code class (e.g. language-write_file:path)
        if (!filePath && codeClass) {
            m = codeClass.match(/language-(?:write_file|write-file):([^\s]+)/i);
            if (m && m[1]) {
                filePath = cleanPathCandidate(m[1]);
                isExplicitWriteFile = !!filePath;
            }
        }

        // 3. Explicit write_file: fence tag at block START only (unanchored
        // matches mid-discussion text, e.g. protocol explanations, which must
        // never become files).
        if (!filePath) {
            const wIdx = fullText.search(/write_file:/i);
            if (wIdx !== -1 && wIdx < 120) {
                m = fullText.match(/write_file:\s*([^\s\n\r]+)/i);
                if (m && m[1]) {
                    filePath = cleanPathCandidate(m[1]);
                    isExplicitWriteFile = !!filePath;
                }
            }
        }

        // 4. file: in banner (e.g. ```file:path/to/file)
        if (!filePath) {
            m = bannerText.match(/^file:\s*([^\s\n\r]+)/i);
            if (m && m[1] && isValidFilePath(m[1])) {
                filePath = m[1].trim().replace(/^["'`]|["'`]$/g, '');
            }
        }

        // 5. Check first non-empty line of code block for # file: /path or // file: /path
        const rawText = codeEl ? (codeEl.innerText || codeEl.textContent) : fullText;
        const lines = (rawText || '').split(/\r?\n/);
        let firstLineIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim()) {
                firstLineIdx = i;
                break;
            }
        }

        let isCommentDirective = false;
        if (firstLineIdx !== -1) {
            const line = lines[firstLineIdx].trim();
            const commentMatch = line.match(/^(?:#|\/\/|\/\*|--|;|<!--)\s*(?:file|filepath|path):\s*([^\s*]+)/i);
            if (commentMatch && commentMatch[1]) {
                const cand = commentMatch[1].trim().replace(/^["'`]|["'`]$/g, '').replace(/-->|\*\/$/, '').trim();
                if (isValidFilePath(cand)) {
                    if (!filePath) {
                        filePath = cand;
                    }
                    isCommentDirective = true;
                }
            }
        }

        if (!filePath) return null;

        // Clean any leftover quotes or brackets
        filePath = filePath.replace(/^["'`]|["'`]$/g, '').replace(/-->|\*\/$/, '').trim();
        if (!filePath) return null;

        return {
            path: filePath,
            isCommentDirective,
            firstLineIdx,
            isExplicitWriteFile
        };
    }

    function extractFileContent(blockNode, fileInfo) {
        let codeEl = blockNode.querySelector('.md-code-block-content code, pre code, code');
        let rawText = codeEl ? (codeEl.innerText || codeEl.textContent) : (blockNode.innerText || blockNode.textContent);
        let lines = (rawText || '').split(/\r?\n/);

        // If block has comment directive on first non-empty line, remove that line
        if (fileInfo && fileInfo.isCommentDirective && fileInfo.firstLineIdx !== -1) {
            lines.splice(fileInfo.firstLineIdx, 1);
        } else {
            // Check if first non-empty line starts with write_file: or file: (in case parser put fence tag into code)
            let firstIdx = lines.findIndex(l => l.trim().length > 0);
            if (firstIdx !== -1 && lines[firstIdx].trim().match(/^(?:write_file|write-file|file):\s*/i)) {
                lines.splice(firstIdx, 1);
            }
        }

        // If fallback to blockNode (no codeEl), strip UI artifacts like 'Copy' or 'Download'
        if (!codeEl) {
            lines = lines.filter(line => {
                const t = line.trim();
                if (!t) return true;
                if (t === 'Copy' || t === 'Download' || t === '复制' || t === '下载') return false;
                if (t.startsWith('write_file:') || t.startsWith('file:')) return false;
                return true;
            });
        }

        let content = lines.join('\n');
        // v4.1: BOM(U+FEFF, 下行正则内为不可见字符) + 界面残留行清理（codeEl 路径此前零过滤，UI 文本会直接进文件体）。
        content = content.replace(/^﻿/, '');
        const residueRe = /^(Copy|Download|复制|下载)$/;
        let cl = content.split(/\r?\n/);
        while (cl.length && (cl[0].trim() === '' || residueRe.test(cl[0].trim()))) cl.shift();
        while (cl.length && (cl[cl.length - 1].trim() === '' || residueRe.test(cl[cl.length - 1].trim()))) cl.pop();
        content = cl.join('\n');
        // Clean single leading newline if created by splicing first line
        content = content.replace(/^\r?\n/, '');
        return stripDsmlPollution(content);
    }

    // 2. Render Tool Call Card UI (Clean Terminal output inside DeepSeek's side)
    function renderToolCallCard(targetNode, command, onExecute, type = 'cmd', meta = {}) {
        const cardId = 'tool-card-' + Math.random().toString(36).substring(2, 9);
        const card = document.createElement('div');
        card.id = cardId;
        card.className = 'agent-tool-card';
        const isFile = (type === 'write_file');
        card.style.cssText = `
            margin: 14px 0;
            border: 1.5px solid ${isFile ? '#0d9488' : '#3b82f6'};
            border-radius: 12px;
            overflow: hidden;
            background: #ffffff;
            box-shadow: 0 4px 18px rgba(${isFile ? '13, 148, 136' : '59, 130, 246'}, 0.14);
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        `;

        let icon = '⚡️';
        let headerTitle = '本地工具调用 (TOOL CALL)';
        let headerGradient = 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)';
        let headerBorder = '#bfdbfe';
        let headerTitleColor = '#1e40af';
        let tagLabel = 'LOCAL SHELL';
        let tagBg = '#2563eb';
        let subTextPrefix = '$ ';
        let subTextColor = '#f8fafc';
        let subTextContent = command;

        if (isFile) {
            icon = '📝';
            headerTitle = '本地文件直接写入 (DIRECT FILE WRITE)';
            headerGradient = 'linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%)';
            headerBorder = '#99f6e4';
            headerTitleColor = '#0f766e';
            tagLabel = meta.path || 'FILE WRITE';
            tagBg = '#0d9488';
            subTextPrefix = 'TARGET: ';
            subTextColor = '#2dd4bf';
            subTextContent = meta.path || '';
        } else if (command.includes('agy') || command.includes('agy-run')) {
            tagLabel = 'GEMINI 3.8 FLASH (LOW)';
            tagBg = '#7c3aed';
        } else if (command.includes('mimo')) {
            tagLabel = 'MIMO V2.5';
            tagBg = '#ea580c';
        }

        card.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: ${headerGradient}; border-bottom: 1px solid ${headerBorder};">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 16px;">${icon}</span>
                    <span style="font-weight: 700; font-size: 12px; color: ${headerTitleColor}; letter-spacing: 0.3px;">${headerTitle}</span>
                    <span style="background: ${tagBg}; color: #ffffff; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 5px; font-family: ui-monospace, monospace;">${tagLabel}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div id="${cardId}-status" style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: ${isFile ? '#0d9488' : '#d97706'};">
                        <span class="spinner" style="display: inline-block; width: 10px; height: 10px; border: 2px solid ${isFile ? '#0d9488' : '#d97706'}; border-top-color: transparent; border-radius: 50%; animation: agent-spin 0.8s linear infinite;"></span>
                        <span class="status-msg">${isFile ? '准备写入...' : '准备执行...'}</span>
                    </div>
                    <button id="${cardId}-btn" style="background: ${isFile ? '#0d9488' : '#2563eb'}; color: #fff; border: none; border-radius: 8px; padding: 4px 10px; font-size: 11px; font-weight: 500; cursor: pointer; transition: background 0.2s;">
                        ▶ ${isFile ? '重新写入' : '重新运行'}
                    </button>
                </div>
            </div>
            <div style="padding: 10px 14px; background: #0f172a; color: #38bdf8; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12.5px; line-height: 1.5; border-bottom: 1px solid #1e293b; overflow-x: auto;">
                <span style="color: #64748b; user-select: none;">${subTextPrefix}</span><span style="color: ${subTextColor}; font-weight: 500;">${escapeHtml(subTextContent)}</span>
            </div>
            <div id="${cardId}-output-box" style="padding: 10px 14px; background: #090d16; color: #10b981; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.5; max-height: 240px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;">
                <span style="color: #64748b; font-style: italic;">[${isFile ? '等待文件写入完成...' : '等待终端执行输出...'}]</span>
            </div>
            <div id="${cardId}-pacing-bar" style="display: none; padding: 6px 14px; background: #f0fdf4; border-top: 1px solid #bbf7d0; font-size: 11px; color: #15803d; align-items: center; justify-content: space-between;">
                <span id="${cardId}-pacing-text">⏱ 防频控保护：正在准备同步给 DeepSeek...</span>
                <button id="${cardId}-send-now-btn" style="background: #16a34a; color: #fff; border: none; border-radius: 6px; padding: 2px 8px; font-size: 10px; cursor: pointer;">立即发送</button>
            </div>
        `;

        targetNode.style.display = 'none';
        targetNode.parentNode.insertBefore(card, targetNode.nextSibling);

        const controller = {
            cardId,
            command,
            type,
            isFile,
            meta,
            setStatus: (msg, color, isSpinning) => {
                const st = document.getElementById(`${cardId}-status`);
                if (st) {
                    st.style.color = color;
                    st.innerHTML = `
                        ${isSpinning ? '<span style="display: inline-block; width: 10px; height: 10px; border: 2px solid ' + color + '; border-top-color: transparent; border-radius: 50%; animation: agent-spin 0.8s linear infinite;"></span>' : ''}
                        <span>${msg}</span>
                    `;
                }
            },
            setOutput: (output, isError) => {
                const out = document.getElementById(`${cardId}-output-box`);
                if (!out) return;
                out.style.color = isError ? "#f87171" : "#34d399";
                out.textContent = output;
                // Long outputs start folded (toggle to expand) so the page
                // isn't a wall of terminal text; model still gets full text.
                // If live streaming already showed content, keep the viewer's
                // current folded/visible state instead of yanking it.
                try {
                    if (out.dataset.streaming) {
                        const tog2 = document.getElementById(`${cardId}-output-toggle`);
                        if (tog2) tog2.textContent = out.style.display === 'none' ? `展开输出 (${output.length} 字符)` : '收起输出';
                        return;
                    }
                    let tog = document.getElementById(`${cardId}-output-toggle`);
                    if (output && output.length > 600) {
                        out.style.display = 'none';
                        if (!tog) {
                            tog = document.createElement('button');
                            tog.id = `${cardId}-output-toggle`;
                            tog.style.cssText = 'background:#0f172a;color:#7dd3fc;border:1px solid #1e3a5f;border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer;margin:6px 14px;font-family:inherit;';
                            tog.onclick = () => {
                                const hidden = out.style.display === 'none';
                                out.style.display = hidden ? '' : 'none';
                                tog.textContent = hidden ? '收起输出' : `展开输出 (${output.length} 字符)`;
                            };
                            out.parentNode.insertBefore(tog, out);
                        }
                        tog.style.display = '';
                        tog.textContent = `展开输出 (${output.length} 字符)`;
                    } else if (tog) {
                        tog.style.display = 'none';
                        out.style.display = '';
                    }
                } catch (_) {}
            },
            showPacing: (seconds, onSendNow) => {
                const bar = document.getElementById(`${cardId}-pacing-bar`);
                const text = document.getElementById(`${cardId}-pacing-text`);
                const sendBtn = document.getElementById(`${cardId}-send-now-btn`);
                if (bar) bar.style.display = 'flex';
                if (text) text.textContent = `⏱ 防频控保护：将在 ${seconds} 秒后自动同步给 DeepSeek...`;
                if (sendBtn) {
                    sendBtn.onclick = onSendNow;
                }
            },
            hidePacing: () => {
                const bar = document.getElementById(`${cardId}-pacing-bar`);
                if (bar) bar.style.display = 'none';
            },
            appendStream: (chunk) => {
                const out = document.getElementById(`${cardId}-output-box`);
                if (!out) return;
                try {
                    if (!out.dataset.streaming) {
                        out.dataset.streaming = "1";
                        out.textContent = "";
                        out.style.color = "#34d399";
                    }
                    out.textContent += chunk + "\n";
                    out.scrollTop = out.scrollHeight;
                    const tog = document.getElementById(`${cardId}-output-toggle`);
                    if (tog && out.style.display === 'none') {
                        tog.textContent = `展开输出 (${out.textContent.length} 字符，仍在输出…)`;
                    }
                } catch (_) {}
            }
        };

        const btn = document.getElementById(`${cardId}-btn`);
        btn.addEventListener('click', () => {
            if (onExecute) {
                onExecute(command, controller);
            } else if (isFile) {
                executeFileWrite(meta.path, command, controller);
            } else {
                executeCommand(command, controller);
            }
        });

        cardControllers[cardId] = controller;
        return controller;
    }

    // Helper: Safely resolve the latest assistant message container scope.
    // Explicitly distinguishes assistant vs user-feedback containers so that model thoughts
    // or assistant preamble quoting "[Tool Call" never poison or reject valid execution scopes.
    function resolveScanScope() {
        try {
            const containers = document.querySelectorAll('[class*="chat-item"], [class*="message-item"], [class*="message"], [role="article"], [data-message-id], .ds-markdown');
            for (let i = containers.length - 1; i >= 0; i--) {
                const c = containers[i];
                // STRICTLY skip thinking/reasoning scratchpads (DeepSeek-R1 CoT)
                try {
                    if (c.closest && c.closest('.ds-think-content, [class*="think"], [class*="thought"], [data-testid*="think"]')) {
                        continue;
                    }
                    if (c.className && /think|thought/i.test(String(c.className))) continue;
                } catch (_) {}

                let t = '';
                try { t = c.textContent || ''; } catch (_) {}
                const isAssistant = (c.classList && c.classList.contains('ds-assistant-message-main-content')) ||
                                    !!c.querySelector('.ds-assistant-message-main-content');
                // Only skip explicit user feedback bubbles; NEVER skip assistant messages
                const isUserFeedback = !isAssistant && (
                    t.trim().startsWith('[Tool Call') ||
                    t.trim().startsWith('【本地工具执行结果') ||
                    (c.className && c.className.includes('d29f3d7d')) ||
                    !!c.querySelector('.agent-collapsed-pill')
                );
                if (isUserFeedback) continue;
                let hasCode = false, ownUi = false;
                try {
                    hasCode = !!c.querySelector('pre, code, [class*="code-block"], [class*="codeBlock"], .md-code-block') ||
                              /(?:^|\n)\s*(?:-\s*)?```\s*(?:local_cmd|bash|sh|powershell|pwsh|write_file)/i.test(t);
                    // Check if ALL code blocks inside this container are already processed
                    const pBlocks = c.querySelectorAll('.md-code-block, pre:not(.md-code-block pre)');
                    let allProcessed = (pBlocks.length > 0);
                    for (let pb of pBlocks) {
                        const pCode = (pb.innerText || '').trim();
                        const sig = 'cmd:' + pCode.replace(/\s+/g, ' ').trim();
                        if (!processedBlocks.has(pb) && !processedSignatures.has(sig)) { allProcessed = false; break; }
                    }
                    ownUi = allProcessed && !!c.querySelector('[id^="agent-"], [id^="tool-card-"], .agent-tool-card');
                } catch (_) {}
                if (ownUi || !hasCode) continue;
                return { scope: c, index: i };
            }
        } catch (_) {}
        return { scope: null, index: -1 };
    }

    // v4.3.25: bare built-in lane -- matches a message/block whose whole text
    // is exactly a native instruction (C# TryHandleBuiltInCommandAsync
    // intercepts pre-shell). Returns the trimmed command or null.
    function matchBareBuiltIn(text) {
        const t = String(text == null ? '' : text).trim();
        const m = t.match(/^(agent-screenshot(\s[\s\S]*)?|agent-attach\s+\S[\s\S]*)$/i);
        return m ? m[1].trim() : null;
    }

    // 3. Scanner with Debounce & Quote Verification
    function scanAndProcessToolCalls() {
        if (isExecutingNow || isFeedbackPending) return;

        const blocks = document.querySelectorAll('pre, [class*="code-block"], [class*="codeBlock"], .md-code-block');
        const now = Date.now();

        // Scope whitelist: only blocks inside the LATEST message-like container
        // may start a call. Falls back to unscoped when the site DOM matches nothing.
        const { scope: scanScope } = resolveScanScope();

        let foundAny = false;

        for (let el of blocks) {
            // STRICTLY skip any code blocks inside thinking/reasoning scratchpads
            try {
                if (el.closest && el.closest('.ds-think-content, [class*="think"], [class*="thought"], [data-testid*="think"]')) {
                    continue;
                }
            } catch (_) {}

            if (processedBlocks.has(el)) continue;

            const parent = el.closest('.md-code-block, [class*="code-block"]:not([class*="banner"]):not([class*="header"]), [class*="codeBlock"]') || el;
            if (processedBlocks.has(parent)) continue;

            // Never scan our own UI (HUD / tool cards / collapsed pills).
            try {
                if (el.closest && el.closest('[id^="agent-"], [id^="tool-card-"], .agent-tool-card, .agent-collapsed-pill')) continue;
            } catch (_) {}

            // Never treat our own feedback bubbles as fresh calls: they quote
            // previous output AND contain the local_cmd keyword in instructions,
            // which would otherwise re-execute old results in a loop.
            // v4.3.18 P0: NEVER skip on the bare marker -- commands that merely
            // mention it (e.g. isToolReturn判据) are valid. Only skip when the
            // full feedback signature is present inside our own card context.
            try {
                const scopeText = parent.innerText || parent.textContent || '';
                const inOwnCard = !!(el.closest && el.closest('[id^="agent-"], [id^="tool-card-"], .agent-tool-card, .agent-collapsed-pill'));
                if (scopeText.includes('[Tool Call Result (Exit:') && (inOwnCard || /若需继续执行|local_cmd\s*代码块/.test(scopeText))) continue;
            } catch (_) {}

            if (scanScope && !scanScope.contains(parent)) continue;

            const fileInfo = detectFileWriteBlock(parent);
            const isFileWrite = !!fileInfo;

            const fullText = (parent.innerText || parent.textContent || '').trim();
            const banner = parent.querySelector('[class*="banner"], [class*="infostring"], [class*="header"], [class*="lang"]');
            const bannerText = (banner ? (banner.innerText || banner.textContent || '') : '').trim();
            const elCls = (el.className || '');
            const parentCls = (parent.className || '');
            let codeLang = '';
            try { const ce = parent.querySelector('.md-code-block-content code, pre code, code'); codeLang = ce ? (ce.className || '') : ''; } catch (_) {}

            const lines = fullText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const firstLine = lines[0] || '';

            // v4.3.1: 围栏与语言标记双通道检测
            // 1. 语言标签匹配（banner / infostring / class）
            const isCmdLang = /^(local_cmd|bash|sh|powershell|pwsh)\b/i.test(bannerText) ||
                              /^local_cmd/i.test(bannerText) ||
                              /language-(local_cmd|bash|sh|powershell|pwsh)\b/i.test(codeLang + ' ' + parentCls + ' ' + elCls);

            // 2. 文本第一行或内容中带围栏标记
            const hasFencePattern = /^(?:-\s*)?(?:`{3,})?\s*(local_cmd|bash|sh|powershell|pwsh)\b/i.test(firstLine) ||
                                    /^local_cmd(?:Copy|Download|复制|下载)/i.test(firstLine) ||
                                    /(?:^|\n)\s*(?:-\s*)?`{3,}\s*(local_cmd|bash|sh|powershell|pwsh)\b/i.test(fullText);

            // 3. 显式其他语言防护（如 ```text, ```json 等，防讨论 local_cmd 关键字时被误判）
            const isOtherExplicitLang = bannerText && !/^(local_cmd|bash|sh|powershell|pwsh)\b/i.test(bannerText) &&
                /^(text|txt|json|markdown|md|python|py|javascript|js|typescript|ts|html|css|yaml|yml|sql|c|cpp|csharp|cs|go|rust|rs)\b/i.test(bannerText);

            const hasCmdFence = isCmdLang || hasFencePattern;
            const mentionsLocalCmd = fullText.includes('local_cmd') || elCls.includes('local_cmd') || parentCls.includes('local_cmd') || bannerText.includes('local_cmd');
            // v4.3.25: bare built-in lane -- the prompt advertises these as
            // instructions, so an exactly-matching block dispatches.
            const isBareBuiltIn = !!matchBareBuiltIn(fullText);

            const isLocalCmd = !isFileWrite && !isOtherExplicitLang && (
                                (mentionsLocalCmd && hasCmdFence) ||
                                isCmdLang ||
                                isBareBuiltIn ||
                                fullText.includes('agy-run') ||
                                fullText.includes('agy --model') ||
                                fullText.includes('opencode run'));

            if (!isLocalCmd && !isFileWrite) continue;
            foundAny = true;
            // v4.3.7 async lane (P1-b): explicit `local_cmd:async` infostring routes to host background jobs.
            const isAsyncCall = /local_cmd:async/i.test(bannerText + '\n' + firstLine) || /`{3,}\s*local_cmd:async/i.test(fullText);

            let cleanCmd = "";
            let fileContent = "";
            let trackKey = "";
            let signature = "";

            if (isFileWrite) {
                fileContent = extractFileContent(parent, fileInfo);
                trackKey = fileInfo.path + "::" + fileContent;
                signature = 'write:' + fileInfo.path + ':' + fileContent.length;
            } else {
                cleanCmd = extractPureCommand(parent);
                if (!cleanCmd || cleanCmd.length < 2) continue;
                trackKey = cleanCmd;
                signature = 'cmd:' + cleanCmd.replace(/\s+/g, ' ').trim();
            }

            // Anti-duplicate: if this exact signature was already processed, skip re-execution across React re-renders!
            if (processedSignatures.has(signature)) {
                processedBlocks.add(el);
                processedBlocks.add(parent);
                continue;
            }

            // Debounce (dual-keyed: DOM node identity + content signature to survive React re-renders)
            let tracker = blockWatchMap.get(parent);
            if (!tracker && cmdWatchMap.has(trackKey)) {
                tracker = cmdWatchMap.get(trackKey);
                blockWatchMap.set(parent, tracker);
            }
            if (!tracker) {
                tracker = { text: trackKey, lastChange: now };
                blockWatchMap.set(parent, tracker);
                cmdWatchMap.set(trackKey, tracker);
                continue;
            }

            if (tracker.text !== trackKey) {
                tracker.text = trackKey;
                tracker.lastChange = now;
                continue;
            }

            // If SSE stream completion was recorded within the last 15s, content is stable -> allow 800ms debounce
            const streamDone = (window.__lastCompletionAt && (now - window.__lastCompletionAt >= 500) && (now - window.__lastCompletionAt < 15000));
            const debounceThreshold0 = streamDone ? 800 : 1800;
            let debounceThreshold = debounceThreshold0;
            let dispatchGateCause = 'fast';
            // v4.3.5 write completion gate (P0-b): long files stream for minutes; a bare
            // 1800ms DOM-quiet gap mid-stream is NOT completeness (P4: 320 lines -> 82,
            // last line half-cut). Writes dispatch only when the stream ended AFTER the
            // last content change, or after 10s of DOM quiet. Cmds keep the fast path
            // (bracket/quote gates cover partials there).
            if (isFileWrite) {
                const lastChg = (tracker && tracker.lastChange) || 0;
                const completedAfterChange = (window.__lastCompletionAt || 0) > lastChg;
                if (completedAfterChange) { debounceThreshold = 800; dispatchGateCause = 'stream-settled'; }
                else { debounceThreshold = 10000; dispatchGateCause = 'quiet-10s'; }
            }

            if (now - tracker.lastChange < debounceThreshold) {
                continue;
            }

            if (!isFileWrite && (!isQuoteBalanced(cleanCmd) || !isBracketBalanced(cleanCmd))) {
                console.log("[Agent Bridge] Waiting for balanced quotes/brackets:\n", cleanCmd);
                continue;
            }

            // v4.2: HTML 内容绝不送执行（vcp-root/HTML 卡片文本曾多次被误当命令跑，用户 2026-09-13 拍板下掉整条线）。
            // 只拦 local_cmd 分支；要求"含 HTML 标签 + 闭合标签/vcp-root"双条件，正常命令误伤率≈0。
            if (!isFileWrite && /<[a-zA-Z][^>]*>/.test(cleanCmd) && /<\/(div|span|style|html|body)>|vcp-root/i.test(cleanCmd)) {
                console.log("[Agent Bridge] HTML-looking content, skip execution (no-exec, no-feedback).");
                continue;
            }

            // v4.1: 空文件内容直接吞掉（此前送 DLL 必被拒 Exit:1 → 模型重发空块死循环，见 2026-09-13 #3/#7）。
            // 不标记 processed：流式补全中会自动进入；永远空则永远不执行、零噪音。
            if (isFileWrite && (!fileContent || !fileContent.trim())) {
                console.log("[Agent Bridge] Empty file content, skip (no-exec, no-feedback): " + (fileInfo && fileInfo.path));
                continue;
            }

            // v4.3.4 streaming partial guard (P0.2): an OPEN fence with no CLOSING fence
            // means the model is still writing; dispatching now = silent truncation.
            // Rendered code shapes carry no backticks at all and pass through untouched.
            if (isFileWrite && /```\s*(?:write_file|write-file|file)\s*:/i.test(fullText) && !/\n\s*```\s*$/.test(fullText)) {
                continue;
            }
            if (!isFileWrite && /```\s*(?:local_cmd|bash|sh|powershell|pwsh)\b/i.test(fullText) && !/\n\s*```\s*$/.test(fullText)) {
                continue;
            }

            processedBlocks.add(el);
            processedBlocks.add(parent);
            if (scanScope) processedBlocks.add(scanScope);
            addProcessedSig(signature);
            blockWatchMap.delete(parent);
            cmdWatchMap.delete(trackKey);

            if (isFileWrite) {
                console.log(`[Agent Bridge] Complete File Write Detected. Target: ${fileInfo.path} (${fileContent.length} chars)`);
                try { diagAttach({ phase: 'dispatch-write', v: '4.3.5', gate: dispatchGateCause, path: String(fileInfo.path).slice(0, 80), chars: fileContent.length }); } catch (_) {}

                const controller = renderToolCallCard(parent, fileContent, (content, ctrl) => {
                    executeFileWrite(fileInfo.path, content, ctrl);
                }, 'write_file', { path: fileInfo.path, content: fileContent });

                if (autoExecute && !isExecutingNow) {
                    executeFileWrite(fileInfo.path, fileContent, controller);
                    break;
                }
            } else {
                console.log("[Agent Bridge] Complete Tool Call Detected:\n", cleanCmd);

                const controller = renderToolCallCard(parent, cleanCmd, (cmd, ctrl) => {
                    executeCommand(cmd, ctrl, { async: isAsyncCall });
                }, 'cmd');

                if (autoExecute && !isExecutingNow) {
                    executeCommand(cleanCmd, controller, { async: isAsyncCall });
                    break;
                }
            }
        }

        // v4.3.1: scanScope 文本兜底（当渲染器不产 pre/code-block 节点，或处于未解析原始围栏时）
        if (!foundAny && scanScope && !processedBlocks.has(scanScope)) {
            // STRICTLY skip thinking/reasoning scratchpads
            try {
                if (scanScope.closest && scanScope.closest('.ds-think-content, [class*="think"], [class*="thought"], [data-testid*="think"]')) return;
                if (scanScope.className && /think|thought/i.test(String(scanScope.className))) return;
            } catch (_) {}

            let isOwn = false;
            try {
                isOwn = !!scanScope.querySelector('[id^="agent-"], [id^="tool-card-"], .agent-tool-card, .agent-collapsed-pill');
            } catch (_) {}
            if (isOwn) {
                processedBlocks.add(scanScope);
                return;
            }

            const scopeText = (scanScope.innerText || scanScope.textContent || '');
            // v4.3.18 P0: same narrowing as the block-scan guard -- a command
            // mentioning the marker must still reach the fallback. Only real
            // feedback bubbles (Exit signature + follow-up instruction) skip it.
            const scopeHasFeedback = scopeText.includes('[Tool Call Result (Exit:') && /若需继续执行|local_cmd\s*代码块/.test(scopeText);
            if (!scopeHasFeedback) {
                // v4.3.18 P1: body is GREEDY to the LAST closing fence so inner
                // fences (e.g. here-strings writing markdown) no longer truncate
                // the command. Fallback handles one streaming command per scope;
                // multi-block messages go through the DOM block path above.
                // v4.3.19 P2: 3+ backtick fences so ````local_cmd can wrap ```
                // content (CommonMark: outer run must exceed any inner run).
                const writeFenceRe = /(?:^|\n)\s*(?:-\s*)?`{3,}\s*(?:write_file|write-file):\s*([^\s\n\r]+)[^\n]*\r?\n([\s\S]*)\r?\n\s*`{3,}/i;
                const cmdFenceRe = /(?:^|\n)\s*(?:-\s*)?`{3,}\s*(local_cmd|bash|sh|powershell|pwsh)\b[^\n]*\r?\n([\s\S]*)\r?\n\s*`{3,}/i;

                const writeMatch = scopeText.match(writeFenceRe);
                const cmdMatch = !writeMatch ? scopeText.match(cmdFenceRe) : null;
                // v4.3.25: bare built-in lane for unfenced single-line
                // instruction messages (never competes with fenced matches).
                const bareBuiltIn = (!writeMatch && !cmdMatch) ? matchBareBuiltIn(scopeText) : null;
                // v4.3.7 async lane (P1-b): explicit fenced `local_cmd:async` infostring.
                const isAsyncCall = /`{3,}\s*local_cmd:async/i.test(scopeText);

                if (writeMatch) {
                    const rawPath = writeMatch[1];
                    const targetPath = cleanPathCandidate(rawPath);
                    const fileContent = stripDsmlPollution(writeMatch[2] || '');
                    if (targetPath && fileContent.trim()) {
                        const trackKey = targetPath + "::" + fileContent;
                        const sig = 'write:' + targetPath + ':' + fileContent.length;
                        if (processedSignatures.has(sig)) {
                            processedBlocks.add(scanScope);
                            return;
                        }
                        let tracker = blockWatchMap.get(scanScope);
                        if (!tracker) {
                            tracker = { text: trackKey, lastChange: now };
                            blockWatchMap.set(scanScope, tracker);
                        } else if (tracker.text !== trackKey) {
                            tracker.text = trackKey;
                            tracker.lastChange = now;
                        } else if (now - tracker.lastChange >= 1800) {
                            processedBlocks.add(scanScope);
                            addProcessedSig(sig);
                            blockWatchMap.delete(scanScope);
                            console.log(`[Agent Bridge] [Scope Fallback] Complete File Write Detected: ${targetPath} (${fileContent.length} chars)`);
                            try { diagAttach({ phase: 'dispatch-write', v: '4.3.5', gate: 'close-fence', path: String(targetPath).slice(0, 80), chars: fileContent.length }); } catch (_) {}
                            const controller = renderToolCallCard(scanScope, fileContent, (content, ctrl) => {
                                executeFileWrite(targetPath, content, ctrl);
                            }, 'write_file', { path: targetPath, content: fileContent });

                            if (autoExecute && !isExecutingNow) {
                                executeFileWrite(targetPath, fileContent, controller);
                            }
                        }
                    }
                } else if (cmdMatch || bareBuiltIn) {
                    const rawBody = cmdMatch ? (cmdMatch[2] || '') : (bareBuiltIn || '');
                    const cleanCmdRaw = rawBody.split(/\r?\n/).filter(line => {
                        const t = line.trim();
                        if (!t) return false;
                        if (/^(?:local_cmd|bash|sh|powershell|pwsh)\b/i.test(t)) return false;
                        if (/^\s*(-\s*)?```/.test(line)) return false;
                        return true;
                    }).join('\n').trim();
                    const cleanCmd = stripDsmlPollution(cleanCmdRaw);

                    if (cleanCmd && cleanCmd.length >= 2) {
                        const trackKey = cleanCmd;
                        const sig = 'cmd:' + cleanCmd.replace(/\s+/g, ' ').trim();
                        if (processedSignatures.has(sig)) {
                            processedBlocks.add(scanScope);
                            return;
                        }
                        let tracker = blockWatchMap.get(scanScope);
                        if (!tracker) {
                            tracker = { text: trackKey, lastChange: now };
                            blockWatchMap.set(scanScope, tracker);
                        } else if (tracker.text !== trackKey) {
                            tracker.text = trackKey;
                            tracker.lastChange = now;
                        } else if (now - tracker.lastChange >= 1800) {
                            if (isQuoteBalanced(cleanCmd) && isBracketBalanced(cleanCmd)) {
                                const isHtml = /<[a-zA-Z][^>]*>/.test(cleanCmd) && /<\/(div|span|style|html|body)>|vcp-root/i.test(cleanCmd);
                                if (!isHtml) {
                                    processedBlocks.add(scanScope);
                                    addProcessedSig(sig);
                                    blockWatchMap.delete(scanScope);
                                    console.log("[Agent Bridge] [Scope Fallback] Complete Tool Call Detected:\n", cleanCmd);
                                    const controller = renderToolCallCard(scanScope, cleanCmd, (cmd, ctrl) => {
                                        executeCommand(cmd, ctrl, { async: isAsyncCall });
                                    }, 'cmd');

                                    if (autoExecute && !isExecutingNow) {
                                        executeCommand(cleanCmd, controller, { async: isAsyncCall });
                                    }
                                }
                            } else {
                                console.log("[Agent Bridge] [Scope Fallback] Waiting for balanced quotes/brackets:\n", cleanCmd);
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Execute Command via Native Swift / Host
    function executeCommand(command, controller, opts) {
        if (isExecutingNow) return;

        // Dispatch dedup: streaming re-renders can surface the same block twice
        // (observed 62ms apart) — two feedback flows then stomp the composer and
        // the site fails the send. Merge identical commands within 5s.
        // Normalized: re-renders may differ in whitespace only.
        const nowMs = Date.now();
        const normCmd = String(command).replace(/\s+/g, ' ').trim();
        addProcessedSig('cmd:' + normCmd);
        try { diagAttach({ phase: 'dispatch', v: '4.3.26', cmd: normCmd.slice(0, 300) }); } catch (_) {}
        if (normCmd === lastDispatch.cmd && nowMs - lastDispatch.at < 5000) {
            controller.setStatus('重复调用已合并（5s内相同命令）', '#8b5cf6', false);
            controller.setOutput('与上一条完全相同的命令在短时间内重复下发，已自动合并，不再重复执行。');
            try { console.log('[Agent Bridge] Duplicate dispatch merged: ' + String(command).slice(0, 80)); } catch (_) {}
            return;
        }
        lastDispatch = { cmd: normCmd, at: nowMs };

        isExecutingNow = true;
        executingStartedAt = Date.now();
        controller.hidePacing();
        controller.setStatus("正在执行本地命令...", "#d97706", true);
        controller.setOutput("[本地终端进程已启动，正在执行指令...]");
        // Elapsed ticker so a long silent run doesn't look wedged.
        try {
            const t0 = Date.now();
            if (controller._tickIv) clearInterval(controller._tickIv);
            controller._tickIv = setInterval(() => {
                try { controller.setStatus(`正在执行本地命令…（已运行 ${Math.round((Date.now() - t0) / 1000)}s）`, "#d97706", true); } catch (_) {}
            }, 1000);
        } catch (_) {}
        updateHUD("正在执行本地指令...", "#f59e0b");

        console.log("[Agent Bridge] Dispatching command to native host:\n", command);
        noteAction('dispatch:' + String(command).slice(0, 60));

        // v4.3.4 dangerous wildcard refusal (P3.7) — must run before the gate is consumed.
        const rmRefusal = refuseDangerousWildcard(command);
        if (rmRefusal) {
            try { controller.setStatus('已拒绝：危险通配符', '#ef4444', false); } catch (_) {}
            try { controller.setOutput(rmRefusal, true); } catch (_) {}
            try { updateHUD('危险通配符已拦截', '#ef4444'); } catch (_) {}
            isExecutingNow = false;
            // v4.3.6 refusal-feedback fix (P6): a refusal with no result wedges the model
            // (it waits for a [Tool Call Result] that never comes). Route through the
            // normal result pipeline so the refusal REACHES the conversation.
            try { window.__agentBridge.onCommandResult({ id: controller.cardId, exitCode: 1, output: rmRefusal, __verified: true }); } catch (_) {}
            return;
        }
        try { pendingDispatch.set(controller.cardId, { sig: 'cmd:' + normCmd, at: Date.now() }); } catch (_) {}
        try { lastDispatchAt = Date.now(); } catch (_) {}

        // v4.3.8: Start-Job intercept REMOVED (P2-b now owned by host ThreadJob shim).
        // Keeping the refusal would block the very shim it was bridging to.
        const outMsg = {
            action: "execute",
            command: command,
            id: controller.cardId
        };
        // v4.3.7 async lane (P1-b): explicit detached execution, bypasses host serial queue.
        if (opts && opts.async) outMsg.async = true;
        sendToNative(outMsg);
    }

    // 4b. Direct File Write via Native Host
    function executeFileWrite(path, content, controller) {
        if (isExecutingNow) return;

        // v4.3.14 A' plan-mode mechanical enforcement: write_file fences refused even if
        // the model emits one under planning prompt. Delivered as a normal failed result
        // (v4.3.6 lesson: refusal without feedback wedges the loop).
        if (planMode) {
            const pmMsg = '[规划模式拦截] 当前为只读规划模式，write_file 已被机械层拒绝。如需写入请先切回标准/PTC 模式。';
            try { controller.setStatus('规划模式：已拒绝写入', '#ef4444', false); } catch (_) {}
            try { controller.setOutput(pmMsg, true); } catch (_) {}
            try { updateHUD('规划模式拒写', '#ef4444'); } catch (_) {}
            isExecutingNow = false;
            try { window.__agentBridge.onCommandResult({ id: controller.cardId, exitCode: 1, output: pmMsg, __verified: true }); } catch (_) {}
            return;
        }

        const nowMs = Date.now();
        const sig = 'write_file:' + String(path || '').trim();
        addProcessedSig('write:' + String(path || '').trim() + ':' + (content ? content.length : 0));
        if (sig === lastDispatch.cmd && nowMs - lastDispatch.at < 5000) {
            controller.setStatus('重复写入已合并（5s内相同目标）', '#8b5cf6', false);
            controller.setOutput('相同目标文件的写入在短时间内重复下发，已自动合并。');
            return;
        }
        lastDispatch = { cmd: sig, at: nowMs };

        isExecutingNow = true;
        executingStartedAt = Date.now();
        controller.hidePacing();
        controller.setStatus("正在写入本地文件...", "#0d9488", true);
        controller.setOutput(`[正在将文件落盘至本地系统...]\n目标路径: ${path}\n文件大小: ${content.length} 字符`);
        updateHUD("正在写入本地文件...", "#0d9488");

        console.log(`[Agent Bridge] Dispatching file write to native host (Path: ${path}, ${content.length} chars)`);
        noteAction('filewrite:' + String(path).slice(0, 60));

        // v4.3.4 write receipt correlation (P0.2/P1.3): expected bytes for read-back verify.
        try { pendingDispatch.set(controller.cardId, { sig: 'write:' + String(path || '').trim() + ':' + (content ? content.length : 0), at: Date.now(), expectBytes: utf8len(content), expectPath: String(path || '') }); } catch (_) {}
        try { lastDispatchAt = Date.now(); } catch (_) {}

        sendToNative({
            action: "write_file",
            path: path,
            content: content,
            id: controller.cardId
        });
    }

    // 5. Hide / Collapse Ugly User Feedback Messages into Sleek Compact Badges!
    // v4.3.21: trigger ONLY on full feedback signatures we emit. The old bare
    // "[Tool Call" prefix also matched assistant chatter quoting results.
    function isFeedbackTriggerText(v) {
        v = v || '';
        return v.startsWith('[Tool Call Result (Exit:') ||
            v.startsWith('[Tool Call 附件就绪]') ||
            v.startsWith('【本地工具执行结果');
    }

    // v4.3.21: fail-closed root decision for feedback folding. Collapse ONLY
    // roots that are positively user-side; assistant-side roots (or anything
    // ambiguous) are left alone -- folding is cosmetic, over-folding is not.
    // v4.3.24: d29f3d7d confirmed live on user roots 2026-09-16 (stable across
    // site deploys); true root is nearest ds-message (probe fold-dbg).
    function isCollapsibleFeedbackRoot(root) {
        try {
            let cn = '';
            try { cn = String(root.className || ''); } catch (_) {}
            // Assistant evidence on the root -> never collapse.
            if (/assistant|ai-message|\bbot\b|gpt|deepseek|ds-assistant/i.test(cn)) return false;
            try {
                if (root.querySelector && root.querySelector('.ds-assistant-message-main-content,[data-role="assistant"]')) return false;
            } catch (_) {}
            // Positive user evidence required (d29f3d7d = site user-bubble hash).
            if (cn.includes('d29f3d7d')) return true;
            if (/\buser\b|sender|human|mine|myself|\bright\b|usermessage|user-message/i.test(cn)) return true;
            return false;
        } catch (_) { return false; }
    }

    function collapseToolFeedbackBubbles() {
        // The MutationObserver now watches `document`, so this can fire before <body> exists
        // (WebView2 runs the script at document-creation). createTreeWalker requires a Node.
        if (!document.body) return;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        const textNodes = [];
        while (node = walker.nextNode()) {
            const v = (node.nodeValue || '').trim();
            if (isFeedbackTriggerText(v)) {
                textNodes.push(node);
            }
        }

        for (let tn of textNodes) {
            // v4.3.21: never touch our own UI cards/pills.
            try {
                if (tn.parentElement && tn.parentElement.closest &&
                    tn.parentElement.closest('[id^="agent-"], [id^="tool-card-"], .agent-tool-card, .agent-collapsed-pill')) continue;
            } catch (_) {}
            // Find the message ROOT first, then decide once -- fail CLOSED.
            // Old code collapsed the first mid-level wrapper whose class merely
            // contained "message", which also matches assistant-side wrappers
            // and folded DeepSeek's own messages quoting tool results.
            let container = tn.parentElement;
            while (container && container !== document.body) {
                let rcn = '';
                try { rcn = String(container.className || ''); } catch (_) {}
                let rrole = '';
                try { rrole = container.getAttribute ? (container.getAttribute('role') || '') : ''; } catch (_) {}
                let rmid = false;
                try { rmid = !!(container.hasAttribute && container.hasAttribute('data-message-id')); } catch (_) {}
                if (/\bchat-item\b|\bmessage-item\b|\bds-message\b/.test(rcn) || rrole === 'article' || rmid) break;
                container = container.parentElement;
            }
            if (!container || container === document.body) continue;
            if (collapsedBubblesSet.has(container)) continue;
            if (!isCollapsibleFeedbackRoot(container)) continue;

            {
                    collapsedBubblesSet.add(container);

                    // Create compact pill
                    const pill = document.createElement('div');
                    pill.className = 'agent-collapsed-pill';
                    pill.style.cssText = `
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        background: #f8fafc;
                        border: 1px solid #e2e8f0;
                        color: #64748b;
                        font-size: 11px;
                        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
                        padding: 3px 10px;
                        border-radius: 8px;
                        margin: 4px 0;
                        cursor: pointer;
                        user-select: none;
                        width: fit-content;
                        transition: background 0.15s;
                    `;
                    pill.innerHTML = `
                        <span>⚡️</span>
                        <span style="font-weight: 500; color: #475569;">Tool Call 结果已自动同步给 DeepSeek</span>
                        <span style="color: #94a3b8; font-size: 10px;">[点击展开]</span>
                    `;

                    // Move original content into a collapsible container (hidden by default)
                    const contentWrapper = document.createElement('div');
                    contentWrapper.style.display = 'none';
                    contentWrapper.style.marginTop = '6px';
                    contentWrapper.style.opacity = '0.85';
                    contentWrapper.style.fontSize = '12px';

                    while (container.firstChild) {
                        contentWrapper.appendChild(container.firstChild);
                    }

                    let expanded = false;
                    pill.addEventListener('click', (e) => {
                        e.stopPropagation();
                        expanded = !expanded;
                        contentWrapper.style.display = expanded ? 'block' : 'none';
                        pill.querySelector('span:last-child').textContent = expanded ? '[点击折叠]' : '[点击展开]';
                    });

                    container.appendChild(pill);
                    container.appendChild(contentWrapper);
                    try { window.__collapsedBubbles = (window.__collapsedBubbles || 0) + 1; hideGlobal('__collapsedBubbles'); } catch (_) {}
                }
        }
    }

    // Rapid re-scan burst right after we click send: catches the feedback bubble
    // the moment React renders it instead of waiting for the 600ms loop.
    function burstCollapse() {
        let n = 0;
        const iv = setInterval(() => {
            try { collapseToolFeedbackBubbles(); } catch (_) {}
            if (++n >= 12) { try { clearInterval(iv); } catch (_) {} }
        }, 250);
    }

    // Helper: Convert Base64 string to a synthetic File object
    function base64ToFile(b64Data, filename, mimeType) {
        const sliceSize = 1024;
        const byteCharacters = atob(b64Data);
        const byteArrays = [];
        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }
        const blob = new Blob(byteArrays, { type: mimeType });
        return new File([blob], filename, { type: mimeType });
    }

    // Helper: Inject synthetic File directly into DeepSeek React file input
    function injectFileToChat(file) {
        const input = document.querySelector('input[type="file"]');
        if (!input) {
            console.error("[Agent Bridge] No input[type=file] found!");
            return false;
        }
        const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps'));
        const fn = input[propsKey]?.onChange;
        if (!fn) {
            console.error("[Agent Bridge] React onChange not found on input!");
            return false;
        }
        try {
            fn({
                target: {
                    files: [file],
                    value: ''
                }
            });
            console.log(`[Agent Bridge] Attached file: ${file.name} (${Math.round(file.size / 1024)} KB, ${file.type})`);
            return true;
        } catch(e) {
            console.error("[Agent Bridge] Error triggering file upload:", e);
            return false;
        }
    }

    // Probe each readiness signal separately (also feeds attachdiag logging).
    function probeAttachmentState() {
        const ta = findInputTextarea();
        const root = (ta && ta.closest('form')) || document;
        const st = { scoped: !!ta, loading: 0, chip: false, btnFound: false, btnDisabled: true, chipDesc: '' };
        // Positive first: attachment chip actually present in composer?
        let chip = null;
        try {
            chip = root.querySelector(
                'img[src^="blob:"], [class*="preview"], [class*="Preview"], ' +
                '[class*="attach"], [class*="Attach"], [class*="thumb"], [class*="Thumb"]');
        } catch (_) {}
        if (chip) {
            st.chip = true;
            try {
                st.chipDesc = '<' + chip.tagName + ' class="' + String(chip.className).slice(0, 80) + '">';
                const cp = chip.parentElement;
                st.chipParent = cp ? ('<' + cp.tagName + ' class="' + String(cp.className).slice(0, 60) + '">') : '';
            } catch (_) {}
        }
        // Negative: still uploading? (visible loading/spinner that is NOT the chip's own stale wrapper)
        let loading = [];
        try {
            loading = root.querySelectorAll(
                '.ds-animated-size-item .ds-loading, .ds-animated-size-item [class*="loading"], ' +
                '[class*="Loading"], [class*="spin"], [class*="Spin"], ' +
                '[class*="uploading"], [class*="Uploading"]');
        } catch (_) {}
        for (const el of loading) {
            try {
                // (a) Ignore our own overlay UI (HUD / tool cards / collapsed pills)
                if (el.closest && el.closest('[id^="agent-"], [id^="tool-card-"], .agent-tool-card, .agent-collapsed-pill')) continue;
                // (b) Ignore hidden elements (rect alone doesn't reflect visibility)
                let cs = null;
                try { cs = getComputedStyle(el); } catch (_) {}
                if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) continue;
                // (c) Ignore a stale wrapper around the already-rendered chip:
                // the site leaves ds-loading on the thumbnail container after upload 200.
                if (chip && (el.contains(chip) || (chip.contains && chip.contains(el)))) continue;
                // (d) Ignore a stale spinner sitting in the SAME thumbnail box as the chip
                // (observed: div.ds-loading sibling of the IMG under the same hashed container,
                // still in DOM long after upload returned 200).
                try {
                    const chipBox = chip && chip.parentElement;
                    if (chipBox && (chipBox === el || chipBox.contains(el))) continue;
                } catch (_) {}
            } catch (_) {}
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                st.loading++;
                if (st.loading <= 2) {
                    try {
                        const p = el.parentElement;
                        st.loadingDesc = (st.loadingDesc || '') + '<' + el.tagName + ' class="' + String(el.className).slice(0, 60) +
                            '" parent=<' + (p ? p.tagName : '?') + ' class="' + (p ? String(p.className).slice(0, 60) : '') + '">;';
                    } catch (_) {}
                }
            }
        }
        // Send control must be enabled (guards React async state right after onChange)
        const btn = findSendButton();
        if (btn) {
            st.btnFound = true;
            st.btnDisabled = isControlDisabled(btn);
        }
        // Network-layer upload gate (from api_sniff flight counter): the DOM
        // ds-loading div proved to be a stale leftover, so it no longer gates.
        // Ready = chip rendered + send enabled + no upload in flight +
        // (upload observed since our inject, or 2s grace so an instant
        // send can't slip through before the upload request even starts).
        let upPending = 0, upLastReq = 0;
        try {
            if (window.__uploadState) {
                upPending = window.__uploadState.pending | 0;
                upLastReq = window.__uploadState.lastReqAt || 0;
            }
        } catch (_) {}
        st.pending = upPending;
        st.uploadSeen = upLastReq > __attachInjectedAt && __attachInjectedAt > 0;
        const settling = Date.now() - (__attachInjectedAt || Date.now());
        // NOTE: send-button state no longer gates here on purpose — the fill
        // happens AFTER the wait, so the box stays empty (invisible process)
        // until the last moment; enabled-poll runs right before the click.
        st.ready = (st.chip && st.pending === 0 &&
                    (st.uploadSeen || settling > 2000));
        return st;
    }

    function isAttachmentReady() {
        return probeAttachmentState().ready;
    }

    function diagAttach(labels) {
        try {
            const payload = Object.assign({ action: 'attachdiag', t: Date.now() }, labels);
            sendToNative(payload);
        } catch (_) {}
    }

    // Helper: Wait until DeepSeek web finishes uploading attachment to server (RFC-0005 Section 8.4).
    // 规范签名，接收元数据与回调，动态计算 3~10s 超时，参数对象化返回 { ok, timedOut, elapsed }
    function waitForAttachmentReady(metaOrCallback, maybeCallback) {
        const meta = (typeof metaOrCallback === 'function') ? {} : (metaOrCallback || {});
        const callback = (typeof metaOrCallback === 'function') ? metaOrCallback : maybeCallback;
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
                    if (typeof callback === 'function') {
                        callback({ ok: true, timedOut: false, elapsed: Math.round(now - startTime) });
                    }
                }
                return;
            }

            readySince = 0;
            if ((now - startTime) > maxWaitMs) {
                clearInterval(timer);
                diagAttach({ phase: 'timeout', elapsed: Math.round(now - startTime), name: meta.filename || '' });
                console.warn("[Agent Bridge] Attachment wait timed out, falling back to text prompt");
                if (typeof callback === 'function') {
                    callback({ ok: false, timedOut: true, elapsed: Math.round(now - startTime) });
                }
            }
        }, 150);
    }

    // 6. Handle Native Result + Polite Pacing
    window.__agentBridge = {
        // Diagnostics surface: lets the native side (or a CDP session) verify the DOM
        // wiring without actually sending a message into the conversation.
        _debug: {
            findInputTextarea: findInputTextarea,
            findSendButton: findSendButton,
            describeScan: function() {
                // Ground truth for "why isn't this block dispatching".
                try {
                    const blocks = Array.from(document.querySelectorAll('pre, [class*="code-block"], [class*="codeBlock"], .md-code-block'));
                    const containers = Array.from(document.querySelectorAll('[class*="chat-item"], [class*="message-item"], [class*="message"], [role="article"], [data-message-id], .ds-markdown'));
                    const { scope: scanScope, index: scopeIdx } = resolveScanScope();
                    const tail = blocks.slice(-4).map((el, k) => {
                        let parent = null;
                        try { parent = el.closest('.md-code-block, [class*="code-block"]:not([class*="banner"]):not([class*="header"]), [class*="codeBlock"]') || el; } catch (_) { parent = el; }
                        const ft = ((parent.innerText || parent.textContent) || '');
                        return {
                            n: blocks.length - 4 + k,
                            tag: el.tagName,
                            cls: String(el.className).slice(0, 60),
                            processed: processedBlocks.has(el),
                            parentProcessed: parent ? processedBlocks.has(parent) : null,
                            inScope: scopeIdx >= 0 ? containers[scopeIdx].contains(parent) : 'no-scope',
                            hasMarker: ft.includes('[Tool Call'),
                            hasLocalCmd: ft.includes('local_cmd'),
                            head: ft.slice(0, 60)
                        };
                    });
                    return {
                        blocks: blocks.length, containers: containers.length, scopeIdx: scopeIdx,
                        scopeCls: scopeIdx >= 0 ? String(containers[scopeIdx].className).slice(0, 80) : '',
                        execNow: isExecutingNow, autoExec: autoExecute, tail: tail
                    };
                } catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
            },
            describeSendButton: function() {
                const b = findSendButton();
                if (!b) return { found: false };
                const r = b.getBoundingClientRect();
                return {
                    found: true,
                    tag: b.tagName,
                    cls: String(b.className),
                    disabled: isControlDisabled(b),
                    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
                };
            }
        },
        DynamicThrottle: DynamicThrottle,
        onFileReadResult: function(data) {
            try {
                const reqId = data && data.reqId;
                if (!reqId) return;
                const subs = window.__dsxFileReadSubs || {};
                const cb = subs[reqId];
                if (typeof cb === "function") {
                    try { cb(data); } catch (e) { console.error("[agent_bridge] onFileReadResult cb error:", e); }
                    delete subs[reqId];
                }
            } catch (e) { console.error("[agent_bridge] onFileReadResult error:", e); }
        },
        requestFileRead: function(path, callback, timeoutMs) {
            try {
                if (typeof path !== "string" || !path) {
                    if (typeof callback === "function") callback({ ok: false, error: "path empty" });
                    return null;
                }
                const reqId = "read-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
                window.__dsxFileReadSubs = window.__dsxFileReadSubs || {};
                window.__dsxFileReadSubs[reqId] = callback;
                sendToNative({ action: "read_file", path: path, reqId: reqId });
                if (typeof timeoutMs === "number" && timeoutMs > 0) {
                    setTimeout(function() {
                        const s = window.__dsxFileReadSubs || {};
                        if (s[reqId]) {
                            delete s[reqId];
                            if (typeof callback === "function") callback({ ok: false, error: "timeout" });
                        }
                    }, timeoutMs);
                }
                return reqId;
            } catch (e) {
                if (typeof callback === "function") callback({ ok: false, error: String(e && e.message || e) });
                return null;
            }
        },
        insertText: function(text) {
            return insertTextAtCursor(text);
        },
        injectSystemPrompt: function() {
            injectPrompt(SYSTEM_PROMPT, true);
        },
        // v4.3.14 A': overlay 插件 thin API（机械层 + 单一源），UI 永不进核心。
        setPlanMode: function(on) {
            try {
                planMode = !!on;
                updateHUD(on ? '规划模式（只读）' : '标准执行模式', on ? '#f59e0b' : '#10b981');
                try { diagAttach({ phase: 'plan-mode', on: planMode }); } catch (_) {}
            } catch (_) {}
            return planMode;
        },
        getSystemPrompt: function() {
            try { return SYSTEM_PROMPT; } catch (_) { return ''; }
        },
        dumpConversation: function() {
            const out = [];
            document.querySelectorAll('.ds-markdown, [class*="message"]').forEach((m, idx) => {
                out.push(`=== MESSAGE ${idx} ===\n${m.innerText}\n`);
            });
            return out.join('\n');
        },
        onCommandStream: function(data) {
            // Live output chunk pushed by the native host during execution.
            try {
                const c = cardControllers[data && data.id];
                if (c && c.appendStream && typeof data.chunk === 'string') c.appendStream(data.chunk);
            } catch (_) {}
            // v4.3.4 stream accumulation (P1.3): if the final result arrives empty
            // but live chunks arrived, the receipt uses the accumulated stream text.
            try {
                if (data && data.id && typeof data.chunk === 'string') {
                    streamBuf[data.id] = String(streamBuf[data.id] || '') + data.chunk;
                    streamBufTime[data.id] = Date.now();
                    if (streamBuf[data.id].length > 200000) streamBuf[data.id] = streamBuf[data.id].slice(-200000);
                }
            } catch (_) {}
        },
        direct_send_ack: function(cardId) {
            try { DynamicThrottle.syncDirectSendSuccess(); } catch (_) {}
            if (typeof this.onDirectSendSuccess === 'function') {
                this.onDirectSendSuccess(cardId);
            }
        },
        onDirectSendSuccess: function(cardId) {
            isExecutingNow = false;
            isFeedbackPending = false;
            feedbackPendingStartedAt = 0;
            executingStartedAt = 0;
            try {
                DynamicThrottle.syncDirectSendSuccess();
            } catch (_) {}
            try {
                const c = cardControllers[cardId];
                if (c) {
                    if (c._tickIv) { clearInterval(c._tickIv); c._tickIv = null; }
                    c.setStatus('⚡ 结果已后台直达 DeepSeek 模型', '#10b981', false);
                }
                updateHUD('后台直达已完成', '#10b981');
            } catch (_) {}
            try { pumpVirtual(); } catch (_) {}
        },
        onDirectReply: function(data) {
            // Assistant reply arrived out-of-band: scan for fresh calls, loop on.
            try {
                const text = (data && data.text) || '';
                const sig = text.length + ':' + text.slice(0, 80);
                const nowMs = Date.now();
                if (sig === lastDirectReplySig && nowMs - lastDirectReplyAt < 60000) return;
                lastDirectReplySig = sig; lastDirectReplyAt = nowMs;
                if (!text.trim()) { updateHUD('直发回执为空', '#f59e0b'); return; }
                const calls = scanVirtualReply(text);
                if (!calls.length) { updateHUD('直发回执无新调用，环路结束', '#10b981'); return; }
                directDepth++;
                if (directDepth > 30) {
                    updateHUD('直发轮数超限，停止（请接管）', '#ef4444');
                    console.error('[Agent Bridge] direct loop depth exceeded, stopping');
                    return;
                }
                for (const c of calls) virtualQueue.push(c);
                updateHUD(`直发回执解析出 ${calls.length} 个调用（第 ${directDepth} 轮）`, '#2563eb');
                pumpVirtual();
            } catch (e) { console.error('[Agent Bridge] onDirectReply error:', e); }
        },
        onCommandResult: function(data) {
            // v4.3.13 entry marker: proves the result ENTERED the bridge (vs died in transit).
            try { diagAttach({ phase: 'result-received', id: String((data && data.id) || ''), exit: (data && data.exitCode), job: String((data && data.jobId) || '-') }); } catch (_) {}
            isExecutingNow = false;
            isFeedbackPending = true; // Protect pacing countdown window from duplicate scans
            feedbackPendingStartedAt = Date.now();
            executingStartedAt = 0;
            const cardId = data.id;
            const exitCode = data.exitCode;
            // v4.3.7 async lane (P1-b): poll heartbeats update the card only; the final
            // jobDone result flows through the normal pipeline (pending kept until then).
            // v4.3.13 poll recognition (P1-b final-loss root cause): host MUST flag polls,
            // but recognize defensively too (jobRunning && !jobDone). Unflagged polls used to
            // impersonate finals: consuming pend, queuing empty feedbacks, and getting the real
            // final stale-dropped. Never again.
            const isAsyncAck = !!data.asyncAck;
            const isJobPoll = !!data.jobPoll || (data.jobRunning === true && data.jobDone !== true);
            if (data.jobId && data.jobDone) { try { if (jobPollTimers[cardId]) clearInterval(jobPollTimers[cardId]); } catch (_) {} try { delete jobPollTimers[cardId]; } catch (_) {} }
            if (isJobPoll && !data.jobDone) {
                try { const cj = cardControllers[cardId]; if (cj) { cj.setStatus('后台运行中…', '#2563eb', true); cj.setOutput(String(data.output || ''), false); } } catch (_) {}
                isExecutingNow = false;
                isFeedbackPending = false;
                feedbackPendingStartedAt = 0;
                return;
            }
            if (isAsyncAck && data.jobId) { try { startJobPoll(cardId, data.jobId); } catch (_) {} }
            // v4.3.4 receipt integrity (P1.3): dispatch→result correlation + stream fallback.
            // Unknown ids = stale replays: drop WITHOUT feedback (kills 错位/回放进会话).
            const pend = pendingDispatch.get(cardId);
            // v4.3.7: asyncAck must NOT consume the pending entry — the final jobDone
            // result still needs it to pass the receipt-integrity gate.
            if (!isAsyncAck) { try { pendingDispatch.delete(cardId); } catch (_) {} }
            let streamedText = '';
            try { streamedText = String(streamBuf[cardId] || ''); delete streamBuf[cardId]; delete streamBufTime[cardId]; } catch (_) {}
            if (!String((data && data.output) || '').trim() && streamedText.trim()) {
                try { data.output = streamedText.trim(); } catch (_) {}
            }
            const ctrl0 = cardControllers[cardId];
            if (!pend && !data.__verified) {
                try { pumpVirtual(); } catch (_) {}
                if (!ctrl0) { try { console.log('[Agent Bridge] stale result dropped (no card, no dispatch)'); } catch (_) {} return; }
                try { ctrl0.setStatus('过期回执已丢弃（非本次分发）', '#f59e0b', false); } catch (_) {}
                try { updateHUD('过期回执已丢弃', '#f59e0b'); } catch (_) {}
                isFeedbackPending = false;
                feedbackPendingStartedAt = 0;
                return;
            }
            if (!data.__verified && ctrl0 && (ctrl0.isFile || ctrl0.type === 'write_file') && exitCode === 0 && pend && pend.expectPath) {
                // v4.3.4 write verify (P0.2): read back before claiming success (kills 静默截断).
                try { ctrl0.setStatus('已写入，回读校验中…', '#0d9488', true); } catch (_) {}
                const expBytes = pend.expectBytes || 0;
                const expPath = pend.expectPath;
                isFeedbackPending = false;
                feedbackPendingStartedAt = 0;
                try {
                    window.__agentBridge.requestFileRead(expPath, function(res) {
                        let gotBytes = -1, okMatch = false;
                        try { gotBytes = (res && typeof res.size === 'number') ? res.size : -1; okMatch = !!(res && res.ok) && gotBytes === expBytes; } catch (_) {}
                        if (okMatch) {
                            window.__agentBridge.onCommandResult({ id: cardId, exitCode: 0, output: data.output, __verified: true });
                        } else {
                            const msg = '[写校验失败] 落盘 ' + gotBytes + ' 字节 ≠ 发送 ' + expBytes + ' 字节（疑似截断），拒绝报成功，请检查后重发。';
                            try { diagAttach({ phase: 'write-verify-fail', path: String(expPath).slice(0, 80), got: gotBytes, exp: expBytes }); } catch (_) {}
                            window.__agentBridge.onCommandResult({ id: cardId, exitCode: 1, output: String(data.output || '') + '\n' + msg, __verified: true });
                        }
                    }, 12000);
                } catch (_) {
                    window.__agentBridge.onCommandResult({ id: cardId, exitCode: exitCode, output: data.output, __verified: true });
                }
                return;
            }
            try {
                const _c = cardControllers[cardId];
                if (_c && _c._tickIv) { clearInterval(_c._tickIv); _c._tickIv = null; }
            } catch (_) {}
            try { pumpVirtual(); } catch (_) {}
            const output = data.output || "(执行完毕，无输出)";
            const isAttachment = !!data.isAttachment;

            console.log(`[Agent Bridge] Command finished (Exit: ${exitCode}, isAttachment: ${isAttachment})`);

            let fileObj = null;
            if (isAttachment && data.base64Data) {
                try {
                    fileObj = base64ToFile(data.base64Data, data.filename || "attachment.txt", data.mimeType || "text/plain");
                    if (injectFileToChat(fileObj)) {
                        __attachInjectedAt = Date.now();
                    } else {
                        const failReason = 'DOM_REJECTED';
                        try {
                            sendToNative({
                                action: 'attach_failed',
                                id: cardId,
                                filename: data.filename || 'attachment.txt',
                                size: fileObj ? fileObj.size : 0,
                                reason: failReason
                            });
                        } catch (_) {}
                        try { diagAttach({ phase: 'inject-failed', name: data.filename || '', reason: failReason }); } catch (_) {}
                        const c = cardControllers[cardId];
                        if (c) {
                            try { c.setStatus('附件注入网页失败，已转文本通道', '#ef4444', false); } catch (_) {}
                        }
                        try { updateHUD('附件注入网页失败，已转文本通道', '#ef4444'); } catch (_) {}
                        fileObj = null;
                    }
                } catch(e) {
                    console.error("[Agent Bridge] Failed to process attachment:", e);
                    try {
                        sendToNative({
                            action: 'attach_failed',
                            id: cardId,
                            filename: data.filename || 'attachment.txt',
                            size: 0,
                            reason: 'EXCEPTION: ' + (e && e.message ? e.message : String(e))
                        });
                    } catch (_) {}
                    const c = cardControllers[cardId];
                    if (c) {
                        try { c.setStatus('附件处理异常，已转文本通道', '#ef4444', false); } catch (_) {}
                    }
                    try { updateHUD('附件处理异常，已转文本通道', '#ef4444'); } catch (_) {}
                    fileObj = null;
                }
            }

            // v4.3.13: everything below is result-critical — any throw used to kill the
            // result SILENTLY (no send, no verify, no log). Now it reports visibly.
            try {
            const controller = cardControllers[cardId];
            const isSuccess = (exitCode === 0);
            const isFile = controller && (controller.isFile || controller.type === 'write_file');

            if (controller) {
                if (isFile) {
                    controller.setStatus(isSuccess ? `✅ 写入成功` : `❌ 写入失败 (退出码: ${exitCode})`, isSuccess ? "#0d9488" : "#ef4444", false);
                    controller.setOutput(output, !isSuccess);
                } else if (isAttachment && fileObj) {
                    const isImg = (data.mimeType || "").startsWith("image/");
                    const title = isImg ? "📸 屏幕截图已挂载" : "📎 附件文件已挂载";
                    controller.setStatus(`${title}: ${data.filename}`, "#10b981", false);
                    controller.setOutput(`[${isImg ? "图片" : "文件"}已成功挂载至对话输入框]\n文件名: ${data.filename}\n大小: ${Math.round(fileObj.size / 1024)} KB\n类型: ${data.mimeType}\n\n正在通过安全节流通道自动同步给 DeepSeek...`);
                } else {
                    controller.setStatus(isSuccess ? `✅ 执行成功 (退出码: 0)` : `❌ 执行异常 (退出码: ${exitCode})`, isSuccess ? "#10b981" : "#ef4444", false);
                    controller.setOutput(output, !isSuccess);
                }
            }

            let feedback = "";
            if (isFile) {
                feedback = `[Tool Call: 本地文件直接写入结果 (Exit: ${exitCode})]:
${output}

请根据写入结果继续。若写完需运行测试，请输出 \`\`\`local_cmd 代码块；若还需写入其他文件请输出 \`\`\`write_file 代码块；若全部完成请给出最终解答。`;
            } else if (isAttachment && fileObj) {
                const isImg = (data.mimeType || "").startsWith("image/");
                const desc = data.prompt || (isImg ? "屏幕截图已捕获，请查看附件图片进行分析与判断。" : "相关数据已作为附件挂载至输入框。");
                feedback = `[Tool Call 附件就绪]: ${desc}
（附件: ${data.filename}，大小: ${Math.round(fileObj.size / 1024)} KB）

请阅读并分析上述附件内容，继续进行下一步判断或直接给出回答。`;
            } else {
                const notePreamble = data.prompt ? `${data.prompt}\n\n` : "";
                feedback = `${notePreamble}[Tool Call Result (Exit: ${exitCode})]:
\`\`\`
${output}
\`\`\`
请根据上述终端执行结果继续。若需继续执行命令请输出 \`\`\`local_cmd 代码块，若全部完成请给出最终解答。`;
                if (isAttachment && !fileObj) {
                    feedback += `\n(注：本轮附件未能挂载到输入框，已转纯文本反馈，不影响继续。)`;
                }
            }

            // Text-only fallback used when the attachment never materialized.
            const fallbackFeedback = () => `[Tool Call Result (Exit: ${exitCode})]:
\`\`\`
${output}
\`\`\`
(注：附件未能挂载显示，已转纯文本反馈，请继续。若需继续执行请输出 \`\`\`local_cmd 代码块，若完成请直接解答。)`;

            const context = {
                cardId: cardId,
                isAttachment: isAttachment,
                hostMs: data.hostMs || 0
            };

            queueFeedbackSlot(context, (release) => {
                isFeedbackPending = false;
                feedbackPendingStartedAt = 0;
                try { lastFeedbackForRetry = { text: feedback, at: Date.now() }; backoffRetried = false; } catch (_) {}
                noteAction('send-feedback');
                const hudMsg = isFile ? "同步写入结果给 DeepSeek..." : (isAttachment ? "等待附件就绪并发送..." : "同步执行结果给 DeepSeek...");
                updateHUD(hudMsg, "#2563eb");

                if (isAttachment && fileObj) {
                    const meta = { size: fileObj.size, filename: data.filename || "attachment.txt" };
                    waitForAttachmentReady(meta, (res) => {
                        if (res.timedOut || !res.ok) {
                            injectPrompt(fallbackFeedback(), true);
                            verifySentOrRetry((ok) => {
                                release(!!ok);
                                burstCollapse();
                                setTimeout(() => {
                                    updateHUD("Tool Call 引擎就绪", "#10b981");
                                    collapseToolFeedbackBubbles();
                                }, 1500);
                            });
                            return;
                        }
                        injectPrompt(feedback, false);
                        try {
                            const ta = findInputTextarea();
                            diagAttach({ phase: 'filled', taFound: !!ta, taLen: (ta && (ta.value || '').length) || 0 });
                        } catch (_) {}
                        let tries = 0;
                        const clickIv = setInterval(() => {
                            tries++;
                            let ok = false;
                            try {
                                const b = findSendButton();
                                if (b && !isControlDisabled(b)) ok = true;
                            } catch (_) {}
                            if (ok || tries >= 15) {
                                try { clearInterval(clickIv); } catch (_) {}
                                triggerSend();
                                verifySentOrRetry((ok2) => {
                                    release(!!ok2);
                                    burstCollapse();
                                    setTimeout(() => {
                                        updateHUD("Tool Call 引擎就绪", "#10b981");
                                        collapseToolFeedbackBubbles();
                                    }, 1500);
                                });
                            }
                        }, 100);
                    });
                } else {
                    injectPrompt(feedback, true);
                    burstCollapse();
                    setTimeout(() => {
                        verifySentOrRetry((ok) => {
                            if (ok) { release(true); return; }
                            try { injectPrompt(feedback, true); } catch (_) {}
                            setTimeout(() => {
                                verifySentOrRetry((ok2) => {
                                    release(!!ok2);
                                    if (!ok2 && controller) {
                                        try { controller.setStatus('回执发送失败（已重试），结果保留在卡片', '#ef4444', false); } catch (_) {}
                                        try { updateHUD('回执未送达，结果在卡片', '#ef4444'); } catch (_) {}
                                    }
                                }, true);
                            }, 700);
                        }, true);
                    }, 700);
                    setTimeout(() => {
                        updateHUD("Tool Call 引擎就绪", "#10b981");
                        collapseToolFeedbackBubbles();
                    }, 1500);
                }
            });

            try { diagAttach({ phase: 'result-queued', id: String(cardId) }); } catch (_) {}
            } catch (err) {
                try { diagAttach({ phase: 'result-crash', msg: String((err && err.message) || err).slice(0, 160) }); } catch (_) {}
                try { updateHUD('结果处理异常，已记录', '#ef4444'); } catch (_) {}
            }
        }
    };
    hideGlobal('__agentBridge');

    // ---- Direct-loop support: fixed activity panel + markdown virtual scan ----
    let agentPanelBodyEl = null;
    function ensureAgentPanel() {
        try {
            let panel = document.getElementById('agent-direct-panel');
            if (panel) { agentPanelBodyEl = document.getElementById('agent-direct-panel-body'); return panel; }
            if (!document.body) return null;
            panel = document.createElement('div');
            panel.id = 'agent-direct-panel';
            panel.style.cssText = 'position:fixed;right:14px;bottom:14px;width:360px;max-height:46vh;display:flex;flex-direction:column;background:#ffffff;border:1.5px solid #3b82f6;border-radius:12px;box-shadow:0 8px 30px rgba(37,99,235,.25);z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;overflow:hidden;';
            panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border-bottom:1px solid #bfdbfe;cursor:pointer;" id="agent-direct-panel-head"><span style="font-size:12px;font-weight:700;color:#1e40af;">Agent 直发面板 <span id="agent-direct-panel-count" style="color:#64748b;font-weight:500;"></span></span><span id="agent-direct-panel-toggle" style="font-size:11px;color:#64748b;">[收起]</span></div><div id="agent-direct-panel-body" style="overflow-y:auto;padding:8px 10px;"></div>';
            document.body.appendChild(panel);
            const head = document.getElementById('agent-direct-panel-head');
            if (head) head.addEventListener('click', () => {
                const b = document.getElementById('agent-direct-panel-body');
                const t = document.getElementById('agent-direct-panel-toggle');
                if (!b) return;
                const hidden = b.style.display === 'none';
                b.style.display = hidden ? '' : 'none';
                if (t) t.textContent = hidden ? '[收起]' : '[展开]';
            });
            agentPanelBodyEl = document.getElementById('agent-direct-panel-body');
            return panel;
        } catch (_) { return null; }
    }
    function bumpPanelCount() {
        try {
            const c = document.getElementById('agent-direct-panel-count');
            if (c) c.textContent = `(${document.querySelectorAll('#agent-direct-panel-body .agent-tool-card').length})`;
        } catch (_) {}
    }
    function stripVirtualDirective(body) {
        const lines = body.split(/\r?\n/);
        const idx = lines.findIndex(l => l.trim().length > 0);
        if (idx !== -1 && /^(?:write_file|write-file|file)\s*:|^(?:#|\/\/|\/\*|--|;|<!--)\s*(?:file|filepath|path):/i.test(lines[idx].trim())) {
            lines.splice(idx, 1);
        }
        return lines.join('\n');
    }
    // Scan assistant markdown (not rendered DOM) for fresh tool calls.
    // Stricter than the DOM scanner: exact fence tags only, deduped.
    function scanVirtualReply(text) {
        const out = [];
        const seen = new Set();
        const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g;
        let m;
        while ((m = fenceRe.exec(text))) {
            const info = (m[1] || '').trim();
            const body = (m[2] || '').replace(/\s+$/, '');
            if (!body) continue;
            const wInfo = info.match(/^(?:write_file|write-file):\s*(\S+)/i);
            if (wInfo && wInfo[1]) {
                const p = cleanPathCandidate(wInfo[1]);
                if (p) {
                    const key = 'w:' + p;
                    if (!seen.has(key)) { seen.add(key); out.push({ type: 'write_file', path: p, content: stripVirtualDirective(body) }); }
                }
                continue;
            }
            const infoCmd = /^(local_cmd|bash|sh)$/i.test(info);
            const bodyCmd = /agy-run|agy --model|opencode run/.test(body);
            if (infoCmd || bodyCmd) {
                const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => {
                    if (!l) return false;
                    if (l === 'Copy' || l === 'Download' || l === '复制' || l === '下载') return false;
                    if (l.includes('local_cmdCopyDownload')) return false;
                    if (l === 'local_cmd' || l === 'bash' || l === 'sh') return false;
                    return true;
                });
                const cmd = lines.join('\n').trim();
                if (cmd && cmd.length >= 2 && isQuoteBalanced(cmd)) {
                    const key = 'c:' + cmd;
                    if (!seen.has(key)) { seen.add(key); out.push({ type: 'cmd', command: cmd }); }
                }
                continue;
            }
            const fl = body.split(/\r?\n/).map(l => l.trim()).find(l => l);
            const cm = fl && fl.match(/^(?:#|\/\/|\/\*|--|;|<!--)\s*(?:file|filepath|path):\s*(\S+)/i);
            if (cm && cm[1]) {
                const p = cleanPathCandidate(cm[1]);
                if (p) {
                    const key = 'w:' + p;
                    if (!seen.has(key)) { seen.add(key); out.push({ type: 'write_file', path: p, content: stripVirtualDirective(body) }); }
                }
            }
        }
        return out;
    }
    function pumpVirtual() {
        try {
            if (isExecutingNow || !autoExecute) return;
            const job = virtualQueue.shift();
            if (!job) return;
            ensureAgentPanel();
            const body = agentPanelBodyEl;
            if (!body) { virtualQueue.unshift(job); return; }
            const anchor = document.createElement('div');
            anchor.style.display = 'none';
            body.appendChild(anchor);
            if (job.type === 'write_file') {
                const controller = renderToolCallCard(anchor, job.content, (content, ctrl) => {
                    executeFileWrite(job.path, content, ctrl);
                }, 'write_file', { path: job.path, content: job.content });
                bumpPanelCount();
                if (autoExecute && !isExecutingNow) executeFileWrite(job.path, job.content, controller);
            } else {
                const controller = renderToolCallCard(anchor, job.command, (cmd, ctrl) => {
                    executeCommand(cmd, ctrl);
                }, 'cmd');
                bumpPanelCount();
                if (autoExecute && !isExecutingNow) executeCommand(job.command, controller);
            }
        } catch (e) { console.error('[Agent Bridge] pumpVirtual error:', e); }
    }

    // 7. Textarea Injection & Send
    function findInputTextarea() {
        return document.querySelector('textarea#chat-input') || 
               document.querySelector('textarea') ||
               document.querySelector('[contenteditable="true"]');
    }

    function setNativeValue(el, val) {
        el.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) {
            nativeSetter.call(el, val);
        } else {
            el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        if (!el.value || el.value !== val) {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, val);
        }
    }

    // A <div role="button"> has no .disabled property -- DeepSeek expresses the disabled
    // state through the `ds-button--disabled` class, so BOTH must be checked.
    function isControlDisabled(el) {
        return !!el.disabled || el.classList.contains('ds-button--disabled');
    }

    function findSendButton() {
        const isVisible = el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
        const clickable = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);

        // 1. Explicit accessible name -- cheapest when the locale/version provides one.
        let btn = clickable.find(b => {
            const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
            return label.includes('send') || label.includes('发送');
        });
        if (btn) return btn;

        // 2. DeepSeek's own design-system modifier. The send control is the only
        //    primary+circle icon button in the composer. classList.contains() matches an
        //    EXACT token, so this does NOT collide with the neighbouring
        //    `ds-button--iconLabelPrimary` (a different token entirely).
        btn = clickable.find(b =>
            b.classList.contains('ds-button--primary') &&
            b.classList.contains('ds-button--circle') &&
            !isControlDisabled(b));
        if (btn) return btn;

        // 3. Geometric fallback: rightmost visible clickable element on the composer row.
        //    Survives class-name churn (their classes are hashed and change on deploy).
        const ta = findInputTextarea();
        if (ta) {
            const tr = ta.getBoundingClientRect();
            const row = clickable
                .map(b => ({ b, r: b.getBoundingClientRect() }))
                .filter(o => o.r.left > tr.left && o.r.top >= tr.top - 20 && o.r.bottom <= tr.bottom + 70)
                .sort((a, c) => c.r.left - a.r.left);
            if (row.length) return row[0].b;
        }
        return null;
    }

    function triggerSend() {
        try { lastAutoSendAt = Date.now(); } catch (_) {}
        const textarea = findInputTextarea();
        if (!textarea) return false;

        // NOTE (Windows port fix): the send control on chat.deepseek.com is a
        // <div role="button">, NOT a <button>. The original fallback queried
        // container.querySelectorAll('button') and could therefore never find it, so
        // injected prompts sat in the box unsent -- the exact "no effect" symptom.
        const sendBtn = findSendButton();
        if (sendBtn && !isControlDisabled(sendBtn)) {
            sendBtn.click();
            return true;
        }

        // Last resort: synthetic Enter on the composer.
        const enterEv = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        });
        textarea.dispatchEvent(enterEv);
        return true;
    }

    // Verify the click actually sent (a completion request left the page);
    // if our text is still sitting in the box, click again (max ~6s).
    // Without this, a swallowed click leaves text "stuck" with no retry.
    // v4.3.9 no-silent-loss: strict mode passes ONLY when a completion actually left
    // (the vacuous `!ours` pass could confirm a send that never filled the box).
    function verifySentOrRetry(done, strict) {
        // v4.3.12: baseline = inject-time ack, so our own send (stamped later) advances it.
        // (Sampling here would already include our send → strict could never pass.)
        let ack0 = 0;
        try { ack0 = (typeof lastInjectAckBase === 'number') ? lastInjectAckBase : (window.__lastCompletionAt || 0); } catch (_) {}
        const t0 = Date.now();
        let clicks = 0;
        let tick = 0;
        let noTa = 0;
        // v4.3.11: filled→emptied is the TRUE send signal. __lastCompletionAt is stamped
        // at REQUEST time (api_sniff hook), so our own send always predates ack0 sampling
        // and strict-ack can never pass — that caused 4 false red cards on 200-OK sends.
        let seenFilled = false;
        const iv = setInterval(() => {
            tick++;
            let cur = 0;
            try { cur = window.__lastCompletionAt || 0; } catch (_) {}
            let ours = false;
            let taMissing = false;
            try {
                const ta = findInputTextarea();
                if (!ta) { taMissing = true; }
                else {
                    let v = (ta.value !== undefined ? ta.value : ta.innerText) || '';
                    ours = !!(v && v.indexOf('[Tool Call') === 0);
                }
            } catch (_) {}
            if (ours) seenFilled = true;
            // v4.3.10 fail-fast: composer gone (crashed/navigating page) — don't hammer a corpse.
            if (taMissing) {
                noTa++;
                if (strict && noTa > 10) {
                    try { clearInterval(iv); } catch (_) {}
                    try { diagAttach({ phase: 'sent-giveup', reason: 'no-textarea', elapsed: Date.now() - t0, clicks: clicks }); } catch (_) {}
                    try { done(false); } catch (_) {}
                    return;
                }
            } else { noTa = 0; }
            if (cur > ack0 || (!ours && (!strict || seenFilled))) {
                try { clearInterval(iv); } catch (_) {}
                diagAttach({ phase: 'sent-ack', elapsed: Date.now() - t0, clicks: clicks });
                try { done(true); } catch (_) {}
                return;
            }
            if (Date.now() - t0 > 6000) {
                try { clearInterval(iv); } catch (_) {}
                diagAttach({ phase: 'sent-giveup', elapsed: Date.now() - t0, clicks: clicks });
                try { done(false); } catch (_) {}
                return;
            }
            if (tick % 4 === 0) {
                try { triggerSend(); clicks++; } catch (_) {}
            }
        }, 200);
    }

    function injectPrompt(text, autoSend = false) {
        try { lastInjectAckBase = window.__lastCompletionAt || 0; } catch (_) {}
        const textarea = findInputTextarea();
        if (!textarea) {
            console.error("[Agent Bridge] Textarea not found!");
            return;
        }

        // When auto-sending, visually mask the textarea during injection
        // so huge terminal feedback does not awkwardly sit in the user's view.
        const origOpacity = textarea.style.opacity;
        if (autoSend) {
            textarea.style.opacity = '0.01';
        }

        if (textarea.tagName === 'TEXTAREA') {
            setNativeValue(textarea, text);
        } else {
            textarea.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
        }

        if (autoSend) {
            // Rapid send: poll every 25ms up to 300ms for button readiness instead of 500ms delay
            let tries = 0;
            const clickIv = setInterval(() => {
                tries++;
                const btn = findSendButton();
                if ((btn && !isControlDisabled(btn)) || tries >= 12) {
                    clearInterval(clickIv);
                    triggerSend();
                    setTimeout(() => {
                        try { textarea.style.opacity = origOpacity || ''; } catch (_) {}
                    }, 80);
                    burstCollapse();
                    setTimeout(collapseToolFeedbackBubbles, 300);
                }
            }, 25);
        }
    }

    function insertTextAtCursor(text) {
        if (!text) return false;
        const el = findInputTextarea();
        if (!el) {
            console.error("[Agent Bridge] Textarea not found for insertText!");
            return false;
        }

        el.focus();
        let toInsert = text;

        if (el.tagName === 'TEXTAREA') {
            const start = (typeof el.selectionStart === 'number') ? el.selectionStart : el.value.length;
            const end = (typeof el.selectionEnd === 'number') ? el.selectionEnd : el.value.length;
            const val = el.value || '';

            // Add leading space if preceding character is not whitespace and toInsert does not start with whitespace
            if (start > 0 && !/\s/.test(val[start - 1]) && !/^\s/.test(toInsert)) {
                toInsert = ' ' + toInsert;
            }

            // Attempt 1: execCommand ('insertText') - updates React internal state & preserves undo stack
            let success = false;
            try {
                success = document.execCommand('insertText', false, toInsert);
            } catch (_) {}

            // Attempt 2: native setter fallback if execCommand was not effective
            if (!success || el.value === val) {
                const nextVal = val.slice(0, start) + toInsert + val.slice(end);
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                if (nativeSetter) {
                    nativeSetter.call(el, nextVal);
                } else {
                    el.value = nextVal;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                try {
                    const newPos = start + toInsert.length;
                    el.setSelectionRange(newPos, newPos);
                } catch (_) {}
            }
        } else {
            // ContentEditable
            let success = false;
            try {
                success = document.execCommand('insertText', false, toInsert);
            } catch (_) {}
            if (!success) {
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();
                    const textNode = document.createTextNode(toInsert);
                    range.insertNode(textNode);
                    range.setStartAfter(textNode);
                    range.setEndAfter(textNode);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    }

    // Terminal-style Drag & Drop file path support
    function setupDragAndDropPathHandler() {
        const hasFiles = (dt) => {
            if (!dt || !dt.types) return false;
            const types = Array.from(dt.types);
            return types.includes('Files') || types.includes('application/x-moz-file');
        };

        window.addEventListener('dragenter', (e) => {
            if (hasFiles(e.dataTransfer)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

        window.addEventListener('dragover', (e) => {
            if (hasFiles(e.dataTransfer)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'copy';
            }
        }, true);

        window.addEventListener('drop', async (e) => {
            if (!hasFiles(e.dataTransfer)) return;

            e.preventDefault();
            e.stopPropagation();

            const items = e.dataTransfer.items;
            const files = e.dataTransfer.files;

            let handles = [];
            if (items && items.length > 0) {
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.kind === 'file') {
                        if (typeof item.getAsFileSystemHandle === 'function') {
                            try {
                                const h = await item.getAsFileSystemHandle();
                                if (h) handles.push(h);
                            } catch (_) {}
                        }
                    }
                }
            }

            if (handles.length > 0 && window.chrome?.webview?.postMessageWithAdditionalObjects) {
                try {
                    window.chrome.webview.postMessageWithAdditionalObjects(
                        { action: "paths_dropped" },
                        handles
                    );
                    return;
                } catch (err) {
                    console.error("[Agent Bridge] postMessageWithAdditionalObjects (handles) error:", err);
                }
            }

            if (files && files.length > 0 && window.chrome?.webview?.postMessageWithAdditionalObjects) {
                try {
                    window.chrome.webview.postMessageWithAdditionalObjects(
                        { action: "paths_dropped" },
                        Array.from(files)
                    );
                    return;
                } catch (err) {
                    console.error("[Agent Bridge] postMessageWithAdditionalObjects (files) error:", err);
                }
            }
        }, true);
    }

    // 8. Loop (throttled: our own DOM writes must never re-trigger scans,
    // otherwise live streaming feeds a feedback storm that wedges the renderer)
    let scanScheduled = false;
    let lastScanAt = 0;
    function isOwnUi(node) {
        try {
            const el = (node && node.nodeType === 1) ? node : (node && node.parentElement);
            return !!(el && el.closest && el.closest('[id^="agent-"],[id^="tool-card-"],.agent-tool-card,.agent-collapsed-pill'));
        } catch (_) { return false; }
    }
    function scheduleScan() {
        if (scanScheduled) return;
        const wait = Math.max(0, 400 - (Date.now() - lastScanAt));
        scanScheduled = true;
        setTimeout(() => {
            scanScheduled = false;
            lastScanAt = Date.now();
            try { scanAndProcessToolCalls(); } catch (_) {}
            try { collapseToolFeedbackBubbles(); } catch (_) {}
        }, wait);
    }
    const observer = new MutationObserver((muts) => {
        try { createFloatingHUD(); } catch (_) {}
        try {
            for (const m of muts) {
                if (m.target && isOwnUi(m.target)) continue;
                let foreign = true;
                try {
                    for (const n of m.addedNodes) {
                        if (isOwnUi(n)) { foreign = false; break; }
                    }
                } catch (_) {}
                if (!foreign) continue;
                scheduleScan();
                break;
            }
        } catch (_) {}
    });

    // Observe `document` rather than document.documentElement: at document-creation time in
    // WebView2 documentElement is still null, so observing it would throw here -- after the
    // API export, which would silently disable tool-call scanning for the whole session.
    // NOTE: no characterData — text streaming is covered by the interval below.
    observer.observe(document, {
        childList: true,
        subtree: true
    });

    setInterval(() => {
        try {
            // Watchdog: clear wedged execution lock if native execution exceeded 190s (C# timeout is 180s)
            if (isExecutingNow && executingStartedAt > 0 && Date.now() - executingStartedAt > 190000) {
                console.warn('[Agent Bridge] isExecutingNow watchdog: cleared wedged execution lock (>190s)');
                isExecutingNow = false;
                executingStartedAt = 0;
            }
            // Watchdog: clear stuck feedback pending lock if countdown/send exceeded 35s
            if (isFeedbackPending && feedbackPendingStartedAt > 0 && Date.now() - feedbackPendingStartedAt > 35000) {
                console.warn('[Agent Bridge] isFeedbackPending watchdog: cleared stuck feedback lock (>35s)');
                isFeedbackPending = false;
                feedbackPendingStartedAt = 0;
            }
            createFloatingHUD();
            reconcileInjectFallback();
            scanAndProcessToolCalls();
            collapseToolFeedbackBubbles();
        } catch (_) {}
    }, 1500);

    // Crash-page forensics: when the site's tamper/crash whale appears, snapshot
    // our footprint so we stop guessing which modification trips it.
    let crashReported = false;
    let lastAgentAction = 'init';
    function noteAction(s) { try { lastAgentAction = (s || '').slice(0, 80); } catch (_) {} }
    setInterval(() => {
        try {
            if (!document.body) return;
            const t = document.body.innerText || '';
            if (t.length > 50 && /may have crashed due to modifications/i.test(t)) {
                if (crashReported) return;
                crashReported = true;
                let ours = {};
                try {
                    ours = {
                        hud: document.querySelectorAll('[id^="agent-"]').length,
                        cards: document.querySelectorAll('.agent-tool-card').length,
                        pills: document.querySelectorAll('.agent-collapsed-pill').length,
                        panel: document.querySelectorAll('#agent-direct-panel').length,
                        totalNodes: document.querySelectorAll('*').length
                    };
                } catch (_) {}
                sendToNative({
                    action: 'crashwatch',
                    url: location.href,
                    lastAction: lastAgentAction,
                    ours: JSON.stringify(ours)
                });
            } else if (crashReported && t.length > 50 && !/may have crashed due to modifications/i.test(t)) {
                crashReported = false; // recovered (reload), re-arm
            }
        } catch (_) {}
    }, 5000);

    // Rate-limit watcher: the site refuses burst sends ("Messages too frequent")
    // with HTTP 200 + an error bubble, so request-left checks can't see it.
    // On detect: pause auto-sends 90s, then retry the last feedback once.
    function findRateLimitError() {
        try {
            if (!document.body) return null;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            const re = /too frequent|try again later|rate[\s_-]*limit|too many requests|发送频繁|操作频繁|稍后(再试|重试)|频繁操作/i;
            while (node = walker.nextNode()) {
                const v = node.nodeValue || '';
                if (v.length > 200 || !re.test(v)) continue;
                let el = node.parentElement;
                if (!el) continue;
                try {
                    if (el.closest && el.closest('[id^="agent-"], [id^="tool-card-"], .agent-tool-card, .agent-collapsed-pill')) continue;
                } catch (_) {}
                const whole = ((el.innerText || el.textContent) || '');
                if (whole.includes('[Tool Call')) continue;
                return whole.slice(0, 120);
            }
        } catch (_) {}
        return null;
    }
    function enterBackoff(source, detail) {
        try {
            rateLimitBackoffUntil = Date.now() + BACKOFF_MS;
            backoffRetried = false;
            try { diagAttach({ phase: 'rate-limit', source: source, detail: (detail || '').slice(0, 120) }); } catch (_) {}
            updateHUD('发送过于频繁，冷却90秒后自动重试…', '#f59e0b');
            console.error('[Agent Bridge] rate limited (' + source + '), backing off 90s');
        } catch (_) {}
    }
    setInterval(() => {
        try {
            if (rateLimitBackoffUntil > 0) {
                if (Date.now() < rateLimitBackoffUntil) return; // still cooling
                // Expired: retry once, then clear and resume.
                rateLimitBackoffUntil = 0;
                // v4.3.4 staleness guard (P1.3): never re-inject feedback older than the
                // latest dispatch — a newer command means this retry is a stale replay.
                if (!backoffRetried && lastFeedbackForRetry.text &&
                    Date.now() - lastFeedbackForRetry.at < 10 * 60 * 1000 &&
                    lastFeedbackForRetry.at >= lastDispatchAt) {
                    backoffRetried = true;
                    updateHUD('冷却结束，重发上一条反馈…', '#2563eb');
                    try { diagAttach({ phase: 'rate-limit-retry' }); } catch (_) {}
                    injectPrompt(lastFeedbackForRetry.text, true);
                    burstCollapse();
                }
                return;
            }
            let hit = null;
            try {
                if ((window.__lastSendRejectedAt || 0) > lastRateLimitHandledAt) {
                    lastRateLimitHandledAt = window.__lastSendRejectedAt;
                    hit = 'stream-flag';
                }
            } catch (_) {}
            // DOM error text only counts shortly after one of OUR sends
            // (never trust stray discussion text).
            if (!hit && Date.now() - lastAutoSendAt < 25000) {
                const found = findRateLimitError();
                if (found) hit = 'dom:' + found;
            }
            if (hit) enterBackoff(hit, hit);
        } catch (_) {}
    }, 3000);

    setupDragAndDropPathHandler();
    setTimeout(createFloatingHUD, 800);
    console.log("[Agent Bridge] Tool Call Engine v4 Ready (with Terminal-style Drag&Drop & Paste).");

    } catch (e) {
        console.error("[Agent Bridge] FATAL init error: " + (e && e.stack ? e.stack : e));
    }

    try {
        if (typeof module !== 'undefined' && module.exports) {
            module.exports = { DynamicThrottle, queueFeedbackSlot, waitForAttachmentReady };
        }
    } catch (_) {}
})();
