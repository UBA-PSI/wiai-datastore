// Runs inside every page of a wds-verify run, before any script of the app (context.addInitScript). Self-contained: it is
// serialised to a string, so it must not use anything from this module.
//
// It does two things, both only to observe:
//  1. Records every network call made through fetch, XMLHttpRequest, WebSocket, sendBeacon, EventSource and form submission, with
//     the caller classified as "library" (a frame of wds-<version>.js is on the stack) or "app". Calls reach the Node side at once
//     through window.__wdsLog (a Playwright binding), so they survive a navigation.
//  2. Wraps WDS.connect so that set/autosave/exportAll of the store, and add/set/autosave of its collections, are logged (record name, time, JSON text of the value). The
//     wrapper is a plain object that forwards every call to the real store (whatever methods the store has). The wrapped stores are kept
//     in window.__wdsStores, so the sandbox run can call the owner API that deletes its vault at the end, if the library has one.
export function instrument() {
  if (window.__wdsVerifyInstalled) return;
  window.__wdsVerifyInstalled = true;
  var log = function (rec) {
    try { rec.t = Date.now(); if (typeof window.__wdsLog === 'function') window.__wdsLog(rec); } catch (e) { /* observing must never break the page */ }
  };
  var LIB = /\/datastore\/client\/wds-[^/:?#]*\.js/;
  function __wdsw_caller() {
    try {
      var lines = String(new Error().stack).split('\n').slice(1);
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('__wdsw') >= 0) continue;
        return LIB.test(lines[i]) ? 'library' : 'app';
      }
    } catch (e) { /* no stack */ }
    return 'app';
  }
  function bodyText(b) {
    try {
      if (b === undefined || b === null) return '';
      if (typeof b === 'string') return b;
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
      if (typeof FormData !== 'undefined' && b instanceof FormData) { var o = []; b.forEach(function (v, k) { o.push(k + '=' + (typeof v === 'string' ? v : '[file ' + (v && v.name) + ']')); }); return o.join('&'); }
      if (b instanceof ArrayBuffer) b = new Uint8Array(b);
      if (ArrayBuffer.isView(b)) { var u = new Uint8Array(b.buffer, b.byteOffset, Math.min(b.byteLength, 1 << 20)), s = ''; for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; }
    } catch (e) { /* unreadable */ }
    return '';
  }
  function urlOf(u) { try { return typeof u === 'string' ? u : (u && u.href) || (u && u.url) || String(u); } catch (e) { return ''; } }
  function __wdsw_record(api, url, method, body) {
    var rec = { kind: 'net', api: api, url: urlOf(url), method: method || 'GET', from: __wdsw_caller(), body: '' };
    if (rec.from === 'app') {
      if (typeof Blob !== 'undefined' && body instanceof Blob) { body.text().then(function (t) { rec.body = t.slice(0, 1 << 20); log(rec); }, function () { log(rec); }); return; }
      rec.body = bodyText(body).slice(0, 1 << 20);
    }
    log(rec);
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function __wdsw_fetch(input, init) {
      try {
        var m = (init && init.method) || (input && input.method) || 'GET';
        var b = init && init.body !== undefined ? init.body : undefined;
        __wdsw_record('fetch', input, String(m).toUpperCase(), b);
      } catch (e) { /* observe only */ }
      return origFetch.apply(this, arguments);
    };
  }
  var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function __wdsw_open(method, url) { this.__wdsM = method; this.__wdsU = url; return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function __wdsw_send(body) { try { __wdsw_record('XMLHttpRequest', this.__wdsU, String(this.__wdsM || 'GET').toUpperCase(), body); } catch (e) { /* observe only */ } return xs.apply(this, arguments); };
  if (navigator.sendBeacon) {
    var ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function __wdsw_beacon(url, data) { try { __wdsw_record('sendBeacon', url, 'POST', data); } catch (e) { /* observe only */ } return ob(url, data); };
  }
  if (window.WebSocket) {
    var OWS = window.WebSocket;
    var WS = function __wdsw_ws(url, protocols) {
      try { __wdsw_record('WebSocket', url, 'GET', ''); } catch (e) { /* observe only */ }
      var ws = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
      var send = ws.send;
      ws.send = function __wdsw_wssend(d) { try { __wdsw_record('WebSocket.send', url, 'SEND', d); } catch (e) { /* observe only */ } return send.apply(ws, arguments); };
      return ws;
    };
    WS.prototype = OWS.prototype; WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
    window.WebSocket = WS;
  }
  if (window.EventSource) {
    var OES = window.EventSource;
    var ES = function __wdsw_es(url, o) { try { __wdsw_record('EventSource', url, 'GET', ''); } catch (e) { /* observe only */ } return new OES(url, o); };
    ES.prototype = OES.prototype;
    window.EventSource = ES;
  }
  document.addEventListener('submit', function (ev) {
    try {
      var f = ev.target, text = '';
      if (f && f.closest && f.closest('.wds-root')) return;   // the library's own dialog forms (unlock, create) never leave the page
      try { text = bodyText(new URLSearchParams(new FormData(f))); } catch (e) { /* no data */ }
      var rec = { kind: 'net', api: 'form', url: urlOf(f.action).split('#')[0], method: String(f.method || 'GET').toUpperCase(), from: 'app', body: text };
      log(rec);
    } catch (e) { /* observe only */ }
  }, true);

  // ---- the store ----
  function json(v) {
    try { if (v instanceof Blob || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return '[binary]'; var s = JSON.stringify(v); return s === undefined ? 'null' : s.slice(0, 1 << 20); } catch (e) { return ''; }
  }
  // The collections of the store: what the app hands to add/set/autosave is what it writes, so it is logged like store.set (op "cwrite";
  // the collections call the real store inside, not this wrapper). One wrapper per collection object.
  var colWraps = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function wrapCollection(orig) {
    if (!orig || typeof orig !== 'object') return orig;
    if (colWraps && colWraps.has(orig)) return colWraps.get(orig);
    var w = {};
    Reflect.ownKeys(orig).forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(orig, k);
      if (d && typeof d.value === 'function') {
        w[k] = function () {
          var a = Array.prototype.slice.call(arguments);
          var prefix = typeof orig.prefix === 'string' ? orig.prefix : '';
          if (k === 'add') log({ kind: 'store', op: 'cwrite', name: prefix + ((a[1] && a[1].id) || '(new)'), value: json(a[0]) });
          if (k === 'set' && typeof a[0] === 'string') log({ kind: 'store', op: 'cwrite', name: prefix + a[0], value: json(a[1]) });
          if (k === 'autosave' && typeof a[0] === 'string' && typeof a[1] === 'function') {
            var name = prefix + a[0], getter = a[1];
            a[1] = function () { var v = getter.apply(this, arguments); log({ kind: 'store', op: 'cwrite', name: name, value: json(v) }); return v; };
          }
          return d.value.apply(orig, a);
        };
      } else {
        Object.defineProperty(w, k, { enumerable: true, configurable: true, get: function () { return orig[k]; } });
      }
    });
    if (colWraps) colWraps.set(orig, w);
    return w;
  }
  function wrapStore(orig) {
    if (!orig || typeof orig !== 'object') return orig;
    var w = {};
    Reflect.ownKeys(orig).forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(orig, k);
      if (d && typeof d.value === 'function') {
        w[k] = function () {
          var a = Array.prototype.slice.call(arguments);
          if (k === 'set' && typeof a[0] === 'string') log({ kind: 'store', op: 'set', name: a[0], value: json(a[1]) });
          if (k === 'autosave' && typeof a[0] === 'string' && typeof a[1] === 'function') {
            var name = a[0], getter = a[1];
            a[1] = function () { var v = getter.apply(this, arguments); log({ kind: 'store', op: 'autosave', name: name, value: json(v) }); return v; };
          }
          if (k === 'collection') return wrapCollection(d.value.apply(orig, a));
          if (k === 'exportAll') {
            var s0 = Date.now(), done = function () { log({ kind: 'export', start: s0, end: Date.now() }); };
            var r = d.value.apply(orig, a);
            Promise.resolve(r).then(done, done);
            return r;
          }
          var res = d.value.apply(orig, a);
          // errors of the store's promises are noted (a quota error in the sandbox is not a finding); the app still gets the same rejection
          if (res && typeof res.then === 'function') {
            return res.then(function (v) { return v; }, function (e) { log({ kind: 'error', op: k, name: e && e.name, code: e && e.code, message: String((e && e.message) || e).slice(0, 200) }); throw e; });
          }
          return res;
        };
      } else {
        Object.defineProperty(w, k, { enumerable: true, configurable: true, get: function () { return orig[k]; } });
      }
    });
    return w;
  }
  function wrapWds(api) {
    if (!api || typeof api.connect !== 'function') return api;
    var w = {};
    Reflect.ownKeys(api).forEach(function (k) { Object.defineProperty(w, k, { enumerable: true, configurable: true, value: api[k], writable: true }); });
    w.connect = function () { var s = wrapStore(api.connect.apply(api, arguments)); (window.__wdsStores = window.__wdsStores || []).push(s); return s; };
    return w;
  }
  var current;
  try {
    Object.defineProperty(window, 'WDS', { configurable: true, enumerable: true, get: function () { return current; }, set: function (v) { current = wrapWds(v); } });
  } catch (e) { /* cannot observe the store; the network checks still work */ }
}
