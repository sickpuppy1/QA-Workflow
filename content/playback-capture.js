/**
 * Playback Capture — MAIN world
 *
 * Strategy:
 * Injected ONCE into the page's MAIN JavaScript context at the very start of
 * a playback session — BEFORE any workflow steps run. Accumulates every
 * console message and every network call into page-local ring-buffers so that
 * checkpoint verification steps can retroactively match events that fired
 * during earlier steps, not just future ones.
 *
 * Buffers:
 *   window.__wfPlayLogs[]  — console messages captured during this playback
 *   window.__wfPlayNet[]   — full network calls (url, method, headers, bodies)
 *
 * Events fired on window:
 *   CustomEvent("__wf_log_capture__")  — detail: { message, level, timestamp }
 *   CustomEvent("__wf_net_capture__")  — detail: the full network call object
 *
 * Guard: window.__wfPlayCaptureInstalled prevents double-injection on re-injection.
 */

(function () {
  "use strict";

  if (window.__wfPlayCaptureInstalled) return;
  window.__wfPlayCaptureInstalled = true;

  const MAX_LOGS = 200;
  const MAX_NET  = 200;
  const MAX_BODY = 64 * 1024; // 64 KB response body cap

  window.__wfPlayLogs = window.__wfPlayLogs || [];
  window.__wfPlayNet  = window.__wfPlayNet  || [];

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function pushLog(entry) {
    window.__wfPlayLogs.push(entry);
    if (window.__wfPlayLogs.length > MAX_LOGS) window.__wfPlayLogs.shift();
    window.dispatchEvent(new CustomEvent("__wf_log_capture__", { detail: entry }));
  }

  function pushNet(entry) {
    window.__wfPlayNet.push(entry);
    if (window.__wfPlayNet.length > MAX_NET) window.__wfPlayNet.shift();
    window.dispatchEvent(new CustomEvent("__wf_net_capture__", { detail: entry }));
  }

  function serializeBody(body) {
    if (!body) return null;
    try {
      if (typeof body === "string") return body.slice(0, MAX_BODY);
      if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_BODY);
      if (body instanceof FormData) {
        const obj = {};
        body.forEach((v, k) => { obj[k] = typeof v === "string" ? v : "<file>"; });
        return JSON.stringify(obj).slice(0, MAX_BODY);
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return "<binary>";
      return String(body).slice(0, MAX_BODY);
    } catch (_) { return null; }
  }

  function headersToObj(headers) {
    if (!headers) return {};
    const obj = {};
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach((v, k) => { obj[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => { obj[k] = v; });
      } else if (typeof headers === "object") {
        Object.assign(obj, headers);
      }
    } catch (_) {}
    return obj;
  }

  // ─── Console interception ────────────────────────────────────────────────────

  // Re-entrancy guard: prevents any console.* call made inside the capture
  // callback (e.g., during JSON serialization) from being re-captured, and
  // also prevents extension-injected MAIN world code from polluting page logs.
  let __wfCapturing = false;

  const LEVELS = ["log", "warn", "error", "info", "debug"];
  LEVELS.forEach(level => {
    const _orig = console[level];
    console[level] = function (...args) {
      _orig.apply(console, args);
      if (__wfCapturing) return;
      __wfCapturing = true;
      try {
        const message = args.map(a => {
          try { return typeof a === "string" ? a : JSON.stringify(a); } catch (_) { return String(a); }
        }).join(" ");
        pushLog({ message, level, timestamp: Date.now(), url: location.href });
      } finally {
        __wfCapturing = false;
      }
    };
  });

  // ─── fetch interception ──────────────────────────────────────────────────────

  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url    = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    const method = ((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
    const requestHeaders = headersToObj((init && init.headers) || (input instanceof Request ? input.headers : null));
    const requestBody    = serializeBody((init && init.body) || null);

    return _origFetch.apply(this, arguments).then((response) => {
      const resHeaders = headersToObj(response.headers);
      const resStatus = response.status;
      const resStatusText = response.statusText;

      const entry = {
        url,
        method,
        requestHeaders,
        requestBody,
        status: resStatus,
        statusText: resStatusText,
        responseHeaders: resHeaders,
        responseBody: null,
        timestamp: Date.now()
      };

      pushNet(entry);

      // SECURITY FIX: Do NOT use cloned.text() — it buffers the ENTIRE payload
      // into a UTF-16 string before slicing, causing OOM crashes on large files
      // (videos, PDFs, ISOs, etc.). Instead, use the ReadableStream API to read
      // only the first MAX_BODY bytes and immediately cancel the stream.
      try {
        const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
        const contentType   = (response.headers.get("content-type") || "").toLowerCase();
        // Skip body capture for clearly non-text or very large responses.
        const isBinaryType = /(image|audio|video|font|octet-stream|pdf|zip|gzip|protobuf)/.test(contentType);
        if (!isBinaryType && (contentLength === 0 || contentLength <= MAX_BODY * 4)) {
          const cloned = response.clone();
          const reader = cloned.body && cloned.body.getReader();
          if (reader) {
            const chunks = [];
            let totalBytes = 0;
            const pump = () => reader.read().then(({ done, value }) => {
              if (done || !value) {
                try {
                  const merged = new Uint8Array(totalBytes);
                  let offset = 0;
                  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
                  entry.responseBody = new TextDecoder("utf-8", { fatal: false }).decode(merged);
                } catch (_) {}
                return;
              }
              totalBytes += value.length;
              if (totalBytes <= MAX_BODY) {
                chunks.push(value);
                return pump();
              }
              // Collected enough — take only what we need and cancel.
              chunks.push(value.slice(0, MAX_BODY - (totalBytes - value.length)));
              reader.cancel().catch(() => {});
              try {
                const needed = MAX_BODY;
                const merged = new Uint8Array(needed);
                let offset = 0;
                for (const c of chunks) {
                  const take = Math.min(c.length, needed - offset);
                  merged.set(c.subarray(0, take), offset);
                  offset += take;
                  if (offset >= needed) break;
                }
                entry.responseBody = new TextDecoder("utf-8", { fatal: false }).decode(merged);
              } catch (_) {}
            }).catch(() => { reader.cancel().catch(() => {}); });
            pump();
          }
        }
      } catch (_) {}

      return response;
    }).catch((err) => {
      pushNet({ url, method, requestHeaders, requestBody, status: 0, statusText: "NetworkError", responseHeaders: {}, responseBody: null, timestamp: Date.now(), error: String(err) });
      throw err;
    });
  };

  // ─── XHR interception ───────────────────────────────────────────────────────

  const _origOpen        = XMLHttpRequest.prototype.open;
  const _origSend        = XMLHttpRequest.prototype.send;
  const _origSetHeader   = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wfMethod  = (method || "GET").toUpperCase();
    this.__wfUrl     = url || "";
    this.__wfReqHdrs = {};
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__wfReqHdrs) this.__wfReqHdrs[name] = value;
    return _origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const requestBody = serializeBody(body);
    this.addEventListener("loadend", () => {
      let responseBody = null;
      try {
        if (!this.responseType || this.responseType === "text" || this.responseType === "") {
          responseBody = (this.responseText || "").slice(0, MAX_BODY);
        } else if (this.responseType === "json" && this.response) {
          responseBody = JSON.stringify(this.response).slice(0, MAX_BODY);
        }
      } catch (_) {}

      // Parse response headers string into an object
      const responseHeaders = {};
      try {
        (this.getAllResponseHeaders() || "").trim().split(/\r?\n/).forEach(line => {
          const idx = line.indexOf(":");
          if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        });
      } catch (_) {}

      pushNet({
        url: this.__wfUrl || "",
        method: this.__wfMethod || "GET",
        requestHeaders: this.__wfReqHdrs || {},
        requestBody,
        status: this.status,
        statusText: this.statusText,
        responseHeaders,
        responseBody,
        timestamp: Date.now(),
      });
    });
    return _origSend.apply(this, arguments);
  };
})();
