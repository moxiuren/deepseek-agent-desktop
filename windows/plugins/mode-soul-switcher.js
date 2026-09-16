/* DSX 插件: mode-soul-switcher v1.0.4
 * v1.0.4: 协议再修正——Store模块清单与7.4宿主版本不兼容（Core edition加载错），Start-Job由shim自带宿主DLL导入，裸Start-ThreadJob改导宿主Commands.*.dll（与bridge v4.3.32同口径）。
 * v1.0.2: 胶囊换 HUD 同款浅色玻璃挂件（与 bridge HUD 单视觉家族；bridge HUD 注入按钮退役，此胶囊为唯一协议入口）。
 * 职责:
 * 1. 提供 [标准模式] / [PTC批处理模式] / [规划模式] 三档切换胶囊;
 * 2. 提供 [Soul 灵魂] 查看与实时编辑悬浮弹窗;
 * 3. 动态组装 [底层通信与防御底座] + [模式策略] + [实时 Soul] 并一键注入网页端;
 * 4. 支持快捷键 Ctrl+M (或 Cmd+M) 极速注入当前模式协议;
 * 5. 零侵入主仓库代码，基于 DSX PluginHost 独立热重载运行。
 * v1.0.1 (review fixes): agent- 前缀自身 DOM 盾;Ctrl+M 输入框 guard;暂存诚实标签;
 *   base 改从 bridge 取（防 fork 漂移）;规划模式接 bridge 机械 enforcement。
 * 遵循规范: 无任何 Unicode Emoji 表情符号，纯文本标签风格。
 */
module.exports = {
  onLoad: function (ctx, meta) {
    ctx.log('mode-soul-switcher 加载中...');

    const isWindows = typeof navigator !== 'undefined' && 
      (navigator.userAgent.includes("Windows") || (navigator.platform && navigator.platform.startsWith("Win")));
    const osPlatform = isWindows ? "Windows (PowerShell)" : "macOS (Zsh)";
    // 可移植默认：家目录相对路径（bridge read_file 原生展开 ~/）。按需改成你的 Vault 绝对路径。
    const SOUL_FILE_PATH = '~/Documents/ObsidianVault/02-System-Rules/Agent-Soul.md';

    // 1. 底层通用通信与防御底座 (涵盖长文件生成器、防截断、宿主限制、搜索纪律)
    const BASE_PROTOCOL = `【系统协议：本地 ${osPlatform} Agent 闭环模式已激活】
你是 DeepSeek Agent，拥有控制本机的执行权限。

【你有的能力】（每轮只输出一个代码块，真实结果会自动回来）：
\`\`\`local_cmd
<PowerShell 命令> 或 agy -p "<完整无歧义指令>" --model gemini-3.8-flash-low --effort low --dangerously-skip-permissions
\`\`\`
\`\`\`write_file:目标路径
文件内容
\`\`\`
LONG FILES (>150 lines): do NOT paste via write_file (streaming truncates). Emit a local_cmd PowerShell generator instead (loops or Here-String) that creates the file, then verify with Get-Item .Length.
Start-Job FIXED (host shim auto-loads standard cmdlets inside jobs). Bare Start-ThreadJob: import HOST dlls first, never Store Modules (version-incompatible): $b=Split-Path ([Reflection.Assembly]::GetAssembly([System.Management.Automation.PowerShell]).Location) -Parent; 'Utility','Management'|%{Import-Module (Join-Path $b "Microsoft.PowerShell.Commands.$_.dll") -EA Stop}. Detached work: prefer local_cmd:async fence (host runspace, all cmdlets ok) or detached Start-Process logging to C:/Windows/TEMP/opencode/job-NAME.log with Get-Content -Tail polling.
（查文件跑脚本走 local_cmd，工作目录 ~/Documents/Projects；写文件走 write_file 自动建目录；agy 的 -p 与免确认必须带，跨目录加 \`--add-dir "目录"\`；截屏用 agent-screenshot，挂大文件用 agent-attach。）

【闭环规则】：每次只输出一个代码块等真实结果，不编造；收到结果再决策；做完直接总结。铁律四条：①write_file 内容没准备好就别发块，空块会被直接忽略（无回执）；②local_cmd 发前自查括号配对 ()[]{}，配不平桥接层不会执行；③连 9222/CDP 前先跑 Get-NetTCPConnection -LocalPort 9222，无监听直接报"端口已退役"，不硬连；④Exit:1 且报错含 not recognized / Unexpected token / Missing expression → 说明命令被提取错了，换写法重发，严禁原样重发。
【搜索纪律】：禁裸扫全盘——用户目录根/盘符根/注册表递归必须带 -Depth（≤3），先 Desktop/Documents/Projects，禁 AppData；护栏会直接打回无 -Depth 的裸扫；确需全量加注释 #scan-ok。`;

    // 2. 三大模式策略矩阵
    const MODES = {
      standard: {
        id: 'standard',
        name: '标准模式',
        tag: '[标准]',
        desc: '功能完整的编码 Agent，支持单步与多步自主闭环推进。',
        directive: `【当前行动策略：标准模式】
你处于全功能自主闭环模式。遵循每轮输出一个代码块原则，遇到多步任务稳扎稳打，依据每次执行的真实回执迭代推进。做完直接总结。`
      },
      ptc: {
        id: 'ptc',
        name: 'PTC 批处理模式',
        tag: '[PTC]',
        desc: '单回合多步合并，用脚本批量完成查找、读取与验证，减少网络往返并规避频控。',
        directive: `【当前行动策略：PTC 批处理模式 (Programmatic Tool Calling)】
【核心铁律】：严禁像普通单步 Agent 那样“调一次只查一个文件”！
在网页端环境下，多轮往返会引发严重的网络延迟并触发 90 秒消息频控。
遇到任何包含“搜索、多文件读取、状态比对、测试校验”的复合任务时，你必须编写一段包含循环、条件判断或函数调用的完整 PowerShell 脚本，在单次 local_cmd 代码块中一次性跑完所有搜集与验证步骤，并在脚本末尾统一输出整合摘要。
把原本需要 5 轮网络往返的操作压缩在单次回合内彻底搞定！`
      },
      plan: {
        id: 'plan',
        name: '规划模式',
        tag: '[规划]',
        desc: '只读分析与架构规划，严禁修改文件，只给出具体方案。',
        directive: `【当前行动策略：规划模式 (Plan Mode)】
【安全铁律】：当前阶段为纯需求分析与方案规划，严禁擅自修改！
1. 你只能使用只读命令（如 Get-ChildItem 探测结构、Select-String 搜索关键词、Get-Content 读取核心代码段落）。
2. 严禁输出任何 write_file 代码块！
3. 严禁在 local_cmd 中执行任何新增、覆盖、删除文件或安装环境的操作！
4. 在完成本地代码取证后，直接输出详细的分析报告、技术选型与分步实施计划，等待用户评审确认。`
      }
    };

    // 默认回退 Soul (从磁盘异步加载前使用)
    const DEFAULT_SOUL = `# Agent Soul — DeepSeek Agent（桌面端独立灵魂）
- 你是 DeepSeek Agent，跑在用户本机 Windows 桌面客户端里，直连官网、无 API Key。
- 长效记忆契约：Vault 根 ~/Documents/ObsidianVault。开工读 00-Dashboard/Project-Index.md 与 00-Dashboard/Task-State.md；改完代码追加项目卡片与 Changelog-Stream.md。
- 风格：高效干练、极客范；不说客套话，先穷尽本地手段查代码，带着方案汇报。
- 红线：严禁 Emoji（统一中英文标签 [通过] / [警告] / [错误]）；严禁硬删文件（一律移入 .vault-trash）；严禁泄露 Token / 密码。`;

    // 状态管理
    let currentMode = ctx.store.get('selected_mode', 'standard');
    if (!MODES[currentMode]) currentMode = 'standard';
    let cachedSoul = ctx.store.get('cached_soul', DEFAULT_SOUL);
    let isSoulLoadedFromFile = false;

    // 尝试通过 Bridge 原生通道读取本地真实的 Agent-Soul.md
    function loadSoulFromFile(callback) {
      if (window.__agentBridge && typeof window.__agentBridge.requestFileRead === 'function') {
        window.__agentBridge.requestFileRead(SOUL_FILE_PATH, function (res) {
          if (res && res.ok && typeof res.content === 'string' && res.content.trim()) {
            cachedSoul = res.content.trim();
            isSoulLoadedFromFile = true;
            ctx.store.set('cached_soul', cachedSoul);
            ctx.log('已从本地 Vault 加载真实 Soul 文件');
            if (callback) callback(true, cachedSoul);
          } else {
            if (callback) callback(false, cachedSoul);
          }
        }, 4000);
      } else {
        if (callback) callback(false, cachedSoul);
      }
    }

    // 初次加载时拉取一次真实 Soul，并同步当前模式到 bridge 机械层
    loadSoulFromFile();
    applyModeToBridge();

    // 组装最终完整的 Prompt
    // v1.0.1: base 取自 bridge 单一源（防 fork 漂移），bridge 缺席时回退内嵌快照。
    function getBaseProtocol() {
      try {
        if (window.__agentBridge && typeof window.__agentBridge.getSystemPrompt === 'function') {
          const s = window.__agentBridge.getSystemPrompt();
          if (s && s.length > 200) return s;
        }
      } catch (_) {}
      return BASE_PROTOCOL;
    }
    function buildComposedPrompt(modeKey, soulText) {
      const mode = MODES[modeKey] || MODES.standard;
      const soul = (soulText || cachedSoul).trim();
      return `${getBaseProtocol()}

${mode.directive}

【你的独立灵魂与工作契约 (Soul)】
${soul}

请简要确认收到当前模式（${mode.name}）与协议，并等待用户指令。`;
    }

    // 查找并注入输入框
    function injectToDeepSeek(text, autoSend) {
      const textarea = document.querySelector('textarea') ||
                       document.querySelector('#chat-input') ||
                       document.querySelector('.ds-input__textarea') ||
                       document.querySelector('[contenteditable="true"]');
      if (!textarea) {
        alert('[错误] 未找到 DeepSeek 输入框！');
        return false;
      }

      if (textarea.tagName === 'TEXTAREA') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(textarea, text);
        } else {
          textarea.value = text;
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        textarea.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      }

      if (autoSend) {
        setTimeout(function () {
          const isVisible = el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
          const clickable = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
          
          let sendBtn = clickable.find(b => {
            const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
            return label.includes('send') || label.includes('发送');
          });

          if (!sendBtn) {
            sendBtn = clickable.find(b =>
              b.classList.contains('ds-button--primary') &&
              b.classList.contains('ds-button--circle') &&
              !b.classList.contains('ds-button--disabled') &&
              !b.disabled
            );
          }

          if (sendBtn) {
            sendBtn.click();
          } else {
            const enterEv = new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
            });
            textarea.dispatchEvent(enterEv);
          }
        }, 180);
      }
      return true;
    }

    /* ---------- DOM 构造: 悬浮模式胶囊（v1.0.2：与 bridge HUD 同款浅色玻璃挂件，单视觉家族） ---------- */
    const capsule = ctx.el('div', `
      position: fixed;
      top: 50px;
      right: 20px;
      z-index: 2147483640;
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(59, 130, 246, 0.35);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
      border-radius: 20px;
      padding: 5px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      color: #1e293b;
      user-select: none;
      white-space: nowrap;
    `, '');
    capsule.id = 'agent-mode-capsule';

    const modeTag = ctx.el('span', `
      color: #2563eb;
      font-weight: 700;
      letter-spacing: 0.5px;
    `, '模式:');

    // 模式选择下拉框
    const modeSelect = ctx.el('select', `
      background: #f1f5f9;
      color: #1e293b;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 3px 6px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      outline: none;
    `, '');

    Object.keys(MODES).forEach(key => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = MODES[key].name;
      if (key === currentMode) opt.selected = true;
      modeSelect.appendChild(opt);
    });

    // v1.0.1: 规划模式机械 enforcement（bridge setPlanMode），提示词喊话之外再加一道真门。
    // local_cmd 文件意图不可解析，shell 侧仍靠提示词纪律；write_file 由机械层硬拒。
    function applyModeToBridge() {
      try {
        if (window.__agentBridge && typeof window.__agentBridge.setPlanMode === 'function') {
          window.__agentBridge.setPlanMode(currentMode === 'plan');
        }
      } catch (_) {}
    }
    modeSelect.addEventListener('change', function () {
      currentMode = modeSelect.value;
      ctx.store.set('selected_mode', currentMode);
      applyModeToBridge();
      ctx.log('切换模式为: ' + MODES[currentMode].name);
      flashBadge(MODES[currentMode].tag);
    });

    // 编辑 Soul 按钮
    const soulBtn = ctx.el('button', `
      background: rgba(0,0,0,0.05);
      color: #334155;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    `, 'Soul 灵魂');
    soulBtn.onmouseover = () => soulBtn.style.background = 'rgba(0,0,0,0.1)';
    soulBtn.onmouseout = () => soulBtn.style.background = 'rgba(0,0,0,0.05)';

    // 一键注入当前模式按钮
    const injectBtn = ctx.el('button', `
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 12px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      box-shadow: 0 2px 8px rgba(37, 99, 235, 0.35);
      transition: all 0.15s;
    `, '注入协议 (Ctrl+M)');
    injectBtn.onmouseover = () => injectBtn.style.background = '#1d4ed8';
    injectBtn.onmouseout = () => injectBtn.style.background = '#2563eb';

    injectBtn.addEventListener('click', function () {
      applyModeToBridge();
      const fullPrompt = buildComposedPrompt(currentMode, cachedSoul);
      injectToDeepSeek(fullPrompt, true);
      flashBadge('[已注入]');
    });

    function flashBadge(text) {
      const old = injectBtn.textContent;
      injectBtn.textContent = text;
      setTimeout(() => { injectBtn.textContent = old; }, 1200);
    }

    capsule.appendChild(modeTag);
    capsule.appendChild(modeSelect);
    capsule.appendChild(soulBtn);
    capsule.appendChild(injectBtn);
    document.body.appendChild(capsule);

    /* ---------- DOM 构造: Soul 编辑磨砂弹窗 ---------- */
    const modalMask = ctx.el('div', `
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      z-index: 2147483647;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    `, '');
    // v1.0.1: agent- 前缀自身 DOM 盾——bridge 扫描器无条件跳过本插件全部节点
    // （否则 Soul 预览 <pre> 里的围栏原文在空会话可被误执行）。
    modalMask.id = 'agent-soul-modal';

    const modalBox = ctx.el('div', `
      background: #111827;
      border: 1px solid #374151;
      border-radius: 16px;
      width: 760px;
      max-width: 92vw;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.6);
      color: #f3f4f6;
      overflow: hidden;
    `, '');

    // Header
    const modalHeader = ctx.el('div', `
      padding: 14px 18px;
      border-bottom: 1px solid #1f2937;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `, '');
    const modalTitle = ctx.el('div', 'font-size: 14px; font-weight: 700; color: #60a5fa;', 'DSX 模式策略与 Soul 灵魂配置');
    const closeBtn = ctx.el('button', `
      background: transparent;
      color: #9ca3af;
      border: none;
      font-size: 14px;
      cursor: pointer;
      padding: 2px 6px;
    `, '关闭 [Esc]');
    closeBtn.onclick = () => { modalMask.style.display = 'none'; };
    modalHeader.appendChild(modalTitle);
    modalHeader.appendChild(closeBtn);

    // Body
    const modalBody = ctx.el('div', 'padding: 16px 18px; overflow-y: auto; flex: 1;', '');

    // 模式描述卡片
    const modeDescBox = ctx.el('div', `
      background: #1e293b;
      border-left: 3px solid #3b82f6;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      color: #cbd5e1;
      margin-bottom: 14px;
      line-height: 1.5;
    `, '');

    function refreshModeDesc() {
      const m = MODES[currentMode] || MODES.standard;
      modeDescBox.innerHTML = `<strong>【当前选定模式：${m.name}】</strong><br>${m.desc}`;
    }
    refreshModeDesc();

    // Soul 标签与状态
    const soulLabelRow = ctx.el('div', 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;', '');
    const soulLabel = ctx.el('span', 'font-size: 12px; font-weight: 600; color: #9ca3af;', 'Agent 灵魂契约 (Agent-Soul.md，直接注入模型上下文)：');
    const soulSourceTag = ctx.el('span', 'font-size: 10px; color: #6b7280;', isSoulLoadedFromFile ? '[已从本地文件加载]' : '[使用缓存配置]');
    soulLabelRow.appendChild(soulLabel);
    soulLabelRow.appendChild(soulSourceTag);

    // Soul 编辑区
    const soulEditor = ctx.el('textarea', `
      width: 100%;
      height: 220px;
      background: #030712;
      color: #e5e7eb;
      border: 1px solid #374151;
      border-radius: 8px;
      padding: 10px 12px;
      font-family: Consolas, monospace;
      font-size: 11.5px;
      line-height: 1.55;
      resize: vertical;
      box-sizing: border-box;
      outline: none;
    `, cachedSoul);

    // 完整注入文本预览 (折叠)
    const previewToggle = ctx.el('div', 'margin-top: 12px; font-size: 11px; color: #93c5fd; cursor: pointer; user-select: none;', '>> 点击展开查看【最终组装注入 Prompt 预览】');
    const previewBox = ctx.el('pre', `
      display: none;
      margin-top: 8px;
      max-height: 140px;
      overflow-y: auto;
      background: #0a0f1d;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 8px 10px;
      font-family: Consolas, monospace;
      font-size: 10.5px;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-all;
    `, '');

    previewToggle.onclick = () => {
      const isHidden = previewBox.style.display === 'none';
      previewBox.style.display = isHidden ? 'block' : 'none';
      previewToggle.textContent = isHidden ? '>> 收起【最终组装注入 Prompt 预览】' : '>> 点击展开查看【最终组装注入 Prompt 预览】';
      if (isHidden) {
        previewBox.textContent = buildComposedPrompt(currentMode, soulEditor.value);
      }
    };

    modalBody.appendChild(modeDescBox);
    modalBody.appendChild(soulLabelRow);
    modalBody.appendChild(soulEditor);
    modalBody.appendChild(previewToggle);
    modalBody.appendChild(previewBox);

    // Footer
    const modalFooter = ctx.el('div', `
      padding: 12px 18px;
      border-top: 1px solid #1f2937;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0d131f;
    `, '');

    const leftBtns = ctx.el('div', 'display: flex; gap: 8px;', '');
    const reloadFileBtn = ctx.el('button', `
      background: transparent;
      color: #9ca3af;
      border: 1px solid #374151;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 11px;
      cursor: pointer;
    `, '从文件重载');

    reloadFileBtn.onclick = () => {
      reloadFileBtn.textContent = '读取中...';
      loadSoulFromFile((ok, content) => {
        reloadFileBtn.textContent = ok ? '重载成功' : '文件读取失败';
        if (ok) {
          soulEditor.value = content;
          soulSourceTag.textContent = '[已从本地文件重新加载]';
        }
        setTimeout(() => { reloadFileBtn.textContent = '从文件重载'; }, 1500);
      });
    };
    leftBtns.appendChild(reloadFileBtn);

    const rightBtns = ctx.el('div', 'display: flex; gap: 8px;', '');
    const saveOnlyBtn = ctx.el('button', `
      background: #374151;
      color: #f3f4f6;
      border: none;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
    `, '暂存到会话');

    saveOnlyBtn.onclick = () => {
      cachedSoul = soulEditor.value;
      ctx.store.set('cached_soul', cachedSoul);
      modalMask.style.display = 'none';
      flashBadge('[Soul已保存]');
    };

    const saveAndInjectBtn = ctx.el('button', `
      background: #2563eb;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 10px rgba(37, 99, 235, 0.4);
    `, '暂存并立即注入');

    saveAndInjectBtn.onclick = () => {
      cachedSoul = soulEditor.value;
      ctx.store.set('cached_soul', cachedSoul);
      applyModeToBridge();
      modalMask.style.display = 'none';
      const fullPrompt = buildComposedPrompt(currentMode, cachedSoul);
      injectToDeepSeek(fullPrompt, true);
      flashBadge('[已注入]');
    };

    rightBtns.appendChild(saveOnlyBtn);
    rightBtns.appendChild(saveAndInjectBtn);

    modalFooter.appendChild(leftBtns);
    modalFooter.appendChild(rightBtns);

    modalBox.appendChild(modalHeader);
    modalBox.appendChild(modalBody);
    modalBox.appendChild(modalFooter);
    modalMask.appendChild(modalBox);
    document.body.appendChild(modalMask);

    // 打开弹窗事件
    soulBtn.onclick = () => {
      refreshModeDesc();
      soulEditor.value = cachedSoul;
      modalMask.style.display = 'flex';
    };

    // 全局快捷键监听: Ctrl+M / Cmd+M 快速注入当前模式
    const offKey = ctx.on(window, 'keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
        // v1.0.1: 输入框有草稿（含自家 Soul 编辑框）时绝不覆盖——先发后注。
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { flashBadge('[输入框忙]'); return; }
        e.preventDefault();
        e.stopPropagation();
        applyModeToBridge();
        const fullPrompt = buildComposedPrompt(currentMode, cachedSoul);
        injectToDeepSeek(fullPrompt, true);
        flashBadge('[已注入]');
      }
      if (e.key === 'Escape' && modalMask.style.display !== 'none') {
        modalMask.style.display = 'none';
      }
    });

    ctx.log('mode-soul-switcher 已就绪，快捷键 Ctrl+M (或 Cmd+M)');

    // 卸载清理
    this._cleanup = function () {
      offKey();
      if (capsule.parentNode) capsule.parentNode.removeChild(capsule);
      if (modalMask.parentNode) modalMask.parentNode.removeChild(modalMask);
      ctx.log('mode-soul-switcher 已干净卸载');
    };
  },

  onUnload: function () {
    if (typeof this._cleanup === 'function') this._cleanup();
  }
};
