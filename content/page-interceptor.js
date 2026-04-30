/**
 * Page Interceptor — MAIN world (Recording)
 *
 * Strategy:
 * Injected into the page's MAIN JavaScript context during recording via
 * `chrome.scripting.executeScript` with `world: "MAIN"`. Intercepts console
 * methods and network requests (fetch/XHR) which are invisible to ISOLATED-world
 * content scripts.
 *
 * Cross-world delivery:
 *   window.postMessage(...)     → received by recorder.js / logs-dialog.js across worlds
 *   CustomEvent (same window)  → received by playback-capture.js checkpoint watchers (MAIN world)
 *
 * Buffers maintained on the page:
 *   window.__wfConsoleLogs[]  — ring-buffer of console entries (max 200)
 *
 * Guard: window.__wfInterceptorsInstalled prevents double-patching on re-injection.
 */

(function () {
  "use strict";

  // Mark recording active immediately.
  window.__wfRecording = true;

  if (window.__wfInterceptorsInstalled) return;
  window.__wfInterceptorsInstalled = true;

  const MAX_LOGS = 200;
  const MAX_BODY = 64 * 1024; // 64 KB

  window.__wfConsoleLogs = window.__wfConsoleLogs || [];
  window.__wfConsoleGeneration = window.__wfConsoleGeneration || 0;

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function pushLog(entry, generation = window.__wfConsoleGeneration) {
    if (generation !== window.__wfConsoleGeneration) return;
    window.__wfConsoleLogs.push(entry);
    if (window.__wfConsoleLogs.length > MAX_LOGS) window.__wfConsoleLogs.shift();
    // M3: Use same-origin target instead of "*" to prevent eavesdropping.
    window.postMessage({ __wfSrc: "__wf_interceptor__", type: "console_log", ...entry }, window.location.origin || "*");
    // CustomEvent → stays in MAIN world (playback checkpoint watchers)
    window.dispatchEvent(new CustomEvent("__wf_console_log__", { detail: entry }));
  }

  function pushNet(entry) {

    // M3: Use same-origin target instead of "*" to prevent eavesdropping.
    window.postMessage({ __wfSrc: "__wf_interceptor__", type: "network_call", ...entry }, window.location.origin || "*");
    // CustomEvent → stays in MAIN world (playback checkpoint watchers)
    window.dispatchEvent(new CustomEvent("__wf_network_call__", { detail: entry }));
  }

  function publishUpdatedNet(entry) {
    pushNet({
      ...entry,
      timestamp: entry.timestamp,
    });
  }

  // ─── Clear commands from isolated world (logs-dialog.js clear button) ────────
  // The dialog runs in the ISOLATED world and cannot directly assign to MAIN world
  // variables, so it sends a postMessage that we receive here and act on.
  // M3: Validate sender origin — only accept messages posted by the same page
  // (isolated-world content scripts on the same frame share window.location.origin).
  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || e.data.__wfSrc !== "__wf_dialog__") return;
    if (e.data.type === "clear_console") {
      window.__wfConsoleGeneration += 1;
      window.__wfConsoleLogs = [];
    } else if (e.data.type === "snapshot_console") {
      window.postMessage({
        __wfSrc: "__wf_interceptor__",
        type: "console_snapshot",
        requestId: e.data.requestId,
        items: (window.__wfConsoleLogs || []).slice(),
        // M3: Target same origin instead of "*" to prevent cross-origin interception.
      }, window.location.origin || "*");
    }
  });

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
    } catch (_) { }
    return obj;
  }

  // ─── Console interception ────────────────────────────────────────────────────

  // Re-entrancy guard: prevents the extension's own capture/serialization code
  // from triggering another capture if it calls console.* internally.
  let __wfCapturing = false;

  // Prefix used by the extension's own internal debug logs (e.g. '[WF:buffer]').
  // We deliberately skip re-capturing these so they don't pollute the log panel
  // or cause re-entrancy cycles with logs-dialog.js console output.
  const WF_INTERNAL_PREFIX = "[WF:";

  const LEVELS = ["log", "warn", "error", "info", "debug"];
  LEVELS.forEach(level => {
    const _orig = console[level];
    console[level] = function (...args) {
      _orig.apply(console, args);
      if (__wfCapturing) return;
      __wfCapturing = true;
      try {
        const message = args.map(a => {
          try {
            if (typeof a === "string") return a;
            // Error instances: JSON.stringify produces "{}" — use message+stack instead
            if (a instanceof Error) return a.message ? a.message + (a.stack ? "\n" + a.stack : "") : String(a);
            return JSON.stringify(a);
          } catch (_) { return String(a); }
        }).join(" ");
        // Skip logs originating from the extension's own internal code so
        // they don't appear in the captured log panel or trigger re-entrancy.
        if (message.startsWith(WF_INTERNAL_PREFIX)) return;
        pushLog({ message, level, timestamp: Date.now(), url: location.href });
      } finally {
        __wfCapturing = false;
      }
    };
  });

  // ─── fetch interception ──────────────────────────────────────────────────────

  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    const method = ((init && init.method) || (input instanceof Request && input.method) || "GET").toUpperCase();
    const requestHeaders = headersToObj((init && init.headers) || (input instanceof Request ? input.headers : null));
    const requestBody = serializeBody((init && init.body) || null);
    return _origFetch.apply(this, arguments).then((response) => {

      const resHeaders = headersToObj(response.headers);
      const resStatus = response.status;
      const resStatusText = response.statusText;

      // Create a skeleton entry immediately so it's visible even if body parsing hangs
      const entry = {
        url,
        method,
        requestHeaders,
        requestBody,
        status: resStatus,
        statusText: resStatusText,
        responseHeaders: resHeaders,
        responseBody: null,
        timestamp: Date.now(),
      };

      // Push it to the UI immediately
      pushNet(entry);

      // Try to backfill the body asynchronously.
      // SECURITY FIX: Do NOT use cloned.text() — it buffers the ENTIRE payload
      // into a UTF-16 string before slicing, causing OOM crashes on large files
      // (videos, PDFs, ISOs, etc.). Instead, use the ReadableStream API to read
      // only the first MAX_BODY bytes and immediately cancel the stream.
      try {
        const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
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
                // Decode collected bytes and store
                try {
                  const merged = new Uint8Array(totalBytes);
                  let offset = 0;
                  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
                  entry.responseBody = new TextDecoder("utf-8", { fatal: false }).decode(merged);
                } catch (_) { }
                publishUpdatedNet(entry);
                return;
              }
              totalBytes += value.length;
              if (totalBytes <= MAX_BODY) {
                chunks.push(value);
                return pump();
              }
              // Collected enough — take only what we need and cancel.
              chunks.push(value.slice(0, MAX_BODY - (totalBytes - value.length)));
              reader.cancel().catch(() => { });
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
              } catch (_) { }
              publishUpdatedNet(entry);
            }).catch(() => { reader.cancel().catch(() => { }); });
            pump();
          } else {
            publishUpdatedNet(entry);
          }
        } else {
          publishUpdatedNet(entry);
        }
      } catch (_) { }

      return response;
    }).catch((err) => {
      pushNet({ url, method, requestHeaders, requestBody, status: 0, statusText: "NetworkError", responseHeaders: {}, responseBody: null, timestamp: Date.now() });
      throw err;
    });
  };

  // ─── XHR interception ───────────────────────────────────────────────────────

  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wfMethod = (method || "GET").toUpperCase();
    this.__wfUrl = String(url || "");
    this.__wfReqHdrs = {};
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Initialize headers map here too, in case open() was pre-injection
    if (!this.__wfReqHdrs) this.__wfReqHdrs = {};
    this.__wfReqHdrs[name] = value;
    return _origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // If open() ran before injection, __wfUrl will be missing.
    // Use responseURL as a post-hoc fallback (available in loadend).
    if (!this.__wfReqHdrs) this.__wfReqHdrs = {};
    const requestBody = serializeBody(body);
    const capturedMethod = this.__wfMethod || "GET";



    this.addEventListener("loadend", () => {
      // Post-hoc URL recovery: responseURL is available after the request completes.
      // If open() ran before injection, __wfUrl may be empty — use responseURL instead.
      const finalUrl = this.__wfUrl || this.responseURL || "";

      let responseBody = null;
      try {
        if (!this.responseType || this.responseType === "text" || this.responseType === "") {
          responseBody = (this.responseText || "").slice(0, MAX_BODY);
        } else if (this.responseType === "json" && this.response) {
          responseBody = JSON.stringify(this.response).slice(0, MAX_BODY);
        }
      } catch (_) { }

      const responseHeaders = {};
      try {
        (this.getAllResponseHeaders() || "").trim().split(/\r?\n/).forEach(line => {
          const idx = line.indexOf(":");
          if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        });
      } catch (_) { }



      pushNet({
        url: finalUrl,
        method: capturedMethod,
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
