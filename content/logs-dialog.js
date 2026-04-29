/**
 * Content Script - Logs Dialog Overlay
 *
 * Injects resizable, draggable UI overlays for Console and Network logs.
 * They run independently and can be on-screen at the same time.
 *
 * Strategy:
 * - Console dialog: seeded and updated from the page's MAIN-world console buffer
 * - Network dialog: seeded and updated from the service worker's merged network cache
 * - Network rows show full request/response details in a collapsible panel on selection
 */

(function () {
  "use strict";

  if (window.__workflowLogsDialogLoaded) return;
  window.__workflowLogsDialogLoaded = true;

  const DEFAULT_NETWORK_MERGE_WINDOW_MS = 500;
  let networkMergeWindowMs = DEFAULT_NETWORK_MERGE_WINDOW_MS;

  function normalizeNetworkMergeWindowMs(value) {
    const parsed = Number.parseInt(String(value ?? DEFAULT_NETWORK_MERGE_WINDOW_MS), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_NETWORK_MERGE_WINDOW_MS;
    return Math.min(2000, Math.max(100, parsed));
  }

  async function hydrateNetworkMergeWindowMs() {
    try {
      const stored = await chrome.storage.local.get(["networkMergeWindowMs"]);
      networkMergeWindowMs = normalizeNetworkMergeWindowMs(stored.networkMergeWindowMs);
    } catch (_) {
      networkMergeWindowMs = DEFAULT_NETWORK_MERGE_WINDOW_MS;
    }
  }

  hydrateNetworkMergeWindowMs();

  const DIALOGS = {
    console: { id: "__wf_console_dialog__", title: "Console Logs", items: [], selected: null },
    network: { id: "__wf_network_dialog__", title: "Network Calls", items: [], selected: null }
  };

  function getItemKey(type, item) {
    if (type === "console") {
      return JSON.stringify([
        item.timestamp || 0,
        item.level || "log",
        item.message || "",
        item.url || ""
      ]);
    }
    return JSON.stringify([
      item.timestamp || 0,
      item.method || "GET",
      item.url || "",
      item.status || 0
    ]);
  }

  function networkDetailScore(item) {
    if (!item) return 0;
    let score = 0;
    if (item.statusText) score += 1;
    if (item.requestBody != null) score += 2;
    if (item.responseBody != null) score += 2;
    if (item.requestHeaders && Object.keys(item.requestHeaders).length > 0) score += 2;
    if (item.responseHeaders && Object.keys(item.responseHeaders).length > 0) score += 2;
    return score;
  }

  function canMergeNetworkItems(a, b, windowMs = networkMergeWindowMs) {
    if (!a || !b) return false;
    if ((a.url || null) !== (b.url || null)) return false;
    if ((a.method || "GET") !== (b.method || "GET")) return false;
    if (a.status != null && b.status != null && a.status !== b.status) return false;
    const ta = typeof a.timestamp === "number" ? a.timestamp : null;
    const tb = typeof b.timestamp === "number" ? b.timestamp : null;
    if (ta != null && tb != null && Math.abs(ta - tb) > windowMs) return false;
    return true;
  }

  function mergeNetworkItems(existing, incoming) {
    const timestamps = [existing?.timestamp, incoming?.timestamp].filter((value) => typeof value === "number");
    return {
      ...existing,
      ...incoming,
      status: incoming?.status ?? existing?.status ?? null,
      statusText: incoming?.statusText ?? existing?.statusText ?? null,
      requestHeaders: (incoming?.requestHeaders && Object.keys(incoming.requestHeaders).length > 0)
        ? incoming.requestHeaders
        : existing?.requestHeaders ?? {},
      requestBody: incoming?.requestBody ?? existing?.requestBody ?? null,
      responseHeaders: (incoming?.responseHeaders && Object.keys(incoming.responseHeaders).length > 0)
        ? incoming.responseHeaders
        : existing?.responseHeaders ?? {},
      responseBody: incoming?.responseBody ?? existing?.responseBody ?? null,
      timestamp: timestamps.length > 0 ? Math.min(...timestamps) : incoming?.timestamp ?? existing?.timestamp ?? null,
    };
  }

  function replaceItems(type, items) {
    DIALOGS[type].items = [];
    (items || []).forEach((item) => upsertItem(type, item));
  }

  function upsertItem(type, item) {
    if (type === "network") {
      let bestIndex = -1;
      let bestScore = -1;
      for (let i = DIALOGS.network.items.length - 1; i >= 0; i--) {
        if (!canMergeNetworkItems(DIALOGS.network.items[i], item)) continue;
        const score = networkDetailScore(DIALOGS.network.items[i]);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex >= 0) {
        const previous = DIALOGS.network.items[bestIndex];
        const nextItem = mergeNetworkItems(previous, item);
        DIALOGS.network.items[bestIndex] = nextItem;
        if (DIALOGS.network.selected && canMergeNetworkItems(DIALOGS.network.selected, item)) {
          DIALOGS.network.selected = nextItem;
        }
        return;
      }
    }

    const key = getItemKey(type, item);
    const idx = DIALOGS[type].items.findIndex((existing) => getItemKey(type, existing) === key);
    if (idx >= 0) {
      const nextItem = { ...DIALOGS[type].items[idx], ...item };
      DIALOGS[type].items[idx] = nextItem;
      if (DIALOGS[type].selected && getItemKey(type, DIALOGS[type].selected) === key) {
        DIALOGS[type].selected = nextItem;
      }
    } else {
      DIALOGS[type].items.push(item);
    }
    if (DIALOGS[type].items.length > 200) DIALOGS[type].items.shift();
  }

  function createCheckpointId() {
    try {
      return crypto.randomUUID();
    } catch (_) {
      return `checkpoint-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  function requestConsoleSnapshot(timeoutMs = 400) {
    const requestId = createCheckpointId();

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("Snapshot timed out"));
      }, timeoutMs);

      function onMessage(event) {
        // M3: Only accept same-origin messages from the MAIN-world interceptor.
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.__wfSrc !== "__wf_interceptor__") return;
        if (event.data.type !== "console_snapshot" || event.data.requestId !== requestId) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(Array.isArray(event.data.items) ? event.data.items : []);
      }

      window.addEventListener("message", onMessage);
      // M3: Target same origin instead of "*".
      window.postMessage({ __wfSrc: "__wf_dialog__", type: "snapshot_console", requestId }, window.location.origin || "*");
    });
  }

  function truncateValue(value, maxLen = 2000) {
    if (typeof value !== "string") return value ?? null;
    return value.length > maxLen ? value.slice(0, maxLen) : value;
  }

  function sanitizeHeaders(headers, maxKeys = 24, maxValueLen = 160) {
    const obj = headers && typeof headers === "object" ? headers : {};
    return Object.fromEntries(
      Object.entries(obj)
        .slice(0, maxKeys)
        .map(([key, value]) => [key, truncateValue(typeof value === "string" ? value : String(value), maxValueLen)])
    );
  }

  function sanitizeCheckpointIntent(event) {
    if (!event) return event;
    if (event.type === "console_checkpoint") {
      return {
        ...event,
        logMessage: truncateValue(event.logMessage, 1000),
        logContextBefore: Array.isArray(event.logContextBefore)
          ? event.logContextBefore.slice(-1).map((item) => ({
              ...item,
              message: truncateValue(item?.message, 1000),
            }))
          : [],
        logContextAfter: Array.isArray(event.logContextAfter)
          ? event.logContextAfter.slice(0, 1).map((item) => ({
              ...item,
              message: truncateValue(item?.message, 1000),
            }))
          : [],
      };
    }

    if (event.type === "network_checkpoint") {
      return {
        type: event.type,
        checkpointId: event.checkpointId,
        label: truncateValue(event.label, 200),
        networkUrl: truncateValue(event.networkUrl, 1000),
        networkMethod: event.networkMethod || "GET",
        networkStatus: event.networkStatus ?? null,
        networkStatusText: truncateValue(event.networkStatusText, 120),
        networkRequestBody: truncateValue(event.networkRequestBody, 2000),
        networkResponseBody: truncateValue(event.networkResponseBody, 2000),
        networkRequestHeaders: sanitizeHeaders(event.networkRequestHeaders),
        networkResponseHeaders: sanitizeHeaders(event.networkResponseHeaders),
        url: truncateValue(event.url, 1000),
        timestamp: event.timestamp ?? Date.now(),
      };
    }

    return event;
  }

  async function bufferCheckpointIntent(event) {
    const stored = await chrome.storage.local.get([
      "wfMode",
      "wfRecordingSessionId",
      "wfCheckpointIntents",
    ]);

    if (!stored.wfRecordingSessionId) {
      console.warn('[WF:buffer] REJECTED: no wfRecordingSessionId (wfMode=', stored.wfMode, ')');
      throw new Error("No active recording session");
    }

    const existingIntents = Array.isArray(stored.wfCheckpointIntents) ? stored.wfCheckpointIntents : [];
    const nextIntents = existingIntents
      .filter((entry) => entry?.event?.checkpointId !== event.checkpointId)
      .slice(-199);

    nextIntents.push({
      sessionId: stored.wfRecordingSessionId,
      event: sanitizeCheckpointIntent(event),
    });

    await chrome.storage.local.set({ wfCheckpointIntents: nextIntents });
  }

  function hasNetworkDetailData(item) {
    if (!item) return false;
    return Boolean(
      item.statusText ||
      (item.requestHeaders && Object.keys(item.requestHeaders).length > 0) ||
      (item.responseHeaders && Object.keys(item.responseHeaders).length > 0) ||
      item.requestBody != null ||
      item.responseBody != null
    );
  }

  async function settleSelectedNetworkItem(selected, timeoutMs = 2000) {
    const key = getItemKey("network", selected);
    let current = DIALOGS.network.items.find((item) => getItemKey("network", item) === key) || selected;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (hasNetworkDetailData(current)) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
      // Re-check local list (updated by live NETWORK_CALL_LIVE messages)
      current = DIALOGS.network.items.find((item) => getItemKey("network", item) === key) || current;
    }

    // If still no detail data, re-fetch the full list from the service worker.
    // The SW's in-memory state is always more up-to-date than the dialog's local
    // list because it processes RECORD_NETWORK_CALL_WITH_BODY directly and may
    // have the body backfill before the NETWORK_CALL_LIVE message even arrives.
    if (!hasNetworkDetailData(current)) {
      try {
        const res = await chrome.runtime.sendMessage({ type: "GET_NETWORK_CALLS" });
        const swCalls = res?.calls || [];
        // Find ALL matching entries from the SW by comparing URL + method
        // Then pick the one with the most detail data (highest networkDetailScore)
        const matches = swCalls.filter((call) =>
          (call.url || "") === (current.url || "") &&
          (call.method || "GET") === (current.method || "GET")
        );
        // Sort by detail score descending to get the richest entry
        const freshMatch = matches.sort((a, b) => networkDetailScore(b) - networkDetailScore(a))[0];
        if (freshMatch && hasNetworkDetailData(freshMatch)) {
          // Merge: prefer SW data (more complete) over local skeleton
          current = { ...current, ...freshMatch };
          // Update local list too so the dialog shows the enriched data
          const idx = DIALOGS.network.items.findIndex((item) => getItemKey("network", item) === key);
          if (idx >= 0) DIALOGS.network.items[idx] = { ...DIALOGS.network.items[idx], ...freshMatch };
        }
      } catch (_) {}
    }

    if (DIALOGS.network.selected && getItemKey("network", DIALOGS.network.selected) === key) {
      DIALOGS.network.selected = current;
    }

    return current;
  }

  // ─── Dialog Factory ───────────────────────────────────────────────────────

  function createDialog(type) {
    const config = DIALOGS[type];
    if (document.getElementById(config.id)) return document.getElementById(config.id);

    const dialog = document.createElement("div");
    dialog.id = config.id;
    const topPx   = type === "console" ? 50  : 110;
    const rightPx = type === "console" ? 50  : 80;

    dialog.style.cssText = `
      position: fixed;
      top: ${topPx}px;
      right: ${rightPx}px;
      width: 480px;
      height: 560px;
      min-width: 320px;
      min-height: 260px;
      background: #0f1117;
      color: #f0f0f5;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      resize: both;
      transition: opacity 0.2s ease;
    `;
    dialog.style.display = "none";

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 10px 14px;
      background: #1a1d27;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: grab;
      user-select: none;
      gap: 8px;
    `;

    const title = document.createElement("div");
    title.style.cssText = "font-weight: 600; font-size: 13px; color: #e5e7eb; flex: 1;";
    title.textContent = config.title;

    const countBadge = document.createElement("span");
    countBadge.id = config.id + "_count";
    countBadge.style.cssText = "font-size: 10px; background: rgba(255,255,255,0.08); color: #8b8fa8; padding: 2px 8px; border-radius: 12px;";
    countBadge.textContent = "0";

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.style.cssText = `
      background: transparent; border: 1px solid rgba(255,255,255,0.1); color: #8b8fa8;
      font-size: 11px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
    `;
    clearBtn.onclick = () => {
      DIALOGS[type].items = [];
      DIALOGS[type].selected = null;
      // Clear the MAIN world in-page buffer via postMessage (isolated world cannot
      // directly assign to MAIN world variables — postMessage crosses the boundary).
      const clearType = type === "console" ? "clear_console" : "clear_network";
      // M3: Target same origin instead of "*" to prevent cross-origin pages from
      // intercepting the clear command intended for the MAIN-world interceptor.
      window.postMessage({ __wfSrc: "__wf_dialog__", type: clearType }, window.location.origin || "*");
      try {
        const action = type === "console" ? "CLEAR_CONSOLE_LOGS" : "CLEAR_NETWORK_CALLS";
        chrome.runtime.sendMessage({ type: action }).catch(() => {});
      } catch (_) {}
      renderList(type);
    };

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText = `
      background: transparent; border: none; color: #8b8fa8;
      font-size: 24px; cursor: pointer; line-height: 1; padding: 0 4px;
    `;
    closeBtn.onclick = () => {
      dialog.style.display = "none";
      const action = type === "console" ? "CLOSE_CONSOLE_DIALOG" : "CLOSE_NETWORK_DIALOG";
      try { chrome.runtime.sendMessage({ type: action }).catch(() => {}); } catch (err) {}
    };

    header.appendChild(title);
    header.appendChild(countBadge);
    header.appendChild(clearBtn);
    header.appendChild(closeBtn);

    // ── Drag (pointer-capture approach) ─────────────────────────────────────
    // We use setPointerCapture so that pointermove fires on the drag-handle
    // element itself rather than on document. This sidesteps the recorder's
    // capture-phase mousemove listener that would otherwise steal events.
    function attachDragHandlers(handle) {
      handle.addEventListener("pointerdown", (e) => {
        if (handle === header && (e.target === clearBtn || e.target === closeBtn)) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        dialog.style.zIndex = "2147483648";
        const other = document.getElementById(DIALOGS[type === "console" ? "network" : "console"].id);
        if (other) other.style.zIndex = "2147483647";
        handle.style.cursor = "grabbing";

        // Convert current CSS position to left/top so math is consistent.
        const rect = dialog.getBoundingClientRect();
        let anchorLeft = rect.left;
        let anchorTop  = rect.top;
        const startX = e.clientX;
        const startY = e.clientY;
        // Clear right/bottom so only left/top drive position
        dialog.style.right  = "auto";
        dialog.style.bottom = "auto";
        dialog.style.left   = `${anchorLeft}px`;
        dialog.style.top    = `${anchorTop}px`;

        function onMove(ev) {
          let newLeft = anchorLeft + (ev.clientX - startX);
          let newTop  = anchorTop  + (ev.clientY - startY);
          // Clamp: keep header (≈44px) at least 30px inside the viewport on all edges.
          const EDGE = 30;
          const headerH = header.offsetHeight || 44;
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const dw = dialog.offsetWidth;
          newTop  = Math.max(-(headerH - EDGE), newTop);   // cannot go above so only EDGE px of header is hidden
          newTop  = Math.min(vh - EDGE, newTop);            // cannot go below viewport bottom
          newLeft = Math.max(-(dw - EDGE), newLeft);        // cannot go past left edge
          newLeft = Math.min(vw - EDGE, newLeft);           // cannot go past right edge
          dialog.style.left = `${newLeft}px`;
          dialog.style.top  = `${newTop}px`;
        }

        function onUp() {
          handle.style.cursor = "grab";
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup",   onUp);
          handle.removeEventListener("pointercancel", onUp);
        }

        handle.addEventListener("pointermove",   onMove);
        handle.addEventListener("pointerup",     onUp);
        handle.addEventListener("pointercancel", onUp);
      });
    }

    // ── Body — list + detail pane ────────────────────────────────────────────
    const body = document.createElement("div");
    body.style.cssText = "flex: 1; display: flex; flex-direction: column; overflow: hidden;";

    const listContainer = document.createElement("div");
    listContainer.className = "__wf_logs_list__";
    listContainer.style.cssText = "flex: 1; overflow-y: auto; display: flex; flex-direction: column;";

    // Detail panel (hidden by default, shown on network row selection)
    const detailPanel = document.createElement("div");
    detailPanel.id = config.id + "_detail";
    detailPanel.style.cssText = `
      display: none;
      max-height: 200px;
      overflow-y: auto;
      border-top: 1px solid #374151;
      background: #0d1117;
      font-family: monospace;
      font-size: 11px;
      color: #c9d1d9;
      padding: 10px 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    `;

    body.appendChild(listContainer);
    body.appendChild(detailPanel);

    // ── Bottom drag strip (fallback when header is off-screen) ───────────────
    const dragStrip = document.createElement("div");
    dragStrip.title = "Drag to move";
    dragStrip.style.cssText = `
      height: 14px;
      background: #1a1d27;
      border-top: 1px solid rgba(255,255,255,0.07);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      user-select: none;
      flex-shrink: 0;
    `;
    dragStrip.innerHTML = `<span style="color:#4b5563;font-size:10px;letter-spacing:3px;">&#8943;</span>`;

    // Wire up pointer-capture drag on both the header and the bottom strip
    attachDragHandlers(header);
    attachDragHandlers(dragStrip);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 10px 14px;
      border-top: 1px solid #374151;
      background: #1f2937;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;

    const inputWrap = document.createElement("div");
    inputWrap.style.cssText = "display: flex; gap: 8px;";

    const labelInput = document.createElement("input");
    labelInput.className = "__wf_logs_label_input__";
    labelInput.type = "text";
    labelInput.placeholder = "Checkpoint label (optional)";
    labelInput.style.cssText = `
      flex: 1; background: #242736; border: 1px solid rgba(255,255,255,0.1);
      color: #f0f0f5; border-radius: 6px; padding: 8px 12px; font-size: 12px; outline: none;
    `;

    const addBtn = document.createElement("button");
    addBtn.className = "__wf_logs_add_btn__";
    addBtn.textContent = "Add Checkpoint";
    addBtn.disabled = true;
    addBtn.style.cssText = `
      background: #6366f1; color: #fff; border: none; border-radius: 6px;
      padding: 8px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
      opacity: 0.5; transition: background 0.15s, opacity 0.15s; white-space: nowrap;
    `;
    addBtn.onclick = () => handleAddCheckpoint(type);

    inputWrap.appendChild(labelInput);
    inputWrap.appendChild(addBtn);
    footer.appendChild(inputWrap);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(dragStrip);
    dialog.appendChild(footer);
    document.body.appendChild(dialog);
    return dialog;
  }

  // ─── Detail panel rendering ───────────────────────────────────────────────

  function formatDetail(item) {
    const lines = [];
    lines.push(`URL:     ${item.url || ""}`);
    lines.push(`Method:  ${item.method || "GET"}`);
    lines.push(`Status:  ${item.status || 0} ${item.statusText || ""}`);

    if (item.requestHeaders && Object.keys(item.requestHeaders).length) {
      lines.push("\n── Request Headers ──────────────────");
      Object.entries(item.requestHeaders).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
    }
    if (item.requestBody) {
      lines.push("\n── Request Body ─────────────────────");
      let body = item.requestBody;
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
      lines.push(body.length > 2000 ? body.slice(0, 2000) + "\n…(truncated)" : body);
    }
    if (item.responseHeaders && Object.keys(item.responseHeaders).length) {
      lines.push("\n── Response Headers ─────────────────");
      Object.entries(item.responseHeaders).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
    }
    if (item.responseBody != null) {
      lines.push("\n── Response Body ────────────────────");
      let body = item.responseBody;
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch (_) {}
      lines.push(body.length > 3000 ? body.slice(0, 3000) + "\n…(truncated)" : body);
    }
    return lines.join("\n");
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function renderList(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (!dialog) return;

    const list = dialog.querySelector(".__wf_logs_list__");
    if (!list) return;

    // Update count badge
    const badge = document.getElementById(DIALOGS[type].id + "_count");
    if (badge) badge.textContent = String(DIALOGS[type].items.length);

    list.innerHTML = "";

    const items    = DIALOGS[type].items;
    const selectedKey = DIALOGS[type].selected ? getItemKey(type, DIALOGS[type].selected) : null;
    const selected = selectedKey
      ? items.find((item) => getItemKey(type, item) === selectedKey) || DIALOGS[type].selected
      : null;
    DIALOGS[type].selected = selected;
    const detailEl = document.getElementById(DIALOGS[type].id + "_detail");

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = type === "console" ? "No console logs captured." : "No network calls captured.";
      empty.style.cssText = "padding: 20px; text-align: center; color: #9ca3af; font-size: 13px; font-style: italic;";
      list.appendChild(empty);
      if (detailEl) detailEl.style.display = "none";
      updateFooterState(type);
      return;
    }

    items.forEach((item) => {
      const isSelected = selectedKey ? selectedKey === getItemKey(type, item) : false;
      const row = document.createElement("div");
      row.style.cssText = `
        padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        font-size: 11px;
        cursor: pointer;
        display: flex;
        align-items: flex-start;
        gap: 7px;
        background: ${isSelected ? "rgba(99,102,241,0.15)" : "transparent"};
        border-left: ${isSelected ? "3px solid #6366f1" : "3px solid transparent"};
        transition: background 0.12s;
        word-break: break-all;
      `;
      row.ononmouseover = () => { if (!isSelected) row.style.background = "rgba(255,255,255,0.03)"; };
      row.onmouseout  = () => { if (!isSelected) row.style.background = "transparent"; };
      row.onclick = () => {
        DIALOGS[type].selected = item;
        renderList(type);
        // Show detail panel for network
        if (type === "network" && detailEl) {
          detailEl.textContent = formatDetail(item);
          detailEl.style.display = "block";
        }
      };

      const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      if (type === "console") {
        const levelColors = { warn: "#ef4345", error: "#ef4345", info: "#3b82f6", debug: "#8b8fa8" };
        const levelColor = levelColors[item.level] || "#f0f0f5";
        const badge = document.createElement("span");
        badge.textContent = (item.level || "log").toUpperCase().slice(0, 4);
        badge.style.cssText = `font-size: 9px; font-weight: 700; padding: 2px 4px; border-radius: 3px; background: #374151; color: ${levelColor}; flex-shrink: 0; margin-top: 1px;`;

        const msgStr = String(item.message || "");
        const msg = document.createElement("span");
        msg.textContent = msgStr.length > 120 ? msgStr.slice(0, 118) + "…" : msgStr;
        msg.style.cssText = `flex: 1; color: ${levelColor};`;

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0; margin-top: 1px;";

        row.appendChild(badge);
        row.appendChild(msg);
        row.appendChild(timeNode);
      } else {
        // Network row
        const methodStr = String(item.method || "GET");
        const methodColors = { GET: "#3b82f6", POST: "#22c55e", PUT: "#ef4345", PATCH: "#ef4345", DELETE: "#ef4345" };
        const methodColor = methodColors[methodStr] || "#8b8fa8";

        const method = document.createElement("span");
        method.textContent = methodStr;
        method.style.cssText = `font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 3px; background: ${methodColor}22; border: 1px solid ${methodColor}55; color: ${methodColor}; flex-shrink: 0; margin-top: 1px;`;

        const urlStr  = String(item.url || "");
        const urlInfo = document.createElement("span");
        // Show path part only for brevity
        let displayUrl = urlStr;
        try { displayUrl = new URL(urlStr).pathname + new URL(urlStr).search; } catch (_) {}
        urlInfo.textContent = displayUrl.length > 70 ? "…" + displayUrl.slice(-68) : displayUrl;
        urlInfo.title = urlStr;
        urlInfo.style.cssText = "flex: 1; color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";

        const statusColor = item.status >= 400 ? "#ef4444" : item.status >= 300 ? "#f59e0b" : item.status >= 200 ? "#10b981" : "#9ca3af";
        const status = document.createElement("span");
        status.textContent = item.status || "---";
        status.style.cssText = `font-size: 10px; font-weight: 700; color: ${statusColor}; flex-shrink: 0; min-width: 26px; text-align: right;`;

        const timeNode = document.createElement("span");
        timeNode.textContent = time;
        timeNode.style.cssText = "color: #6b7280; font-size: 10px; flex-shrink: 0;";

        row.appendChild(method);
        row.appendChild(urlInfo);
        row.appendChild(status);
        row.appendChild(timeNode);

        // Expand icon hint when selected
        if (isSelected) {
          const hint = document.createElement("span");
          hint.textContent = "▼";
          hint.style.cssText = "color: #60a5fa; font-size: 9px; flex-shrink: 0; margin-top: 2px;";
          row.appendChild(hint);
        }
      }

      list.appendChild(row);
    });

    if (type === "network" && detailEl) {
      if (selected) {
        detailEl.textContent = formatDetail(selected);
        detailEl.style.display = "block";
      } else {
        detailEl.style.display = "none";
      }
    }

    updateFooterState(type);
  }

  function updateFooterState(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (!dialog) return;
    const btn = dialog.querySelector(".__wf_logs_add_btn__");
    if (!btn) return;
    const has = !!DIALOGS[type].selected;
    btn.disabled = !has;
    btn.style.opacity = has ? "1" : "0.5";
    btn.style.cursor  = has ? "pointer" : "not-allowed";
  }

  // ─── Core Logic & Interactivity ───────────────────────────────────────────

  async function hydrateDialog(type) {
    try {
      if (type === "console") {
        const items = await requestConsoleSnapshot(800);
        replaceItems(type, items || []);
      } else {
        const res = await chrome.runtime.sendMessage({ type: "GET_NETWORK_CALLS" });
        replaceItems(type, res?.calls || []);
      }
    } catch (_) {
      replaceItems(type, []);
    }
  }

  async function showDialog(type) {
    const dialog = createDialog(type);
    dialog.style.display = "flex";
    dialog.style.zIndex  = "2147483648";
    const other = document.getElementById(DIALOGS[type === "console" ? "network" : "console"].id);
    if (other) other.style.zIndex = "2147483647";

    await hydrateDialog(type);
    renderList(type);

    // Auto-scroll to bottom
    setTimeout(() => {
      const list = dialog.querySelector(".__wf_logs_list__");
      if (list) list.scrollTop = list.scrollHeight;
    }, 20);
  }

  function hideDialog(type) {
    const dialog = document.getElementById(DIALOGS[type].id);
    if (dialog) dialog.style.display = "none";
  }

  async function handleAddCheckpoint(type) {
    const dialog   = document.getElementById(DIALOGS[type].id);
    const input    = dialog.querySelector(".__wf_logs_label_input__");
    const label    = input.value.trim() || null;
    const btn      = dialog.querySelector(".__wf_logs_add_btn__");
    const selected = DIALOGS[type].selected;

    btn.textContent = "Saving…";
    btn.disabled = true;

    try {
      let result;
      let buffered = false;
      let transportError = null;
      let bufferError = null;
      if (!selected) {
        throw new Error("Select an entry first");
      }

      if (type === "console" && selected) {
        const selectedIndex = DIALOGS.console.items.findIndex((item) => item === selected);
        const contextBefore = selectedIndex > 0 ? [DIALOGS.console.items[selectedIndex - 1]] : [];
        const contextAfter = selectedIndex >= 0 && selectedIndex < DIALOGS.console.items.length - 1
          ? [DIALOGS.console.items[selectedIndex + 1]]
          : [];
        const checkpointTimestamp = Date.now();
        const checkpointId = createCheckpointId();
        const autoLabel = label || `Console: ${(selected.message || "").slice(0, 40)}`;
        const bufferedEvent = {
          type: "console_checkpoint",
          checkpointId,
          label: autoLabel,
          logMessage: selected.message || "",
          logLevel: selected.level || "log",
          logTimestamp: selected.timestamp || checkpointTimestamp,
          logUrl: selected.url || window.location.href,
          logContextBefore: contextBefore,
          logContextAfter: contextAfter,
          url: window.location.href,
          timestamp: checkpointTimestamp,
        };
        try {
          await bufferCheckpointIntent(bufferedEvent);
          buffered = true;
        } catch (err) {
          bufferError = err;
        }
        try {
          result = await chrome.runtime.sendMessage({
            type: "ADD_CONSOLE_CHECKPOINT",
            logEntry: {
              message: selected.message,
              level: selected.level || "log",
              timestamp: selected.timestamp,
              url: selected.url || window.location.href,
            },
            contextBefore,
            contextAfter,
            label: autoLabel,
            checkpointId,
            checkpointTimestamp,
          });
        } catch (err) {
          transportError = err;
        }
      } else if (type === "network" && selected) {
        const settledSelected = await settleSelectedNetworkItem(selected);
        const checkpointTimestamp = Date.now();
        const checkpointId = createCheckpointId();
        const autoLabel = label || `Network: ${settledSelected.method || "GET"} ${(settledSelected.url || "").slice(0, 35)}`;

        const bufferedEvent = {
          type: "network_checkpoint",
          checkpointId,
          label: autoLabel,
          networkUrl: settledSelected.url || "",
          networkMethod: settledSelected.method || "GET",
          networkStatus: settledSelected.status ?? null,
          networkStatusText: settledSelected.statusText || null,
          networkRequestHeaders: settledSelected.requestHeaders || null,
          networkResponseHeaders: settledSelected.responseHeaders || null,
          networkRequestBody: settledSelected.requestBody || null,
          networkResponseBody: settledSelected.responseBody || null,
          url: window.location.href,
          timestamp: checkpointTimestamp,
        };
        try {
          await bufferCheckpointIntent(bufferedEvent);
          buffered = true;
        } catch (err) {
          bufferError = err;
        }

        try {
          result = await chrome.runtime.sendMessage({
            type: "ADD_NETWORK_CHECKPOINT",
            networkUrl: settledSelected.url,
            networkMethod: settledSelected.method,
            networkStatus: settledSelected.status,
            networkStatusText: settledSelected.statusText || null,
            networkRequestHeaders: settledSelected.requestHeaders || null,
            networkResponseHeaders: settledSelected.responseHeaders || null,
            networkRequestBody: settledSelected.requestBody || null,
            networkResponseBody: settledSelected.responseBody || null,
            label: autoLabel,
            checkpointId,
            checkpointTimestamp,
          });
        } catch (err) {
          transportError = err;
        }
      }

      if (result && result.error) {
        throw new Error(result.error);
      }

      if (bufferError && !result?.ok && !transportError) {
        throw bufferError;
      }

      if (transportError && !buffered) {
        throw transportError;
      }

      if (!buffered && !result?.ok) {
        throw new Error("Checkpoint was not saved");
      }


      input.value = "";
      DIALOGS[type].selected = null;
      const detailEl = document.getElementById(DIALOGS[type].id + "_detail");
      if (detailEl) detailEl.style.display = "none";

      btn.textContent = "Checkpoint Added!";
      btn.style.background = "#16a34a";
      setTimeout(() => {
        btn.textContent = "Add Checkpoint";
        btn.style.background = "";
        btn.disabled = true;
      }, 1500);
      return;
    } catch (err) {
      // Show error feedback on the button so the user knows the checkpoint was NOT saved.
      btn.textContent = "Failed — retry";
      btn.style.background = "#dc2626";
      setTimeout(() => {
        btn.textContent = "Add Checkpoint";
        btn.style.background = "";
        updateFooterState(type);
      }, 2000);
    }
  }

  // ─── Listeners ────────────────────────────────────────────────────────────

  // Service worker messages (dialog open/close sync, and legacy fallback)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === "SYNC_DIALOG_STATE") {
        if (msg.consoleOpen) showDialog("console"); else hideDialog("console");
        if (msg.networkOpen) showDialog("network"); else hideDialog("network");
        sendResponse({ ok: true });
      } else if (msg.type === "CLOSE_ALL_DIALOGS") {
        ["console", "network"].forEach(t => {
          document.getElementById(DIALOGS[t].id)?.remove();
          DIALOGS[t].items = [];
          DIALOGS[t].selected = null;
        });
        sendResponse({ ok: true });
      } else if (msg.type === "CLEAR_DIALOG_CONTENT") {
        ["console", "network"].forEach(t => {
          DIALOGS[t].items = [];
          DIALOGS[t].selected = null;
          renderList(t);
        });
        sendResponse({ ok: true });
      } else if (msg.type === "NETWORK_CALL_LIVE") {
        upsertItem("network", msg.call);
        const dialog = document.getElementById(DIALOGS.network.id);
        if (dialog && dialog.style.display === "flex") {
          renderList("network");
          const list = dialog.querySelector(".__wf_logs_list__");
          if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 60) {
            list.scrollTop = list.scrollHeight;
          }
        }
        sendResponse({ ok: true });
      } else if (msg.type === "CONSOLE_LOG_LIVE") {
        upsertItem("console", msg.log);
        const dialog = document.getElementById(DIALOGS.console.id);
        if (dialog && dialog.style.display === "flex") {
          renderList("console");
          const list = dialog.querySelector(".__wf_logs_list__");
          if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 60) {
            list.scrollTop = list.scrollHeight;
          }
        }
        sendResponse({ ok: true });
      }
    } catch (e) {}
    return false;
  });



  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "NETWORK_CALL_LIVE" || !msg.call) return false;

    const entry = {
      url:             msg.call.url,
      method:          msg.call.method,
      status:          msg.call.status,
      statusText:      msg.call.statusText || "",
      requestHeaders:  msg.call.requestHeaders || {},
      requestBody:     msg.call.requestBody || null,
      responseHeaders: msg.call.responseHeaders || {},
      responseBody:    msg.call.responseBody || null,
      timestamp:       msg.call.timestamp,
    };
    upsertItem("network", entry);

    const dialog = document.getElementById(DIALOGS.network.id);
    if (dialog && dialog.style.display === "flex") {
      renderList("network");
      const list = dialog.querySelector(".__wf_logs_list__");
      if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 60) {
        list.scrollTop = list.scrollHeight;
      }
    }
    return false;
  });

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.networkMergeWindowMs) return;
      networkMergeWindowMs = normalizeNetworkMergeWindowMs(changes.networkMergeWindowMs.newValue);
    });
  } catch (_) {}

})();
