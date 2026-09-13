/* DSX 插件: file-path-drop - 路径拼贴 + 上传误报屏蔽 (v3: 轮询替代 observe 规避早期注入坑) */
module.exports = {
  onLoad: function (ctx, meta) {
    function post(msg) {
      try {
        var wv = window.chrome && window.chrome.webview;
        if (wv && typeof wv.postMessage === 'function') { wv.postMessage(msg); return true; }
      } catch (e) { ctx.error('postMessage fail: ' + e.message); }
      return false;
    }
    var lastAt = 0;
    function onKey(e) {
      var k = e.key || '';
      var code = e.keyCode || 0;
      var isCtrlV = (e.ctrlKey || e.metaKey) && !e.altKey && (k === 'v' || k === 'V' || code === 86);
      var isShiftIns = e.shiftKey && (k === 'Insert' || code === 45);
      if (!isCtrlV && !isShiftIns) return;
      var now = Date.now();
      if (now - lastAt < 300) return;
      lastAt = now;
      if (post({ action: 'test_clipboard_paste' })) { ctx.log('clipboard paste -> native'); }
    }
    var offKey = ctx.on(window, 'keydown', onKey, true);
    function onPaste(e) {
      var dt = e.clipboardData;
      if (!dt) return;
      var hasFile = false;
      try {
        if (dt.files && dt.files.length) hasFile = true;
        if (!hasFile && dt.types) {
          for (var i = 0; i < dt.types.length; i++) { if (dt.types[i] === 'Files') { hasFile = true; break; } }
        }
      } catch (err) {}
      if (!hasFile) return;
      e.preventDefault();
      e.stopPropagation();
      ctx.log('blocked page paste upload');
    }
    var offPaste = ctx.on(document, 'paste', onPaste, true);
    function toWinPath(uri) {
      var s = String(uri).trim();
      if (!s) return '';
      if (s.indexOf('file:///') === 0) s = s.slice(8);
      else if (s.indexOf('file://') === 0) s = s.slice(7);
      else if (s.indexOf('file:') === 0) s = s.slice(5);
      try { s = decodeURIComponent(s); } catch (e) {}
      if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
      return s.replace(/\//g, '\\');
    }
    function onDrop(e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var uri = '';
      try { uri = dt.getData('text/uri-list') || ''; } catch (err) {}
      if (!uri) return;
      var out = [];
      uri.split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (line && line.indexOf('file:') === 0) out.push(toWinPath(line));
      });
      if (!out.length) return;
      e.preventDefault();
      e.stopPropagation();
      var text = out.map(function (p) { return /\s/.test(p) ? '"' + p + '"' : p; }).join(' ');
      var ta = document.querySelector('textarea');
      if (ta) {
        ta.focus();
        var d = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        var cur = ta.value || '', pos = cur.length;
        d.set.call(ta, cur + text);
        ta.selectionStart = ta.selectionEnd = pos + text.length;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ctx.log('drop fallback insert');
      }
    }
    var offDrop = ctx.on(document, 'drop', onDrop, true);
    var NEEDLE = 'uploaded file format is not supported';
    function sweepToasts() {
      try {
        var nodes = document.querySelectorAll('.ds-toast-container > *');
        for (var i = nodes.length - 1; i >= 0; i--) {
          var n = nodes[i];
          var t = (n.textContent || '').toLowerCase();
          if (t.indexOf(NEEDLE) !== -1) { try { n.remove(); ctx.log('toast suppressed'); } catch (e) {} }
        }
      } catch (err) {}
    }
    sweepToasts();
    var timerId = ctx.every(250, sweepToasts);
    this._c = function () { offKey(); offPaste(); offDrop(); if (timerId) { try { clearInterval(timerId); } catch (e) {} } };
    ctx.log('file-path-drop loaded v3 (poll-based)');
  },
  onUnload: function () { if (this._c) this._c(); }
};