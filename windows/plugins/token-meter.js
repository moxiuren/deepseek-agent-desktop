/* token-meter.js v5 - 网页版 token 计量 + API 成本折算（按会话分桶 + 峰谷定价）
 *
 * 定价：DeepSeek V4.1 Flash，元/百万 token，[空闲, 高峰]
 *   缓存命中  [0.02, 0.04]
 *   缓存未命中 [1, 2]
 *   输出      [4, 8]
 * 高峰 = 工作日 9:00-12:00、14:00-18:00（北京时间）；周末全天谷价。
 */
module.exports = {
  onLoad: function (ctx, meta) {
    var W = window;
    if (W.__TM && W.__TM.destroy) { try { W.__TM.destroy(); } catch (e) {} }

    var FLASH = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
    var LS = 'tm.v5.data';
    var MAX_SESSIONS = 50;

    /* 峰谷：ts 毫秒 -> 是否高峰 */
    function isPeak(ts) {
      var d = new Date(ts + 8 * 3600000);
      var day = d.getUTCDay();
      if (day === 0 || day === 6) return false;
      var h = d.getUTCHours();
      return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }
    function priceOf(ts) {
      var off = isPeak(ts) ? 1 : 0;
      return { hit: FLASH.hit[off], miss: FLASH.miss[off], out: FLASH.out[off], peak: !!off };
    }

    /* 成本：按轮次时间取价 */
    function turnCostFull(inTok, cacheTok, outTok, ts) {
      var p = priceOf(ts);
      var miss = Math.max(0, inTok - cacheTok);
      return (cacheTok / 1e6) * p.hit + (miss / 1e6) * p.miss + (outTok / 1e6) * p.out;
    }
    function turnCost(inTok, outTok, ts) {
      return turnCostFull(inTok, 0, outTok, ts);
    }

    var DB = { current: '', sessions: {}, seq: 0 };

    function blankSess(id) {
      return { id: id, acc: 0, inTok: 0, cacheTok: 0, outTok: 0, turns: 0, calls: 0, ver: 2,
               aligned: false, lastTs: Date.now(), lastTurnHi: 0 };
    }
    function loadDB() {
      try {
        var raw = localStorage.getItem(LS);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && o.sessions && typeof o.sessions === 'object') {
            DB = o;
            if (!DB.current) DB.current = '';for (var _k in DB.sessions) { var _s = DB.sessions[_k]; if (_s && _s.ver !== 2) { _s.turns = 0; _s.calls = 0; _s.ver = 2; } }
            if (typeof DB.seq !== 'number') DB.seq = 0;
          }
        }
        ['tm.v4.data','tm.v33.state','tm.v32.state','tm.v31.state'].forEach(function (k) {
          try { localStorage.removeItem(k); } catch (e) {}
        });
      } catch (e) {}
    }
    function saveDB() {
      try {
        var keys = Object.keys(DB.sessions);
        if (keys.length > MAX_SESSIONS) {
          keys.sort(function (a, b) {
            return (DB.sessions[a].lastTs || 0) - (DB.sessions[b].lastTs || 0);
          });
          var drop = keys.length - MAX_SESSIONS;
          for (var i = 0; i < drop; i++) delete DB.sessions[keys[i]];
        }
        localStorage.setItem(LS, JSON.stringify(DB));
      } catch (e) {}
    }
    loadDB();

    function estTok(s) {
      if (!s) return 0;
      var t = String(s);
      var cjk = (t.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
      return Math.round(cjk * 1.0 + (t.length - cjk) / 3.5);
    }
    function histOutRatio(acc) {
      if (acc < 20000)  return 0.35;
      if (acc < 100000) return 0.20;
      if (acc < 500000) return 0.08;
      return 0.04;
    }
    function isToolReturn(b){if(!b)return false;var s=String(b);var i=s.indexOf("+prompt+");if(i<0)return false;return s.slice(i,i+60).indexOf("+Tool Call Result")>=0;}function grabSessionId(body) {
      if (!body) return '';
      var s = '';
      try { s = (typeof body === 'string') ? body : ''; } catch (e) { return ''; }
      if (!s) return '';
      var m = s.match(/"chat_session_id"\s*:\s*"([^"]+)"/);
      return m ? m[1] : '';
    }
    var RE_OUT = /data:\s*\{"v":"((?:[^"\\]|\\.)*)"\}/g;
    function extractOut(buf) {
      if (!buf) return '';
      var txt = '', m;
      RE_OUT.lastIndex = 0;
      while ((m = RE_OUT.exec(buf)) !== null) {
        try { txt += JSON.parse('"' + m[1] + '"'); } catch (e) {}
      }
      return txt;
    }
    function pickAcc(txt) {
      if (!txt) return 0;
      var m = String(txt).match(/"accumulated_token_usage"\s*:\s*(\d+)/g);
      if (!m || !m.length) return 0;
      var g = m[m.length - 1].match(/(\d+)/);
      return g ? parseInt(g[1], 10) : 0;
    }
    function urlSid() {
      try {
        var m = location.pathname.match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : '';
      } catch (e) { return ''; }
    }

    function switchTo(sid) {
      if (!sid || sid === DB.current) return;
      DB.current = sid;
      if (!DB.sessions[sid]) DB.sessions[sid] = blankSess(sid);
      saveDB();
      schedule();
    }

    function feed(acc, outText, sid, isTool) {
      if (!sid || !acc || acc <= 0) return;
      switchTo(sid);

      var S = DB.sessions[sid];
      var now = Date.now();
      S.lastTs = now;
      if (acc <= S.acc) { saveDB(); return; }

      var delta = acc - S.acc;

      if (!S.aligned) {
        var hr = histOutRatio(acc);
        S.outTok = Math.round(acc * hr);
        S.inTok = acc - S.outTok;
        S.cacheTok = Math.round(S.inTok * 0.7);
        S.acc = acc;
        S.turns = 1;S.calls = 1;
        S.aligned = true;
        S.lastTurnHi = turnCostFull(S.inTok, S.cacheTok, S.outTok, now);
        DB.seq = (DB.seq || 0) + 1;
        saveDB(); schedule();
        return;
      }

      var outThis = estTok(outText);
      if (outThis <= 0 || outThis > delta * 0.9) {
        outThis = Math.round(delta * histOutRatio(acc));
      }
      var inThis = delta - outThis;
      if (inThis < 0) { inThis = delta; outThis = 0; }
      var cacheThis = Math.round(inThis * 0.7);

      S.inTok += inThis;
      S.cacheTok += cacheThis;
      S.outTok += outThis;
      S.acc = acc;
      S.calls = (S.calls||0)+1;
      if(!isTool) S.turns += 1;
      S.lastTurnHi = turnCostFull(inThis, cacheThis, outThis, now);
      DB.seq = (DB.seq || 0) + 1;
      saveDB();
      schedule();
    }

    var _xo = XMLHttpRequest.prototype.open, _xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { this.__tmU = u; } catch (e) {}
      return _xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var self = this;
      try {
        if (String(this.__tmU || '').indexOf('/api/v0/chat/completion') >= 0) {
          var sid = grabSessionId(body);var isTool = isToolReturn(body);
          this.addEventListener('load', function () {
            try {
              var t = self.responseText || '';
              feed(pickAcc(t), extractOut(t), sid || urlSid(), isTool);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return _xs.apply(this, arguments);
    };

    var _f = W.fetch;
    var _fh = function (input, init) {
      var p = _f.apply(this, arguments);
      try {
        var url = (typeof input === 'string') ? input : ((input && input.url) || '');
        if (String(url).indexOf('/api/v0/chat/completion') >= 0) {
          var sid = grabSessionId(init && init.body);var isTool = isToolReturn(init && init.body);
          p.then(function (r) {
            try {
              var c = r.clone();
              if (c.body && c.body.getReader) {
                var rd = c.body.getReader(), buf = '';
                (function pump() {
                  rd.read().then(function (x) {
                    if (x.done) { feed(pickAcc(buf), extractOut(buf), sid || urlSid(), isTool); return; }
                    try {
                      buf += new TextDecoder().decode(x.value);
                      if (buf.length > 500000) buf = buf.slice(-250000);
                    } catch (e) {}
                    pump();
                  }).catch(function () {});
                })();
              }
            } catch (e) {}
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
    _fh.__tmWrap = true;
    W.fetch = _fh;    function sessStats(S) {
      if (!S) return { acc:0, inTok:0, cacheTok:0, outTok:0, turns:0, hi:0, peak:false };
      var now = Date.now();
      var p = priceOf(now);
      var miss = Math.max(0, S.inTok - S.cacheTok);
      var hi = (S.cacheTok/1e6)*p.hit + (miss/1e6)*p.miss + (S.outTok/1e6)*p.out;
      return { acc:S.acc, inTok:S.inTok, cacheTok:S.cacheTok, outTok:S.outTok, calls:S.calls||0,
               turns:S.turns, hi:hi, peak:p.peak, price:p };
    }
    function totalAll() {
      var t = { hi:0, n:0, turns:0 };
      var now = Date.now();
      var p = priceOf(now);
      for (var k in DB.sessions) {
        if (!DB.sessions.hasOwnProperty(k)) continue;
        var S = DB.sessions[k];
        var miss = Math.max(0, S.inTok - S.cacheTok);
        t.hi += (S.cacheTok/1e6)*p.hit + (miss/1e6)*p.miss + (S.outTok/1e6)*p.out;
        t.turns += S.turns;
        t.n++;
      }
      return t;
    }
    function money(n) { return n < 0.005 ? '0.00' : (n < 1 ? n.toFixed(3) : n.toFixed(2)); }
    function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    var css = '' +
      '.tm5{position:fixed;left:12px;bottom:12px;z-index:9998;font:12px/1.55 -apple-system,"Segoe UI",sans-serif;' +
      'background:rgba(20,26,42,.94);color:#dfe6f5;border:1px solid rgba(110,140,200,.45);border-radius:11px;' +
      'padding:11px 13px;min-width:248px;box-shadow:0 8px 24px rgba(0,0,0,.4);user-select:none;backdrop-filter:blur(8px)}' +
      '.tm5-h{font-weight:600;color:#8fb4ff;margin-bottom:7px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px}' +
      '.tm5-h .tg{font-size:10px;opacity:.6;font-weight:400}' +
      '.tm5-r{display:flex;justify-content:space-between;gap:16px;margin:2.5px 0}' +
      '.tm5-k{opacity:.7}.tm5-v{font-variant-numeric:tabular-nums;font-weight:600}' +
      '.tm5-sub{padding-left:12px;font-size:11px}.tm5-sub .tm5-k{opacity:.55}' +
      '.tm5-sid{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:#8fb4ff;opacity:.85}' +
      '.tm5-pk{font-size:9.5px;padding:1px 5px;border-radius:3px;margin-left:5px}' +
      '.tm5-pk.off{background:rgba(74,222,128,.18);color:#4ade80}' +
      '.tm5-pk.on{background:rgba(251,113,133,.2);color:#fb7185}' +
      '.tm5-big{margin-top:8px;padding-top:8px;border-top:1px solid rgba(110,140,200,.28);text-align:center}' +
      '.tm5-big .n{font-size:21px;font-weight:800;color:#4ade80;font-variant-numeric:tabular-nums;letter-spacing:-.02em}' +
      '.tm5-big .l{font-size:10px;opacity:.6;margin-top:1px}' +
      '.tm5-all{margin-top:6px;padding-top:6px;border-top:1px solid rgba(110,140,200,.18);font-size:10px;opacity:.62;display:flex;justify-content:space-between}' +
      '.tm5-f{font-size:9.5px;opacity:.45;margin-top:5px;text-align:center;line-height:1.4}' +
      '.tm5.min .tm5-b,.tm5.min .tm5-f{display:none}.tm5.min{padding:7px 11px;min-width:0}';

    var se = document.createElement('style');
    se.textContent = css;
    document.head.appendChild(se);

    var box = document.createElement('div');
    box.className = 'tm5';
    box.innerHTML =
      '<div class="tm5-h">Token 计量 <span class="tm5-pk" id="tm5-pk">--</span><span class="tg">[-]</span></div>' +
      '<div class="tm5-b">' +
      '<div class="tm5-r"><span class="tm5-k">会话</span><span class="tm5-v tm5-sid" id="tm5-sid">--</span></div>' +
      '<div class="tm5-r"><span class="tm5-k">轮次 / 调用</span><span class="tm5-v" id="tm5-tn">0</span></div>' +
      '<div class="tm5-r"><span class="tm5-k">计费总量</span><span class="tm5-v" id="tm5-ac">0</span></div>' +
      '<div class="tm5-r tm5-sub"><span class="tm5-k">输入(未命中)</span><span class="tm5-v" id="tm5-in">0</span></div>' +
      '<div class="tm5-r tm5-sub"><span class="tm5-k">输入(命中)</span><span class="tm5-v" id="tm5-ca">0</span></div>' +
      '<div class="tm5-r tm5-sub"><span class="tm5-k">输出</span><span class="tm5-v" id="tm5-out">0</span></div>' +
      '</div>' +
      '<div class="tm5-big"><div class="n" id="tm5-sv">0.00</div><div class="l">本会话已省 (元)</div></div>' +
      '<div class="tm5-all"><span id="tm5-cnt">共 0 个会话</span><span id="tm5-tot">合计 ￥0</span></div>' +
      '<div class="tm5-f">V4.1 Flash | 命中 0.02/0.04 · 未命中 1/2 · 输出 4/8<br>空闲 / 高峰 (工作日 9-12,14-18)</div>';
    document.body.appendChild(box);

    var q = function (id) { return box.querySelector('#' + id); };
    var mini = false;
    box.querySelector('.tm5-h').addEventListener('click', function (e) {
      if (e.target.id === 'tm5-pk') return;
      mini = !mini;
      box.classList.toggle('min', mini);
      box.querySelector('.tg').textContent = mini ? '[+]' : '[-]';
    });

    var pend = null;
    function schedule() {
      if (pend) return;
      pend = setTimeout(function () { pend = null; render(); }, 600);
    }

    var lastUrlSid = '';
    function syncFromUrl() {
      var sid = urlSid();
      if (sid && sid !== lastUrlSid) {
        lastUrlSid = sid;
        switchTo(sid);
      }
    }

    var lastSig = '';
    function render() {
      syncFromUrl();
      var S = DB.current ? DB.sessions[DB.current] : null;
      var r = sessStats(S);
      var tot = totalAll();

      var pk = q('tm5-pk');
      pk.textContent = r.peak ? '高峰' : '空闲';
      pk.className = 'tm5-pk ' + (r.peak ? 'on' : 'off');

      q('tm5-sid').textContent = DB.current ? DB.current.slice(0, 8) : '--';
      q('tm5-tn').textContent = r.turns + ' / ' + (r.calls||0);
      q('tm5-ac').textContent = fmt(r.acc);
      q('tm5-in').textContent = fmt(Math.max(0, r.inTok - r.cacheTok));
      q('tm5-ca').textContent = fmt(r.cacheTok);
      q('tm5-out').textContent = fmt(r.outTok);
      q('tm5-sv').textContent = money(r.hi);
      q('tm5-cnt').textContent = '共 ' + tot.n + ' 个会话';
      q('tm5-tot').textContent = '合计 ￥' + money(tot.hi);

      var sig = DB.current + ':' + r.turns + ':' + r.hi.toFixed(4) + ':' + (r.peak ? 1 : 0);
      if (sig !== lastSig) {
        lastSig = sig;
        try {
          ctx.log('[token-meter] sid=' + (DB.current || 'none').slice(0,8) +
                  ' t=' + r.turns + ' acc=' + r.acc +
                  ' peak=' + (r.peak ? 'Y' : 'N') + ' Y' + r.hi.toFixed(4));
        } catch (e) {}
      }
    }

    render();
    var iv = setInterval(render, 2500);

    W.__TM = {
      version: '5.0.0',
      price: FLASH,
      isPeak: function () { return isPeak(Date.now()); },
      priceNow: function () { return priceOf(Date.now()); },
      db: function () { return JSON.parse(JSON.stringify(DB)); },
      current: function () { return DB.current ? sessStats(DB.sessions[DB.current]) : null; },
      totals: totalAll,
      whale: function () {
        var S = DB.current ? DB.sessions[DB.current] : null;
        var r = sessStats(S);
        return {
          ok: true,
          seq: DB.seq || 0,
          sid: DB.current || '',
          turns: r.turns, calls: r.calls,
          acc: r.acc,
          inTok: r.inTok,
          cacheTok: r.cacheTok,
          outTok: r.outTok,
          hi: r.hi,
          peak: r.peak,
          lastTurnHi: S ? (S.lastTurnHi || 0) : 0
        };
      },
      reset: function () {
        DB = { current: '', sessions: {}, seq: 0 };
        try { localStorage.removeItem(LS); } catch (e) {}
        render();
      },
      destroy: function () {
        try { clearInterval(iv); } catch (e) {}
        try { if (pend) clearTimeout(pend); } catch (e) {}
        try { XMLHttpRequest.prototype.open = _xo; } catch (e) {}
        try { XMLHttpRequest.prototype.send = _xs; } catch (e) {}
        try { W.fetch = _f; } catch (e) {}
        try { box.parentNode.removeChild(box); } catch (e) {}
        try { se.parentNode.removeChild(se); } catch (e) {}
        try { delete W.__TM; } catch (e) {}
      }
    };

    ctx.log('[token-meter] v5 loaded, sessions=' + Object.keys(DB.sessions).length +
            ' peak=' + (isPeak(Date.now()) ? 'Y' : 'N'));
  },

  onUnload: function () {
    try { if (window.__TM && window.__TM.destroy) window.__TM.destroy(); } catch (e) {}
  }
};