(function() {
  "use strict";

  if (window.__wfBridgeInstalled) return;
  window.__wfBridgeInstalled = true;



  window.addEventListener("message", (e) => {
    // Only accept messages from our page interceptor
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;

    try {
      if (e.data.type === "network_call") {
        chrome.runtime.sendMessage({
          type: "RECORD_NETWORK_CALL_WITH_BODY",
          call: { ...e.data, tabUrl: window.location.href }
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
        });
      }
    } catch (err) {}
  });
})();
