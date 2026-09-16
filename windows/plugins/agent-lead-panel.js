/* DSX 插件: agent-lead-panel v1.0.0 — Team-Lead 战情看板
 * 读 agent-lead-spool/index.json + 各任务 .progress.md，用原生 read_file 通道，
 * 页内渲染各 agent 任务卡（状态/进度尾/一键汇报）。只读 spool，不写任何东西。
 * 依赖: window.__agentBridge.requestFileRead (C# read_file action)
 * 挂载: document.body（避开 React #root，见 task-state-panel 教训）+ MutationObserver 保活
 * 无 Emoji; 无外部资源; onUnload 完整清理. ES5 写法（与宿主 Base64 注入链兼容）。
 */
module.exports = {
  onLoad: function (ctx, meta) {
    var SPOOL = 'C:/Users/Admin/Documents/Projects/agent-lead-spool';
    var INDEX = SPOOL + '/index.json';
    var POLL_MS = 8000;
    var MAX_CARDS = 8;
    var TAIL_LINES = 6;
    function sendInput(text) {
      try {
        if (typeof window.input === 'function') { window.input(text); return true; }
        if (typeof window.__dshInput === 'function') { window.__dshInput(text); return true; }
      } catch (e) { ctx.warn('sendInput fail: ' + (e && e.message)); }
      return false;
    }
    /* ---------- 可单测纯函数 ---------- */
    function parseIndex(text) {
      var items = [];
      try {
        var arr = JSON.parse(text || '[]');
        if (arr && arr.length !== undefined) {
          for (var i = 0; i < arr.length; i++) {
            var e = arr[i] || {};
            items.push({
              id: String(e.id || ''),
              agent: String(e.agent || '?'),
              title: String(e.title || ''),
              status: String(e.status || 'queued'),
              updated: String(e.updated || ''),
              progress: String(e.progress || ''),
              result: String(e.result || '')
            });
          }
        }
      } catch (e) { return { items: [], error: 'index.json 解析失败' }; }
      return { items: items, error: null };
    }
    function tailLines(text, n) {
      if (!text) return '';
      var ls = String(text).replace(/\s+$/, '').split('\n');
      if (ls.length <= n) return ls.join('\n');
      return ls.slice(ls.length - n).join('\n');
    }
    function statusColor(s) {
      if (s === 'running') return '#38bdf8';
      if (s === 'queued') return '#94a3b8';
      if (s === 'done') return '#34d399';
      if (s === 'failed') return '#f87171';
      if (s === 'cancelled') return '#64748b';
      return '#94a3b8';
    }
    function truncate(s, n) {
      if (!s) return '';
      return s.length > n ? s.slice(0, n) + '...' : s;
    }
    /* ---------- DOM ---------- */
    var host = ctx.el('div',
      'position:fixed;right:16px;top:120px;z-index:2147483644;' +
      'font:12px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
      'user-select:none;width:320px;max-width:92vw;', '');
    host.id = 'dsx-lead-host';
    var btn = ctx.el('div',
      'display:flex;align-items:center;gap:7px;padding:7px 13px;cursor:pointer;' +
      'background:rgba(16,22,34,.94);color:#dfe8f5;' +
      'border:1px solid rgba(255,255,255,.14);border-radius:999px;' +
      'box-shadow:0 8px 22px rgba(0,0,0,.44);', '');
    var dot = ctx.el('span',
      'width:8px;height:8px;border-radius:50%;flex:none;background:#6b7280;' +
      'box-shadow:0 0 0 3px rgba(107,114,128,.18);', '');
    var label = ctx.el('span',
      'font-weight:600;letter-spacing:.3px;color:#dfe8f5;flex:1;', 'Agent Lead');
    var refreshIcon = ctx.el('span',
      'font-size:11px;color:#64748b;cursor:pointer;padding:0 3px;', 'R');
    btn.appendChild(dot);
    btn.appendChild(label);
    btn.appendChild(refreshIcon);
    var panel = ctx.el('div',
      'display:none;margin-top:8px;padding:12px;' +
      'background:linear-gradient(160deg,rgba(18,24,36,.97),rgba(11,16,24,.97));' +
      'border:1px solid rgba(255,255,255,.12);border-radius:12px;' +
      'box-shadow:0 14px 36px rgba(0,0,0,.55);color:#b9c6d8;' +
      'max-height:70vh;overflow-y:auto;', '');
    var head = ctx.el('div',
      'font-size:11px;letter-spacing:1px;color:#7d8ea6;text-transform:uppercase;' +
      'margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.07);' +
      'display:flex;justify-content:space-between;', '');
    var headText = ctx.el('span', '', 'TEAM LEAD 看板');
    var headTime = ctx.el('span', 'color:#64748b;font-size:10px;', '');
    head.appendChild(headText);
    head.appendChild(headTime);
    var taskList = ctx.el('div', 'font-size:12px;line-height:1.6;margin-bottom:11px;', '');
    var btnRow = ctx.el('div', 'display:flex;flex-wrap:wrap;gap:6px;', '');
    function mkBtn(text) {
      var b = ctx.el('button',
        'flex:1;min-width:100px;padding:7px 10px;font:inherit;font-size:11.5px;font-weight:600;' +
        'color:#9fb2c9;background:transparent;border:1px solid rgba(255,255,255,.14);' +
        'border-radius:8px;cursor:pointer;', text);
      return b;
    }
    var bDispatch = mkBtn('发单');
    var bRefresh = mkBtn('刷新');
    btnRow.appendChild(bDispatch);
    btnRow.appendChild(bRefresh);
    var footer = ctx.el('div',
      'font-size:10px;color:#4b5a6f;margin-top:8px;padding-top:8px;' +
      'border-top:1px solid rgba(255,255,255,.06);text-align:center;',
      '点击卡片=汇报该任务 · 每 8 秒自动同步');
    panel.appendChild(head);
    panel.appendChild(taskList);
    panel.appendChild(btnRow);
    panel.appendChild(footer);
    host.appendChild(btn);
    host.appendChild(panel);
    function mount() {
      var root = document.body || document.documentElement;
      if (!root) return false;
      if (host.parentNode !== root) root.appendChild(host);
      return true;
    }
    mount();
    var mo = null;
    try {
      mo = new MutationObserver(function () { if (!host.parentNode) mount(); });
      var obRoot = document.body || document.documentElement;
      if (obRoot) mo.observe(obRoot, { childList: true });
    } catch (e) { ctx.warn('observer fail: ' + (e && e.message)); }
    /* ---------- 渲染 ---------- */
    function renderCards(items) {
      taskList.innerHTML = '';
      if (!items || items.length === 0) {
        taskList.appendChild(ctx.el('div',
          'color:#64748b;font-size:11.5px;text-align:center;padding:8px 0;', '暂无任务（用 lead dispatch 发单）'));
        return;
      }
      var shown = items.slice(0, MAX_CARDS);
      for (var i = 0; i < shown.length; i++) {
        (function (it) {
          var card = ctx.el('div',
            'background:rgba(255,255,255,.03);border-left:3px solid ' + statusColor(it.status) + ';' +
            'border-radius:0 8px 8px 0;padding:8px 10px;margin-bottom:7px;cursor:pointer;', '');
          var row1 = ctx.el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;', '');
          row1.appendChild(ctx.el('span',
            'font-family:Consolas,monospace;font-size:10.5px;color:' + statusColor(it.status) + ';font-weight:700;', it.id));
          row1.appendChild(ctx.el('span', 'font-size:10.5px;color:#7d8ea6;', it.agent + ' · ' + it.status));
          card.appendChild(row1);
          if (it.title) card.appendChild(ctx.el('div', 'font-size:11.5px;color:#c8d4e3;margin-bottom:3px;', truncate(it.title, 60)));
          if (it.tail) {
            var pre = ctx.el('div',
              'font-family:Consolas,monospace;font-size:10px;color:#8fa3bd;white-space:pre-wrap;' +
              'word-break:break-all;background:rgba(0,0,0,.28);border-radius:6px;padding:6px 8px;margin-top:4px;',
              it.tail);
            card.appendChild(pre);
          }
          ctx.on(card, 'click', function () {
            sendInput('汇报 lead 任务 ' + it.id + ' 的最新进度（读它的 progress/result 文件），有阻塞就处理，完成后归档');
          });
          taskList.appendChild(card);
        })(shown[i]);
      }
    }
    function paintBadge(items) {
      var nRun = 0, nQueue = 0, nFail = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].status === 'running') nRun++;
        else if (items[i].status === 'queued') nQueue++;
        else if (items[i].status === 'failed') nFail++;
      }
      if (nRun + nQueue + nFail === 0) {
        dot.style.background = '#6b7280';
        label.textContent = 'Agent Lead';
        return;
      }
      dot.style.background = nFail > 0 ? '#f87171' : (nRun > 0 ? '#38bdf8' : '#94a3b8');
      label.textContent = 'Lead ' + nRun + '跑/' + nQueue + '排' + (nFail > 0 ? '/' + nFail + '败' : '');
    }
    /* ---------- 读文件 ---------- */
    function readFile(path, cb) {
      try {
        if (!window.__agentBridge || typeof window.__agentBridge.requestFileRead !== 'function') { cb(null); return; }
        window.__agentBridge.requestFileRead(path, function (res) {
          cb(res && res.ok ? (res.content || '') : null);
        }, 5000);
      } catch (e) { cb(null); }
    }
    var refreshing = false;
    function refresh() {
      if (refreshing) return;
      if (!window.__agentBridge || typeof window.__agentBridge.requestFileRead !== 'function') {
        taskList.innerHTML = '';
        taskList.appendChild(ctx.el('div', 'color:#f87171;font-size:11.5px;', 'read_file 通道未就绪'));
        return;
      }
      refreshing = true;
      refreshIcon.textContent = '...';
      readFile(INDEX, function (text) {
        if (text === null) {
          refreshing = false;
          refreshIcon.textContent = 'R';
          taskList.innerHTML = '';
          taskList.appendChild(ctx.el('div', 'color:#f87171;font-size:11.5px;', 'index.json 读取失败'));
          return;
        }
        var parsed = parseIndex(text);
        if (parsed.error) {
          refreshing = false;
          refreshIcon.textContent = 'R';
          taskList.innerHTML = '';
          taskList.appendChild(ctx.el('div', 'color:#f87171;font-size:11.5px;', parsed.error));
          return;
        }
        var items = parsed.items;
        paintBadge(items);
        headTime.textContent = new Date().toLocaleTimeString();
        var pending = 0;
        for (var i = 0; i < items.length && i < MAX_CARDS; i++) {
          if (items[i].status === 'running' || items[i].status === 'queued') pending++;
        }
        if (pending === 0) {
          refreshing = false;
          refreshIcon.textContent = 'R';
          renderCards(items);
          return;
        }
        var left = pending;
        for (var j = 0; j < items.length && j < MAX_CARDS; j++) {
          (function (it) {
            if (it.status !== 'running' && it.status !== 'queued') return;
            readFile(SPOOL + '/' + it.progress, function (t) {
              it.tail = tailLines(t || '', TAIL_LINES);
              if (--left <= 0) {
                refreshing = false;
                refreshIcon.textContent = 'R';
                renderCards(items);
              }
            });
          })(items[j]);
        }
      });
    }
    /* ---------- 交互 ---------- */
    var expanded = false;
    var offBtn = ctx.on(btn, 'click', function (e) {
      if (e && e.target === refreshIcon) return;
      expanded = !expanded;
      panel.style.display = expanded ? 'block' : 'none';
      if (expanded) refresh();
    });
    var offRef = ctx.on(refreshIcon, 'click', function (e) {
      e.stopPropagation();
      refresh();
    });
    var offDis = ctx.on(bDispatch, 'click', function () {
      sendInput('用 lead dispatch 发一个 agent 子任务，先告诉我 agent/标题/brief，我确认后执行');
    });
    var offRe2 = ctx.on(bRefresh, 'click', function () { refresh(); });
    /* ---------- 轮询 ---------- */
    ctx.after(1500, refresh);
    ctx.every(POLL_MS, refresh);
    this._cleanup = function () {
      offBtn(); offRef(); offDis(); offRe2();
      if (mo) { try { mo.disconnect(); } catch (e) {} }
      if (host.parentNode) host.parentNode.removeChild(host);
      ctx.log('agent-lead-panel v1.0.0 已卸载');
    };
  },
  onUnload: function () {
    if (typeof this._cleanup === 'function') this._cleanup();
  }
};
