/* 示例插件: hello-panel
 * 在页面右下角显示一个悬浮面板, 证明插件系统可用
 * 演示: ctx.el / ctx.on / ctx.every / ctx.store / onUnload 清理
 */
module.exports = {
  onLoad: function (ctx, meta) {
    ctx.log('hello-panel 加载中, 版本 ' + meta.version);
    var count = ctx.store.get('loadCount', 0) + 1;
    ctx.store.set('loadCount', count);
    var panel = ctx.el('div',
      'position:fixed;left:16px;bottom:16px;z-index:2147483646;' +
      'background:rgba(20,24,32,.92);color:#7ee787;border:1px solid #2d4a3a;' +
      'border-radius:10px;padding:10px 14px;font:12px/1.6 Consolas,monospace;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer;user-select:none;max-width:280px;',
      ''
    );
    var title = ctx.el('div', 'font-weight:700;margin-bottom:4px;color:#58a6ff;', 'DSX 运行时');
    var body = ctx.el('div', '', '');
    var stat = ctx.el('div', 'margin-top:6px;color:#8b949e;font-size:11px;', '');
    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(stat);
    var clicks = 0;
    var offClick = ctx.on(panel, 'click', function () {
      clicks++;
      body.textContent = '点击次数: ' + clicks;
      ctx.log('面板被点击 ' + clicks + ' 次');
    });
    var offTimer = ctx.every(1000, function () {
      var t = new Date().toLocaleTimeString();
      stat.textContent = '在线 ' + t + ' | 加载第 ' + count + ' 次';
    });
    ctx.uiRoot().appendChild(panel);
    body.textContent = '插件已挂载';
    // 必须提供 onUnload, 否则热重载会残留 DOM 和定时器
    this._cleanup = function () {
      offClick();
      offTimer && clearInterval(offTimer);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      ctx.log('hello-panel 已卸载, DOM 与定时器已清理');
    };
  },
  onUnload: function () {
    if (typeof this._cleanup === 'function') this._cleanup();
  }
};



