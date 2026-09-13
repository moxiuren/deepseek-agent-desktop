/* DSX 插件: file-path-drop
 * 目标: 像终端一样把文件"拼贴"成完整路径插入聊天输入框。
 *
 * 背景(实测): 客户端原生实现了两条链路, 但触发端都断了 —
 *   - WPF Window 的 PreviewDrop: WebView2(HwndHost) 占满窗口, 收不到 drop;
 *   - ComponentDispatcher 的 Ctrl+V 分支: 源码注释明示 WebView2 原生窗口绕过
 *     WPF dispatcher pump, 页面有焦点时 ComponentDispatcher 看不到按键;
 *   - 页面层 drop 事件: 实测零事件到达(探针 40s 无 dragenter/drop)。
 *   而原生处理函数本身完好: webMessage {action:"test_clipboard_paste"}
 *   -> Clipboard.ContainsFileDropList -> FormatPathsForTerminal -> insertText,
 *   已实测插入 `C:\...\hosts "C:\Program Files\...\oledb32.dll"` 成功。
 *
 * 本插件补齐触发端: 页面捕获 Ctrl+V / Shift+Insert -> 通知原生层处理剪贴板文件。
 * 剪贴板若无文件, 原生层直接返回, 不影响普通文本粘贴(故不 preventDefault)。
 */
module.exports = {
  onLoad: function (ctx, meta) {
    function post(msg) {
      try {
        var wv = window.chrome && window.chrome.webview;
        if (wv && typeof wv.postMessage === 'function') { wv.postMessage(msg); return true; }
      } catch (e) { ctx.error('postMessage 失败: ' + e.message); }
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
      if (now - lastAt < 300) return;   // 去抖
      lastAt = now;
      if (post({ action: 'test_clipboard_paste' })) {
        ctx.log('已请求原生层处理剪贴板文件路径 (Ctrl+V / Shift+Insert)');
      }
    }
    // 捕获阶段监听, 确保先于页面其它处理
    var offKey = ctx.on(window, 'keydown', onKey, true);
    // 附带: 若页面层真的收到 drop(某些环境 AllowExternalDrop 行为不同), 兜底处理
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
        ctx.log('drop 兜底插入: ' + text);
      }
    }
    var offDrop = ctx.on(document, 'drop', onDrop, true);
    this._c = function () { offKey(); offDrop(); };
    ctx.log('file-path-drop 已挂载 (Ctrl+V / Shift+Insert -> 原生剪贴板文件路径插入)');
  },
  onUnload: function () { if (this._c) this._c(); }
};