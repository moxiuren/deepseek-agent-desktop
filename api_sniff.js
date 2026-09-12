// api_sniff.js — READ-ONLY network sniffer for mapping chat.deepseek.com private API.
// Injected at document-creation (before page scripts). Wraps fetch/XHR, never alters
// requests or responses. All records go to the native host log (local file only).
(function() {
    // Re-entry guard via the functional global (no extra marker global).
    if (window.__uploadState) return;
    try { if (window !== window.top) return; } catch (_) {}

    function toNative(payload) {
        try {
            if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
                window.chrome.webview.postMessage(payload);
            }
        } catch (_) {}
    }

    function shouldSkip(url) {
        try {
            var u = String(url);
            if (u.indexOf('/api') >= 0) return false;
            if (/^data:|^blob:/i.test(u)) return true;
            var path = u.split('?')[0].toLowerCase();
            return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)(\/|$)/.test(path);
        } catch (_) { return false; }
    }

    function summarizeBody(body, maxLen) {
        maxLen = maxLen || 3000;
        if (body === null || body === undefined) return { kind: 'empty' };
        try {
            if (typeof body === 'string') return { kind: 'string', len: body.length, preview: body.slice(0, maxLen) };
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                var keys = [];
                body.forEach(function(v, k) {
                    keys.push(k + ':' + ((typeof File !== 'undefined' && v instanceof File) ? ('File(' + v.name + ',' + v.size + ')') : typeof v));
                });
                return { kind: 'FormData', fields: keys };
            }
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                var s = body.toString();
                return { kind: 'urlencoded', len: s.length, preview: s.slice(0, maxLen) };
            }
            if (typeof Blob !== 'undefined' && body instanceof Blob) return { kind: 'Blob', type: body.type, size: body.size };
            if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return { kind: 'ArrayBuffer', bytes: body.byteLength };
            if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return { kind: 'TypedArray', cname: body.constructor.name, bytes: body.byteLength };
            if (typeof Request !== 'undefined' && body instanceof Request) return { kind: 'Request', url: body.url, method: body.method };
            return { kind: typeof body, cname: body && body.constructor && body.constructor.name };
        } catch (e) { return { kind: 'unreadable', error: String(e).slice(0, 120) }; }
    }

    function redactHeaders(h) {
        try {
            var out = {};
            var pairs = [];
            if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function(v, k) { pairs.push([k, v]); }); }
            else if (Array.isArray(h)) { pairs = h; }
            else if (h && typeof h === 'object') { for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) pairs.push([k, h[k]]); } }
            else { return {}; }
            pairs.forEach(function(p) {
                var k = String(p[0]); var v = String(p[1]);
                if (/auth|token|cookie|key|secret|session/i.test(k)) out[k] = '<present:' + v.length + 'chars>';
                else out[k] = v.length > 200 ? v.slice(0, 200) + '...' : v;
            });
            return out;
        } catch (e) { return { error: String(e).slice(0, 120) }; }
    }

    function emit(rec) {
        rec.action = 'apisniff';
        rec.t = Date.now();
        toNative(rec);
    }

    function hideGlobalSniff(name) {
        try { Object.defineProperty(window, name, { enumerable: false }); } catch (_) {}
    }

    // --- upload flight tracking (consumed by agent_bridge readiness check) ---
    // Counts in-flight POSTs to the file-upload endpoint so the bridge can tell
    // "upload finished" at the network layer instead of guessing DOM classes.
    window.__uploadState = { pending: 0, lastReqAt: 0, lastResAt: 0 };
    // Timestamp of the last chat-completion POST: the bridge uses it as
    // "previous send has left" to serialize feedback sends.
    window.__lastCompletionAt = 0;
    hideGlobalSniff('__uploadState');
    hideGlobalSniff('__lastCompletionAt');
    function isUploadUrl(u) {
        try { return /\/api\/v0\/file\/upload_file/.test(String(u || '')); } catch (_) { return false; }
    }
    function isCompletionUrl(u) {
        try { return /\/api\/v0\/chat\/completion/.test(String(u || '')); } catch (_) { return false; }
    }
    // First-chunk error signature: rejected sends stay HTTP 200, the refusal
    // only shows in the stream / bubble text.
    var LIMIT_RE = /too frequent|try again later|rate[\s_-]*limit|too many requests|发送频繁|操作频繁|稍后(再试|重试)|频繁操作/i;
    function flagRateLimit(url) {
        try {
            window.__lastSendRejectedAt = Date.now();
            hideGlobalSniff('__lastSendRejectedAt');
            emit({ side: 'limit-hit', url: String(url || '').slice(0, 300) });
        } catch (_) {}
    }
    function isPowUrl(u) {
        try { return /\/api\/v0\/chat\/create_pow_challenge/.test(String(u || '')); } catch (_) { return false; }
    }
    function isInterestingUrl(u) {
        try { return /\/api\/v0\/(chat\/completion|chat\/create_pow_challenge|file\/upload_file|file\/fetch_files)/.test(String(u || '')); } catch (_) { return false; }
    }
    function headerNamesOf(h) {
        var names = [];
        try {
            if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function(v, k) { names.push(k); }); }
            else if (Array.isArray(h)) { h.forEach(function(p) { names.push(String(p[0])); }); }
            else if (h && typeof h === 'object') { for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) names.push(k); } }
        } catch (_) {}
        return names;
    }
    function uploadReq(url) {
        if (!isUploadUrl(url)) return;
        try {
            window.__uploadState.pending++;
            window.__uploadState.lastReqAt = Date.now();
        } catch (_) {}
    }
    function uploadRes(url) {
        if (!isUploadUrl(url)) return;
        try {
            if (window.__uploadState.pending > 0) window.__uploadState.pending--;
            window.__uploadState.lastResAt = Date.now();
        } catch (_) {}
    }

    // --- stealth: Proxy wrappers pass BOTH `fn.toString()` and
    // `Function.prototype.toString.call(fn)` native-code checks, because the
    // proxy forwards toString to the untouched original target.
    function stealthWrap(fn, applyTrap) {
        try {
            return new Proxy(fn, {
                apply: function(t, th, args) { return applyTrap(t, th, args); }
            });
        } catch (_) {
            return fn;
        }
    }

    // --- fetch ---
    try {
        window.fetch = stealthWrap(window.fetch, function(t, th, args) {
            var input = args.length > 0 ? args[0] : undefined;
            var init = args.length > 1 ? args[1] : undefined;
            var url = '';
            var method = 'GET';
            var skipped = false;
            try {
                url = (typeof input === 'string') ? input : (input && input.url) || String(input);
                method = (((init && init.method) || (input && input.method)) || 'GET').toUpperCase();
                skipped = shouldSkip(url);
                if (isUploadUrl(url) && method === 'POST') uploadReq(url);
                if (isCompletionUrl(url) && method === 'POST') {
                    try { window.__lastCompletionAt = Date.now(); } catch (_) {}
                }
                if (!skipped) {
                    var body = (init && Object.prototype.hasOwnProperty.call(init, 'body')) ? init.body : undefined;
                    var rec = { side: 'fetch-req', method: method, url: String(url).slice(0, 500),
                           headers: redactHeaders((init && init.headers) || (input && input.headers)),
                           body: summarizeBody(body, isInterestingUrl(url) ? 12000 : 3000) };
                    if (isInterestingUrl(url)) {
                        rec.headerNames = headerNamesOf((init && init.headers) || (input && input.headers));
                    }
                    emit(rec);
                }
            } catch (_) {}
            return Reflect.apply(t, th, args).then(function(res) {
                uploadRes(res.url);
                if (isCompletionUrl(res.url)) {
                    try {
                        const c = res.clone();
                        if (c.body && c.body.getReader) {
                            const rdr = c.body.getReader();
                            rdr.read().then(function(r) {
                                try { rdr.cancel(); } catch (_) {}
                                try {
                                    const head = new TextDecoder().decode((r && r.value) || new Uint8Array()).slice(0, 800);
                                    if (LIMIT_RE.test(head)) flagRateLimit(res.url);
                                } catch (_) {}
                            }).catch(function() {});
                        }
                    } catch (_) {}
                }
                if (isPowUrl(res.url)) {
                    // Small JSON challenge — safe to buffer for backchannel design.
                    try {
                        res.clone().text().then(function(t) {
                            emit({ side: 'pow-res', url: String(res.url).slice(0, 300), status: res.status, resBody: String(t).slice(0, 2000) });
                        }).catch(function() {});
                    } catch (_) {}
                }
                if (!skipped) {
                    try {
                        var ct = '';
                        try { ct = res.headers.get('content-type') || ''; } catch (_) {}
                        emit({ side: 'fetch-res', url: String(res.url).slice(0, 500), status: res.status, contentType: ct });
                    } catch (_) {}
                }
                return res;
            }, function(err) {
                try { uploadRes(url); } catch (_) {}
                throw err;
            });
        });
    } catch (_) {}

    // --- XHR ---
    try {
        XMLHttpRequest.prototype.setRequestHeader = stealthWrap(XMLHttpRequest.prototype.setRequestHeader, function(t, th, args) {
            try { (th.__sniffHeaders = th.__sniffHeaders || []).push(String(args[0])); } catch (_) {}
            return Reflect.apply(t, th, args);
        });
        XMLHttpRequest.prototype.open = stealthWrap(XMLHttpRequest.prototype.open, function(t, th, args) {
            try { th.__sniffMethod = args[0]; th.__sniffUrl = args[1]; } catch (_) {}
            return Reflect.apply(t, th, args);
        });
        XMLHttpRequest.prototype.send = stealthWrap(XMLHttpRequest.prototype.send, function(t, th, args) {
            var body = args.length > 0 ? args[0] : undefined;
            var skipped = false;
            try {
                skipped = shouldSkip(th.__sniffUrl || '');
                if (String(th.__sniffMethod || '').toUpperCase() === 'POST') {
                    uploadReq(th.__sniffUrl || '');
                    if (isCompletionUrl(th.__sniffUrl || '')) {
                        try { window.__lastCompletionAt = Date.now(); } catch (_) {}
                    }
                }
                var self = th;
                var finish = function(emitRes) {
                    try { uploadRes(self.__sniffUrl || ''); } catch (_) {}
                    if (!emitRes) return;
                    try {
                        var rec = { side: 'xhr-res', url: String(self.__sniffUrl || '').slice(0, 500), status: self.status };
                        if (isPowUrl(self.__sniffUrl || '')) {
                            try { rec.resBody = String(self.responseText || '').slice(0, 2000); } catch (_) {}
                        }
                        emit(rec);
                    } catch (_) {}
                };
                if (!skipped) {
                    var reqRec = { side: 'xhr-req', method: String(th.__sniffMethod || ''), url: String(th.__sniffUrl || '').slice(0, 500), body: summarizeBody(body) };
                    if (isInterestingUrl(th.__sniffUrl || '')) {
                        reqRec.headerNames = th.__sniffHeaders || [];
                    }
                    emit(reqRec);
                    th.addEventListener('load', function() { finish(true); });
                    th.addEventListener('error', function() { finish(true); });
                    th.addEventListener('abort', function() { finish(true); });
                    if (isCompletionUrl(th.__sniffUrl || '')) {
                        th.addEventListener('progress', function() {
                            try {
                                if (th.__peekDone) return;
                                const t = String(th.responseText || '').slice(0, 800);
                                if (!t) return;
                                th.__peekDone = true;
                                if (LIMIT_RE.test(t)) flagRateLimit(th.__sniffUrl || '');
                            } catch (_) {}
                        });
                    }
                } else {
                    th.addEventListener('load', function() { finish(false); });
                    th.addEventListener('error', function() { finish(false); });
                    th.addEventListener('abort', function() { finish(false); });
                }
            } catch (_) {}
            return Reflect.apply(t, th, args);
        });
    } catch (_) {}
})();
