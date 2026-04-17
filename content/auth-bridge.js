/**
 * Auth Bridge — ISOLATED world content script
 *
 * Strategy:
 * Injected exclusively on the dashboard origin (manifest `matches` pattern).
 * Runs at document_start in the ISOLATED world so it is ready to receive
 * postMessage events as soon as any dashboard page finishes its login or
 * logout flow.
 *
 * Message protocol (dashboard page → this script → service worker):
 *   LOGIN  → window.postMessage({ __wfSrc: "__wf_dashboard_auth__", type: "AUTH_TOKEN",   token, userId, email })
 *   LOGOUT → window.postMessage({ __wfSrc: "__wf_dashboard_auth__", type: "CLEAR_TOKEN" })
 *
 * Security:
 *   - Origin is validated against the page's own location before acting.
 *   - The script is NOT in web_accessible_resources so it cannot be requested
 *     by external pages — it is only injected by the browser via the manifest.
 *   - Messages going back to the SW use chrome.runtime.sendMessage; there is
 *     no way for a page to forge those without extension-level permissions.
 */

(function () {
  'use strict';

  const EXPECTED_ORIGIN = window.location.origin;

  window.addEventListener('message', (event) => {
    // Only accept messages originating from the same page that loaded this
    // content script — prevents cross-origin relay attacks.
    if (event.origin !== EXPECTED_ORIGIN) return;

    const data = event.data;
    if (!data || data.__wfSrc !== '__wf_dashboard_auth__') return;

    if (data.type === 'AUTH_TOKEN') {
      // Dashboard just logged in: forward the JWT + user info to the SW.
      chrome.runtime.sendMessage({
        type: 'STORE_AUTH_TOKEN',
        token: data.token || null,
        userId: data.userId || null,
        email: data.email || null,
      }).catch(() => {});
    } else if (data.type === 'CLEAR_TOKEN') {
      // Dashboard just logged out: instruct the SW to clear the stored token.
      chrome.runtime.sendMessage({
        type: 'CLEAR_AUTH_TOKEN',
      }).catch(() => {});
    }
  });
})();
