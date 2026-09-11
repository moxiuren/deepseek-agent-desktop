(function() {
    if (window.__agentBridgeInstalled) return;
    window.__agentBridgeInstalled = true;

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

    // Forward console logs to native host
    const _origLog = console.log;
    const _origErr = console.error;
    console.log = function(...args) {
        _origLog.apply(console, args);
        sendToNative({
            action: "log",
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        });
    };
    console.error = function(...args) {
        _origErr.apply(console, args);
        sendToNative({
            action: "log",
            message: "[JS_ERROR] " + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
        });
    };

    console.log("[Agent Bridge] Initializing Tool Call Engine v4 (Cross-Platform Edition)...");

    // Dynamic OS detection for DeepSeek Planner instructions
    const isWindows = typeof navigator !== 'undefined' && (navigator.userAgent.includes("Windows") || (navigator.platform && navigator.platform.startsWith("Win")));
    const osPlatform = isWindows ? "Windows (PowerShell)" : "macOS (Zsh)";
    const cmdGuide = isWindows
        ? "- **系统命令负责文件与环境操作**：查看文件、检索目录、运行测试直接使用标准 PowerShell 命令（如 `dir` / `Get-ChildItem`、`cat` / `Get-Content`、`git`、`python`）。"
        : "- **系统命令负责文件与环境操作**：查看文件、检索目录、运行测试直接使用标准 bash/zsh（如 `cat`、`ls`、`git`、`python3`）。";
    const exampleCmd = isWindows
        ? "dir ~\ncat 文件路径\npython 脚本路径"
        : "ls -la ~/Documents/Projects\ncat 文件路径\npython3 脚本路径";

    const SYSTEM_PROMPT = `【系统协议：本地 ${osPlatform} Agent 闭环模式已激活】
你现在作为指挥大脑（Brain / Planner），拥有控制我本地电脑的执行权限。
本地已连接极速代码执行引擎：\`agy\`（模型：Gemini 3.8 Flash Low，无思考开销，极速纯执行）。

【分工原则】：
- **你（DeepSeek）负责全部大脑思考与设计**：由你负责逻辑推演、架构规划、分步决策，不要让执行者再次思考；
- **agy 负责极速生成代码 / 纯执行**：agy 不进行深度思考，你必须在指令中给它极其完整、无歧义的具体代码实现要求；
${cmdGuide}

【执行协议】：
当你需要让本地模型编写或修改代码时，请使用以下格式输出命令（agy-run 已默认配置为 3.8 Flash Low）：
\`\`\`local_cmd
agy-run "请根据以下完整要求生成代码：<你的详细完整指令>"
\`\`\`
（或完整参数：\`agy --model gemini-3.8-flash-low -p "指令"\`）

当你需要查看文件、探索目录或执行系统脚本时，直接输出命令：
\`\`\`local_cmd
${exampleCmd}
\`\`\`

【闭环规则】：
1. 每次只输出需要执行的命令代码块，不要自行编造虚假结果；
2. 本地系统会自动在终端执行该命令，并将真实的退出码和输出结果作为下一轮消息直接反馈给你；
3. 收到真实反馈后，你根据结果进行下一阶段思考与决策（继续输出 \`local_cmd\` 或回答用户）；
4. 所有任务最终完成时，无需输出 \`local_cmd\`，直接给出最终总结与解答。

【文件直接落盘写文件协议 (免除任何 Shell 转义与拼接)】：
当你需要创建、编写或修改一个文件时，无需使用 cat 或 echo 命令，直接输出带有目标路径的代码块：
\`\`\`write_file:相对或绝对文件路径
你的完整代码内容（原汁原味，零转义损坏）
\`\`\`
或者在代码块首行注明文件路径：
\`\`\`python
# file: 相对或绝对文件路径
你的完整代码内容
\`\`\`
本地系统会自动递归创建父目录并将代码原子落盘写入指定位置！若写完需运行测试，紧随其后输出 \`\`\`local_cmd 代码块即可。

【视觉感知与附件扩展能力】：
- **截取桌面屏幕视觉**：若需查看当前桌面、GUI 窗口布局、网页渲染或排版效果，直接输出：
\`\`\`local_cmd
agent-screenshot
\`\`\`
系统将自动抓取当前屏幕并作为图片附件挂载发送给你，下一轮你将直接获得完整视觉图像！
- **挂载任意大文件**：若需阅读大文件（支持最大 100MB），输出：
\`\`\`local_cmd
agent-attach 文件路径 "说明或提示"
\`\`\`
- **长输出防爆**：终端命令的超长输出（> 6KB）系统会自动为你打包为附件上传，不会撑爆输入框与上下文。
请确认收到，并等待用户指令。`;

    let autoExecute = true;
    let isExecutingNow = false;
    let cardControllers = {};
    let blockWatchMap = new Map();
    let pendingFeedbackTimer = null;

    function isQuoteBalanced(cmd) {
        let inDouble = false;
        let inSingle = false;
        let escaped = false;
        for (let i = 0; i < cmd.length; i++) {
            let ch = cmd[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"' && !inSingle) inDouble = !inDouble;
            else if (ch === "'" && !inDouble) inSingle = !inSingle;
        }
        return !inDouble && !inSingle;
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
    document.head.appendChild(style);

    // 1. Floating HUD
    function createFloatingHUD() {
        if (document.getElementById('deepseek-agent-hud')) return;

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
            <button id="agent-inject-btn" style="
                background: #2563eb;
                color: #ffffff;
                border: none;
                border-radius: 12px;
                padding: 4px 10px;
                font-size: 11px;
                font-weight: 500;
                cursor: pointer;
            ">⚡️ 注入协议 (⌘I)</button>
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

        document.getElementById('agent-inject-btn').addEventListener('click', () => {
            injectPrompt(SYSTEM_PROMPT, true);
        });

        const toggleBtn = document.getElementById('agent-toggle-btn');
        toggleBtn.addEventListener('click', () => {
            autoExecute = !autoExecute;
            toggleBtn.textContent = autoExecute ? "自动执行: 开" : "自动执行: 暂停";
            toggleBtn.style.color = autoExecute ? "#334155" : "#ef4444";
            updateHUD(autoExecute ? "Tool Call 引擎就绪" : "已暂停自动执行", autoExecute ? "#10b981" : "#f59e0b");
        });
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

    function extractPureCommand(blockNode) {
        let codeEl = blockNode.querySelector('.md-code-block-content code, pre code, code');
        let rawText = codeEl ? (codeEl.innerText || codeEl.textContent) : (blockNode.innerText || blockNode.textContent);

        const lines = (rawText || '').split(/\r?\n/).filter(line => {
            const t = line.trim();
            if (!t) return false;
            if (t === 'Copy' || t === 'Download' || t === '复制' || t === '下载') return false;
            if (t.includes('local_cmdCopyDownload')) return false;
            if (t === 'local_cmd' || t === 'bash' || t === 'sh') return false;
            return true;
        });

        return lines.join('\n').trim();
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
            filePath = m[1].trim().replace(/^["'`]|["'`]$/g, '');
            isExplicitWriteFile = true;
        }

        // 2. Explicit write_file: in code class (e.g. language-write_file:path)
        if (!filePath && codeClass) {
            m = codeClass.match(/language-(?:write_file|write-file):([^\s]+)/i);
            if (m && m[1]) {
                filePath = m[1].trim().replace(/^["'`]|["'`]$/g, '');
                isExplicitWriteFile = true;
            }
        }

        // 3. Explicit write_file: in fullText (first line or standalone token)
        if (!filePath) {
            m = fullText.match(/write_file:\s*([^\s\n\r]+)/i);
            if (m && m[1]) {
                filePath = m[1].trim().replace(/^["'`]|["'`]$/g, '');
                isExplicitWriteFile = true;
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
        // Clean single leading newline if created by splicing first line
        content = content.replace(/^\r?\n/, '');
        return content;
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
                <span id="${cardId}-pacing-text">⏱ 防频控保护：将在 3 秒后自动同步给 DeepSeek...</span>
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
                if (out) {
                    out.style.color = isError ? "#f87171" : "#34d399";
                    out.textContent = output;
                }
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

    // 3. Scanner with Debounce & Quote Verification
    function scanAndProcessToolCalls() {
        if (isExecutingNow) return;

        const blocks = document.querySelectorAll('pre, [class*="code-block"], [class*="codeBlock"], .md-code-block');
        const now = Date.now();

        for (let el of blocks) {
            if (el.dataset.agentProcessed) continue;

            const parent = el.closest('[class*="code-block"], [class*="codeBlock"]') || el;
            if (parent.dataset.agentProcessed) continue;

            const fileInfo = detectFileWriteBlock(parent);
            const isFileWrite = !!fileInfo;

            const fullText = (parent.innerText || parent.textContent || '').trim();
            const isLocalCmd = !isFileWrite && (
                               fullText.includes('local_cmd') ||
                               el.className.includes('local_cmd') ||
                               fullText.includes('agy-run') ||
                               fullText.includes('agy --model') ||
                               fullText.includes('opencode run'));

            if (!isLocalCmd && !isFileWrite) continue;

            let cleanCmd = "";
            let fileContent = "";
            let trackKey = "";

            if (isFileWrite) {
                fileContent = extractFileContent(parent, fileInfo);
                trackKey = fileInfo.path + "::" + fileContent;
            } else {
                cleanCmd = extractPureCommand(parent);
                if (!cleanCmd || cleanCmd.length < 2) continue;
                trackKey = cleanCmd;
            }

            // Debounce
            let tracker = blockWatchMap.get(parent);
            if (!tracker) {
                tracker = { text: trackKey, lastChange: now };
                blockWatchMap.set(parent, tracker);
                continue;
            }

            if (tracker.text !== trackKey) {
                tracker.text = trackKey;
                tracker.lastChange = now;
                continue;
            }

            if (now - tracker.lastChange < 1800) {
                continue;
            }

            if (!isFileWrite && !isQuoteBalanced(cleanCmd)) {
                console.log("[Agent Bridge] Waiting for closed quotes:\n", cleanCmd);
                continue;
            }

            el.dataset.agentProcessed = "true";
            parent.dataset.agentProcessed = "true";
            blockWatchMap.delete(parent);

            if (isFileWrite) {
                console.log(`[Agent Bridge] Complete File Write Detected. Target: ${fileInfo.path} (${fileContent.length} chars)`);

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
                    executeCommand(cmd, ctrl);
                }, 'cmd');

                if (autoExecute && !isExecutingNow) {
                    executeCommand(cleanCmd, controller);
                    break;
                }
            }
        }
    }

    // 4. Execute Command via Native Swift / Host
    function executeCommand(command, controller) {
        if (isExecutingNow) return;

        isExecutingNow = true;
        controller.hidePacing();
        controller.setStatus("正在执行本地命令...", "#d97706", true);
        controller.setOutput("[本地终端进程已启动，正在执行指令...]");
        updateHUD("正在执行本地指令...", "#f59e0b");

        console.log("[Agent Bridge] Dispatching command to native host:\n", command);

        sendToNative({
            action: "execute",
            command: command,
            id: controller.cardId
        });
    }

    // 4b. Direct File Write via Native Host
    function executeFileWrite(path, content, controller) {
        if (isExecutingNow) return;

        isExecutingNow = true;
        controller.hidePacing();
        controller.setStatus("正在写入本地文件...", "#0d9488", true);
        controller.setOutput(`[正在将文件落盘至本地系统...]\n目标路径: ${path}\n文件大小: ${content.length} 字符`);
        updateHUD("正在写入本地文件...", "#0d9488");

        console.log(`[Agent Bridge] Dispatching file write to native host (Path: ${path}, ${content.length} chars)`);

        sendToNative({
            action: "write_file",
            path: path,
            content: content,
            id: controller.cardId
        });
    }

    // 5. Hide / Collapse Ugly User Feedback Messages into Sleek Compact Badges!
    function collapseToolFeedbackBubbles() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        const textNodes = [];
        while (node = walker.nextNode()) {
            const v = node.nodeValue || '';
            if (v.includes('[Tool Call') || v.includes('【本地工具执行结果')) {
                textNodes.push(node);
            }
        }

        for (let tn of textNodes) {
            let container = tn.parentElement;
            // Climb up to the user message wrapper or bubble
            while (container && container !== document.body) {
                if (container.dataset.agentCollapsed) break;

                // Check if this container is a user message container
                const isMsg = container.classList && (
                    container.className.includes('chat-item') ||
                    container.className.includes('message') ||
                    container.className.includes('user') ||
                    container.getAttribute('role') === 'article' ||
                    (container.parentElement && container.parentElement.className.includes('chat-item'))
                );

                if (isMsg && !container.dataset.agentCollapsed) {
                    container.dataset.agentCollapsed = "true";

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
                    break;
                }
                container = container.parentElement;
            }
        }
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

    // Helper: Wait until DeepSeek web finishes uploading attachment to server
    function waitForAttachmentReady(callback, maxWaitMs = 12000) {
        const startTime = Date.now();
        const timer = setInterval(() => {
            const loadingEls = document.querySelectorAll('.ds-animated-size-item .ds-loading, .ds-animated-size-item [class*="loading"]');
            if (loadingEls.length === 0 || (Date.now() - startTime > maxWaitMs)) {
                clearInterval(timer);
                callback();
            }
        }, 300);
    }

    // 6. Handle Native Result + Polite Pacing
    window.__agentBridge = {
        injectSystemPrompt: function() {
            injectPrompt(SYSTEM_PROMPT, true);
        },
        dumpConversation: function() {
            const out = [];
            document.querySelectorAll('.ds-markdown, [class*="message"]').forEach((m, idx) => {
                out.push(`=== MESSAGE ${idx} ===\n${m.innerText}\n`);
            });
            return out.join('\n');
        },
        onCommandResult: function(data) {
            isExecutingNow = false;
            const cardId = data.id;
            const exitCode = data.exitCode;
            const output = data.output || "(执行完毕，无输出)";
            const isAttachment = !!data.isAttachment;

            console.log(`[Agent Bridge] Command finished (Exit: ${exitCode}, isAttachment: ${isAttachment})`);

            let fileObj = null;
            if (isAttachment && data.base64Data) {
                try {
                    fileObj = base64ToFile(data.base64Data, data.filename || "attachment.txt", data.mimeType || "text/plain");
                    injectFileToChat(fileObj);
                } catch(e) {
                    console.error("[Agent Bridge] Failed to process attachment:", e);
                }
            }

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
                    controller.setOutput(`[${isImg ? "图片" : "文件"}已成功挂载至对话输入框]\n文件名: ${data.filename}\n大小: ${Math.round(fileObj.size / 1024)} KB\n类型: ${data.mimeType}\n\n正在通过 3s 节流安全通道自动发送...`);
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
                feedback = `[Tool Call Result (Exit: ${exitCode})]:
\`\`\`
${output}
\`\`\`
请根据上述终端执行结果继续。若需继续执行命令请输出 \`\`\`local_cmd 代码块，若全部完成请给出最终解答。`;
            }

            let countdown = isAttachment ? 4 : 3;
            if (controller) {
                controller.showPacing(countdown, () => {
                    if (pendingFeedbackTimer) clearTimeout(pendingFeedbackTimer);
                    sendFeedbackNow();
                });
            }

            function sendFeedbackNow() {
                if (controller) controller.hidePacing();
                const hudMsg = isFile ? "同步写入结果给 DeepSeek..." : (isAttachment ? "等待附件就绪并发送..." : "同步执行结果给 DeepSeek...");
                updateHUD(hudMsg, "#2563eb");
                
                if (isAttachment) {
                    waitForAttachmentReady(() => {
                        injectPrompt(feedback, true);
                        setTimeout(() => {
                            updateHUD("Tool Call 引擎就绪", "#10b981");
                            collapseToolFeedbackBubbles();
                        }, 1500);
                    });
                } else {
                    injectPrompt(feedback, true);
                    setTimeout(() => {
                        updateHUD("Tool Call 引擎就绪", "#10b981");
                        collapseToolFeedbackBubbles();
                    }, 1500);
                }
            }

            pendingFeedbackTimer = setTimeout(sendFeedbackNow, (countdown * 1000));
        }
    };

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

    function triggerSend() {
        const textarea = findInputTextarea();
        if (!textarea) return false;

        const container = textarea.closest('div[class*="input"], form') || textarea.parentElement;
        const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));

        let sendBtn = allButtons.find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const title = (b.getAttribute('title') || '').toLowerCase();
            return (aria.includes('发送') || aria.includes('send') || title.includes('发送') || title.includes('send')) && !b.disabled;
        });

        if (!sendBtn && container) {
            sendBtn = Array.from(container.querySelectorAll('button')).find(b => b.querySelector('svg') && !b.disabled);
        }

        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
            return true;
        }

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

    function injectPrompt(text, autoSend = false) {
        const textarea = findInputTextarea();
        if (!textarea) {
            console.error("[Agent Bridge] Textarea not found!");
            return;
        }

        if (textarea.tagName === 'TEXTAREA') {
            setNativeValue(textarea, text);
        } else {
            textarea.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
        }

        if (autoSend) {
            setTimeout(() => {
                triggerSend();
                setTimeout(collapseToolFeedbackBubbles, 600);
            }, 500);
        }
    }

    // 8. Loop
    const observer = new MutationObserver(() => {
        createFloatingHUD();
        scanAndProcessToolCalls();
        collapseToolFeedbackBubbles();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });

    setInterval(() => {
        createFloatingHUD();
        scanAndProcessToolCalls();
        collapseToolFeedbackBubbles();
    }, 600);

    setTimeout(createFloatingHUD, 800);
    console.log("[Agent Bridge] Tool Call Engine v4 Ready.");
})();
