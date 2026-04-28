// Just a snippet to see what we'll put in service-worker.js
async function registerDynamicScripts() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    if (scripts.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: "interceptor-main",
          matches: ["<all_urls>"],
          js: ["content/page-interceptor.js", "content/playback-capture.js"],
          runAt: "document_start",
          world: "MAIN",
          allFrames: true
        },
        {
          id: "interceptor-isolated",
          matches: ["<all_urls>"],
          js: ["content/bridge.js"],
          runAt: "document_start",
          world: "ISOLATED",
          allFrames: true
        }
      ]);
    }
  } catch (e) {
    console.error(e);
  }
}
