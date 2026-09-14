/* DSX 插件: task-state-panel v2.0.0
 * v2.0.0: 通过原生 read_file 通道直接读 00-Dashboard/Task-State.md,
 *         实时渲染真实任务列表. 徽章数字 = 文件内实际值, 不再扫对话文本.
 * 依赖: window.__agentBridge.requestFileRead (C# read_file action)
 * 无 Emoji; 无外部资源; onUnload 完整清理.
 */
module.exports = {
  onLoad: function (ctx, meta) {
    var TS_PATH = '~/Documents/ObsidianVault/00-Dashboard/Task-State.md';
    var POLL_MS = 8000;
    function sendInput(text) {
      try {
        if (typeof window.input === 'function') { window.input(text); return true; }
        if (typeof window.__dshInput === 'function') { window.__dshInput(text); return true; }
      } catch (e) { ctx.warn('sendInput fail: ' + (e && e.message)); }
      return false;
    }
    /* ---------- DOM ---------- */
    var host = ctx.el('div',
      'position:fixed;right:20px;top:88px;z-index:2147483645;' +
      'font:12px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
      'user-select:none;width:300px;max-width:92vw;', '');
    host.id = 'dsx-tsp-host';
    var btn = ctx.el('div',
      'display:flex;align-items:center;gap:7px;padding:7px 13px;cursor:pointer;' +
      'background:rgba(16,22,34,.94);color:#dfe8f5;' +
      'border:1px solid rgba(255,255,255,.14);border-radius:999px;' +
      'box-shadow:0 8px 22px rgba(0,0,0,.44);', '');
    var dot = ctx.el('span',
      'width:8px;height:8px;border-radius:50%;flex:none;background:#6b7280;' +
      'box-shadow:0 0 0 3px rgba(107,114,128,.18);', '');
    var label = ctx.el('span',
      'font-weight:600;letter-spacing:.3px;color:#dfe8f5;flex:1;', '任务状态');
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
      'display:flex;justify-content:space-between;',
      '');
    var headText = ctx.el('span', '', 'TASK-STATE 断点');
    var headTime = ctx.el('span', 'color:#64748b;font-size:10px;', '');
    head.appendChild(headText);
    head.appendChild(headTime);
    var taskList = ctx.el('div',
      'font-size:12px;line-height:1.6;margin-bottom:11px;', '');
    var btnRow = ctx.el('div', 'display:flex;flex-wrap:wrap;gap:6px;', '');
    function mkBtn(text, primary) {
      var b = ctx.el('button',
        'flex:1;min-width:100px;padding:7px 10px;' +
        'font:inherit;font-size:11.5px;font-weight:600;letter-spacing:.3px;' +
        'color:' + (primary ? '#0b0f17' : '#9fb2c9') + ';' +
        'background:' + (primary ? 'linear-gradient(135deg,#7dd3fc,#a78bfa)' : 'transparent') + ';' +
        'border:' + (primary ? 'none' : '1px solid rgba(255,255,255,.14)') + ';' +
        'border-radius:8px;cursor:pointer;transition:.15s;', text);
      b.onmouseover = function () { b.style.transform = 'translateY(-1px)'; };
      b.onmouseout = function () { b.style.transform = 'none'; };
      return b;
    }
    var bNew = mkBtn('新建任务', false);
    var bUpdate = mkBtn('更新断点', false);
    var bDone = mkBtn('归档完成', false);
    btnRow.appendChild(bNew);
    btnRow.appendChild(bUpdate);
    btnRow.appendChild(bDone);
    var footer = ctx.el('div',
      'font-size:10px;color:#4b5a6f;margin-top:8px;padding-top:8px;' +
      'border-top:1px solid rgba(255,255,255,.06);text-align:center;',
      '点击 R 手动刷新 · 每 8 秒自动同步');
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
    /* ---------- 解析 Task-State.md ---------- */
    var RE_ENTRY = /^##\s+\[(ACTIVE|BLOCKED|PAUSED|STALE)\]\s+(T-\S+)\s*[·.]\s*(.+)$/gm;
    function parseTaskState(text) {
      var items = [];
      var m;
      RE_ENTRY.lastIndex = 0;
      var positions = [];
      while ((m = RE_ENTRY.exec(text)) !== null) {
        positions.push({ idx: m.index, status: m[1], id: m[2], project: m[3].trim(), len: m[0].length });
      }
      for (var i = 0; i < positions.length; i++) {
        var start = positions[i].idx + positions[i].len;
        var end = (i + 1 < positions.length) ? positions[i + 1].idx : text.length;
        var body = text.slice(start, end);
        var obj = { status: positions[i].status, id: positions[i].id, project: positions[i].project, goal: '', checkpoint: '', next: '', blockers: '' };
        var gm = body.match(/^-\s+\*\*goal\*\*:\s*(.+)$/m); if (gm) obj.goal = gm[1].trim();
        var cm = body.match(/^-\s+\*\*checkpoint\*\*:\s*(.+)$/m); if (cm) obj.checkpoint = cm[1].trim();
        var nm = body.match(/^-\s+\*\*next\*\*:\s*(.+)$/m); if (nm) obj.next = nm[1].trim();
        var bm = body.match(/^-\s+\*\*blockers\*\*:\s*(.+)$/m); if (bm) obj.blockers = bm[1].trim();
        items.push(obj);
      }
      return items;
    }
    function statusColor(s) {
      if (s === 'ACTIVE') return '#34d399';
      if (s === 'BLOCKED') return '#fbbf24';
      if (s === 'PAUSED') return '#94a3b8';
      return '#64748b';
    }
    function truncate(s, n) {
      if (!s) return '';
      return s.length > n ? s.slice(0, n) + '...' : s;
    }
    function render(items, errMsg) {
      if (errMsg) {
        taskList.innerHTML = '';
        var e = ctx.el('div', 'color:#f87171;font-size:11.5px;', errMsg);
        taskList.appendChild(e);
        return;
      }
      if (!items || items.length === 0) {
        taskList.innerHTML = '';
        var n = ctx.el('div', 'color:#64748b;font-size:11.5px;text-align:center;padding:8px 0;', '无活动任务');
        taskList.appendChild(n);
        return;
      }
      taskList.innerHTML = '';
      items.forEach(function (it) {
        var card = ctx.el('div',
          'background:rgba(255,255,255,.03);border-left:3px solid ' + statusColor(it.status) + ';' +
          'border-radius:0 8px 8px 0;padding:8px 10px;margin-bottom:7px;', '');
        var row1 = ctx.el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;', '');
        var idSpan = ctx.el('span', 'font-family:Consolas,monospace;font-size:10.5px;color:' + statusColor(it.status) + ';font-weight:700;', it.id);
        var projSpan = ctx.el('span', 'font-size:10.5px;color:#7d8ea6;', truncate(it.project, 18));
        row1.appendChild(idSpan);
        row1.appendChild(projSpan);
        card.appendChild(row1);
        if (it.goal) {
          var g = ctx.el('div', 'font-size:11.5px;color:#c8d4e3;margin-bottom:3px;', truncate(it.goal, 60));
          card.appendChild(g);
        }
        if (it.next) {
          var nx = ctx.el('div', 'font-size:10.5px;color:#9fb2c9;', 'NEXT: ' + truncate(it.next, 60));
          card.appendChild(nx);
        }
        if (it.blockers && it.blockers !== '无') {
          var bl = ctx.el('div', 'font-size:10.5px;color:#fbbf24;margin-top:3px;', 'BLOCK: ' + truncate(it.blockers, 50));
          card.appendChild(bl);
        }
        taskList.appendChild(card);
      });
    }
    /* ---------- 读文件 ---------- */
    var lastOk = 0;
    var refreshing = false;
    function refresh() {
      if (refreshing) return;
      if (!window.__agentBridge || typeof window.__agentBridge.requestFileRead !== 'function') {
        render(null, 'read_file 通道未就绪 (bridge 或 dll 版本不匹配)');
        return;
      }
      refreshing = true;
      refreshIcon.textContent = '...';
      window.__agentBridge.requestFileRead(TS_PATH, function (res) {
        refreshing = false;
        refreshIcon.textContent = 'R';
        if (!res || !res.ok) {
          render(null, '读取失败: ' + (res && res.error ? res.error : 'unknown'));
          dot.style.background = '#ef4444';
          dot.style.boxShadow = '0 0 0 3px rgba(239,68,68,.18)';
          return;
        }
        lastOk = Date.now();
        var items = parseTaskState(res.content || '');
        var nActive = items.filter(function (x) { return x.status === 'ACTIVE'; }).length;
        var nBlocked = items.filter(function (x) { return x.status === 'BLOCKED'; }).length;
        if (nActive > 0 || nBlocked > 0) {
          dot.style.background = nBlocked > 0 ? '#fbbf24' : '#34d399';
          dot.style.boxShadow = nBlocked > 0
            ? '0 0 0 3px rgba(251,191,36,.2), 0 0 10px rgba(251,191,36,.7)'
            : '0 0 0 3px rgba(52,211,153,.2), 0 0 10px rgba(52,211,153,.7)';
          label.textContent = '任务 ' + nActive + (nBlocked > 0 ? ' / 阻塞 ' + nBlocked : '');
        } else {
          dot.style.background = '#6b7280';
          dot.style.boxShadow = '0 0 0 3px rgba(107,114,128,.18)';
          label.textContent = '任务状态';
        }
        headTime.textContent = new Date().toLocaleTimeString();
        render(items, null);
      }, 5000);
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
    var offNew = ctx.on(bNew, 'click', function () {
      sendInput('在 00-Dashboard/Task-State.md 顶部新建一条 ACTIVE 任务, ID 用 T-今天日期-序号, 我现在告诉你 project 和 goal');
    });
    var offUpd = ctx.on(bUpdate, 'click', function () {
      sendInput('更新 00-Dashboard/Task-State.md 里当前 ACTIVE 任务的 checkpoint 和 next, 并刷新 updated 时间戳');
    });
    var offDone = ctx.on(bDone, 'click', function () {
      sendInput('把当前已完成的任务按现有格式追加到 00-Dashboard/Changelog-Stream.md 和对应项目卡片, 然后从 Task-State.md 中删除该条目');
    });
    /* ---------- 轮询 ---------- */
    ctx.after(1500, refresh);
    ctx.every(POLL_MS, refresh);
    this._cleanup = function () {
      offBtn(); offRef(); offNew(); offUpd(); offDone();
      if (mo) { try { mo.disconnect(); } catch (e) {} }
      if (host.parentNode) host.parentNode.removeChild(host);
      ctx.log('task-state-panel v2.0.0 已卸载');
    };
  },
  onUnload: function () {
    if (typeof this._cleanup === 'function') this._cleanup();
  }
};