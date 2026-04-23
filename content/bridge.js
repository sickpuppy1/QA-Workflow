(function() {
  "use strict";

  if (window.__wfBridgeInstalled) return;
  window.__wfBridgeInstalled = true;

  console.log('[WF:bridge] Loaded in ISOLATED world (frame:', window.location.href, ')');

  window.addEventListener("message", (e) => {
    // Only accept messages from our page interceptor
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;

    try {
      if (e.data.type === "network_call") {
        console.log('[WF:bridge] forwarding network_call to SW from frame:', window.location.href);
        chrome.runtime.sendMessage({
          type: "RECORD_NETWORK_CALL_WITH_BODY",
          call: { ...e.data, tabUrl: window.location.href }
        }).catch((err) => {
          console.warn('[WF:bridge] RECORD_NETWORK_CALL_WITH_BODY failed to send:', err?.message);
        });
      } else if (e.data.type === "console_log") {
        chrome.runtime.sendMessage({
          type: "RECORD_CONSOLE_LOG",
          log: {
            message: e.data.message,
            level: e.data.level || "log",
            timestamp: e.data.timestamp,
            url: e.data.url || window.location.href
          }
        }).catch((err) => {
          console.warn('[WF:bridge] RECORD_CONSOLE_LOG failed to send:', err?.message);
        });
      }
    } catch (err) {}
  });
})();
