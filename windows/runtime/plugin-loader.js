/* DSX - DeepSeek Agent eXtensions runtime
 * 注入位置: WebView2 页面上下文 (通过 CDP Runtime.evaluate)
 * 职责: 插件注册表 / 生命周期 / 热重载替换 / 每插件隔离的 ctx
 * 版本: 1.0.0
 */
(function () {
  if (window.__DSX && window.__DSX.__ready) {
    console.log('[DSX] runtime 已存在, 跳过重复安装');
    return;
  }
  var VERSION = '1.0.0';
  var registry = new Map();
  var errorLog = [];
  function makeCtx(meta) {
    var tag = '[DSX:' + meta.name + ']';
    return {
      name: meta.name,
      version: meta.version || '0.0.0',
      log: function () { console.log.apply(console, [tag].concat([].slice.call(arguments))); },
      warn: function () { console.warn.apply(console, [tag].concat([].slice.call(arguments))); },
      error: function () { console.error.apply(console, [tag].concat([].slice.call(arguments))); },
      $: function (sel, root) { return (root || document).querySelector(sel); },
      $$: function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); },
      uiRoot: function () {
        return document.querySelector('main') ||
               document.querySelector('#root') ||
               document.body;
      },
      on: function (el, ev, fn, opt) {
        if (!el) return function () {};
        el.addEventListener(ev, fn, opt);
        return function () { el.removeEventListener(ev, fn, opt); };
      },
      observe: function (fn, opt) {
        var mo = new MutationObserver(fn);
        var cfg = Object.assign({ childList: true, subtree: true }, opt || {});
        mo.observe(document.documentElement, cfg);
        return function () { mo.disconnect(); };
      },
      _timers: [],
      every: function (ms, fn) {
        var id = setInterval(fn, ms);
        this._timers.push(function () { clearInterval(id); });
        return id;
      },
      after: function (ms, fn) {
        var id = setTimeout(fn, ms);
        this._timers.push(function () { clearTimeout(id); });
        return id;
      },
      store: {
        get: function (k, d) {
          try { var v = localStorage.getItem('dsx.' + meta.name + '.' + k); return v === null ? d : JSON.parse(v); }
          catch (e) { return d; }
        },
        set: function (k, v) {
          try { localStorage.setItem('dsx.' + meta.name + '.' + k, JSON.stringify(v)); } catch (e) {}
        },
        del: function (k) {
          try { localStorage.removeItem('dsx.' + meta.name + '.' + k); } catch (e) {}
        }
      },
      el: function (tag, css, text) {
        var n = document.createElement(tag);
        if (css) n.style.cssText = css;
        if (text != null) n.textContent = text;
        return n;
      }
    };
  }
  function unloadPlugin(name) {
    var rec = registry.get(name);
    if (!rec) return false;
    try {
      if (rec.instance && typeof rec.instance.onUnload === 'function') {
        rec.instance.onUnload();
      }
      if (rec.ctx && rec.ctx._timers) {
        rec.ctx._timers.forEach(function (f) { try { f(); } catch (e) {} });
      }
    } catch (e) {
      console.error('[DSX] 卸载失败 ' + name, e);
    }
    registry.delete(name);
    return true;
  }
  function loadPlugin(meta, source) {
    if (!meta || !meta.name) return { ok: false, error: 'meta.name 必填' };
    var name = meta.name;
    unloadPlugin(name);
    var ctx = makeCtx(meta);
    var captured = null;
    ctx.register = function (obj) { captured = obj; return obj; };
    try {
      var factory = new Function(
        'ctx', 'meta', 'module', 'exports',
        '"use strict";\n' + source + '\n;return module.exports;'
      );
      var module = { exports: {} };
      factory(ctx, meta, module, module.exports);
      var instance = (module.exports && typeof module.exports.onLoad === 'function')
        ? module.exports
        : (captured && typeof captured.onLoad === 'function' ? captured : null);
      if (!instance) {
        throw new Error('插件必须导出 { onLoad(ctx, meta) } (module.exports 或 ctx.register)');
      }
      if (typeof instance.onLoad === 'function') instance.onLoad(ctx, meta);
      registry.set(name, { instance: instance, meta: meta, source: source, ctx: ctx });
      console.log('[DSX] 已加载 ' + name + '@' + (meta.version || '0.0.0'));
      return { ok: true, name: name };
    } catch (e) {
      errorLog.push({ name: name, time: Date.now(), error: String(e && e.message || e) });
      console.error('[DSX] 加载失败 ' + name, e);
      return { ok: false, name: name, error: String(e && e.message || e) };
    }
  }
  window.__DSX = {
    __ready: true,
    version: VERSION,
    load: loadPlugin,
    unload: unloadPlugin,
    list: function () {
      return Array.from(registry.values()).map(function (r) {
        return { name: r.meta.name, version: r.meta.version || '0.0.0' };
      });
    },
    errors: function () { return errorLog.slice(); },
    _registry: registry
  };
  console.log('[DSX] runtime ' + VERSION + ' 已安装');
})();
