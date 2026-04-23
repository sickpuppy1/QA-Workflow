/**
 * Content Script - Recorder
 *
 * This script is injected into web pages to listen for user interactions
 * and record them as discrete events. It communicates with the background
 * service worker to toggle recording state and send captured events.
 */

(function () {
  "use strict";

  // Prevent double-injection on same page load.
  // Re-initializes if the extension context was invalidated (e.g., after an update).
  let runtimeConnected = false;
  try {
    runtimeConnected = !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    // Context invalidated
  }
  if (window.__workflowRecorderLoaded && runtimeConnected) {
    // Already loaded in this page context. Re-sync recording state in case
    // recording was started AFTER this script was first injected (e.g., the
    // extension was reloaded or a new recording session started on an existing tab).
    try {
      chrome.storage.local.get("wfMode").then((data) => {
        if (data.wfMode === "recording") {
          // Retrieve the exposed API set up by our own first injection.
          if (window.__wfRecorder && typeof window.__wfRecorder.start === "function") {
            window.__wfRecorder.start();
          }
        }
      }).catch(() => {});
    } catch (_) {}
    return;
  }
  window.__workflowRecorderLoaded = true;

  let isRecording = false;

  /**
   * Generates a robust CSS selector for a given DOM element.
   *
   * Strategy:
   * 1. Prioritizes stable, framework-agnostic data attributes (data-testid, data-cy, etc.)
   *    which are highly resistant to structural or style changes.
   * 2. Falls back to the element ID if it exists and appears non-dynamic
   *    (rejects auto-generated IDs from frameworks like React/Ember).
   * 3. Checks AngularJS / legacy Angular directive attributes (ng-click, ng-model,
   *    accesskey, ui-sref, ng-href). These are expression strings baked into the DOM
   *    at template-compile time and remain stable across re-renders, making them far
   *    more reliable anchors than positional structural paths.
   * 4. For interactive elements (buttons, inputs), attempts to use accessibility
   *    or form attributes (aria-label, name) if they uniquely identify the element.
   * 5. As a last resort, delegates to `buildSelectorPath` for a structural hierarchy.
   *
   * @param {Element} element - The target DOM element.
   * @returns {string} - A unique CSS selector string.
   */
  function generateSelector(element) {
    if (!element || element === document.body) return "body";

    const testAttrs = ["data-testid", "data-cy", "data-qa", "data-id", "data-automation"];
    for (const attr of testAttrs) {
      const val = element.getAttribute(attr);
      if (val) return `[${attr}="${CSS.escape(val)}"]`;
    }

    if (element.id) {
      const id = element.id;
      if (!/^[\d]/.test(id) && !/^(ember|react-|__)\d/.test(id)) {
        const sel = `#${CSS.escape(id)}`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
    }

    // AngularJS (1.x) and legacy Angular directive attributes.
    // Checked before aria/name because these attrs are template-level constants —
    // they survive digest cycles and ng-repeat re-renders unchanged.
    // Both a bare [attr="val"] and a tag-scoped variant are tried so that
    // repeated directives (e.g. two ng-model="name" on different components)
    // still resolve to a unique selector.
    const ngAttrs = ["ng-click", "ng-model", "accesskey", "ui-sref", "ng-href"];
    for (const attr of ngAttrs) {
      const val = element.getAttribute(attr);
      if (!val) continue;
      const escaped = CSS.escape(val);
      const sel = `[${attr}="${escaped}"]`;
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      const tagSel = `${element.tagName.toLowerCase()}[${attr}="${escaped}"]`;
      try { if (document.querySelectorAll(tagSel).length === 1) return tagSel; } catch (_) {}
    }

    const interactiveTags = ["button", "a", "input", "select", "textarea"];
    if (interactiveTags.includes(element.tagName.toLowerCase())) {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) {
        const sel = `${element.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
      const name = element.getAttribute("name");
      if (name) {
        const sel = `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (_) {}
      }
    }

    return buildSelectorPath(element);
  }

  /**
   * Returns true if any ancestor of `el` (up to but not including body) carries
   * an AngularJS ng-repeat directive. Elements inside such containers have a DOM
   * position that is driven by data, not structure, so :nth-of-type qualifiers are
   * meaningless as stable playback anchors.
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function isDescendantOfNgRepeat(el) {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (
        cur.hasAttribute("ng-repeat") ||
        cur.hasAttribute("data-ng-repeat") ||
        cur.hasAttribute("x-ng-repeat")
      ) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /**
   * Builds a structural DOM path selector for an element.
   *
   * Strategy:
   * Traverses up the DOM tree from the target element to the body, recording the
   * tag name and up to two stable class names. Dynamic state classes (active, hover,
   * open, loading, ng-*, etc.) are filtered out to avoid selectors that break when
   * UI state changes between recording and playback.
   *
   * At each level the class-only path is tested first, without any :nth-of-type
   * qualifier. When multiple DOM elements still match, a :nth-of-type fallback is
   * attempted — but ONLY if the target element is not inside an AngularJS ng-repeat
   * block (checked once upfront). ng-repeat recreates list items in data order on
   * every digest; a positional index recorded at one moment will silently resolve to
   * the wrong item — or no item — after any state-driven re-render. When
   * :nth-of-type also fails to uniquify, traversal continues upward with the
   * non-positional part kept in the path so the playback engine can use recorded
   * x/y proximity to pick the right match from multiple candidates.
   *
   * @param {Element} element - The target DOM element.
   * @returns {string} - A structural CSS selector string.
   */
  function buildSelectorPath(element) {
    const parts = [];
    let current = element;

    // Pre-check once: if the target lives inside an ng-repeat container, every
    // element in the path inherits that volatility — skip :nth-of-type globally.
    const insideNgRepeat = isDescendantOfNgRepeat(element);

    while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList)
        .filter(c => c.length > 1 && !/^(active|hover|focus|disabled|selected|loading|open|closed|visible|hidden|expanded|collapsed|is-|has-|ng-|v-|js-)/.test(c))
        .slice(0, 2);
      if (classes.length) part += "." + classes.map(c => CSS.escape(c)).join(".");

      // Always try the class-only path first — without :nth-of-type.
      // This survives ng-repeat / v-for re-renders where list order may shift
      // between recording and playback; the playback engine resolves any
      // remaining ambiguity via recorded x/y proximity.
      parts.unshift(part);
      const candidate = parts.join(" > ");
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (_) {}

      // :nth-of-type fallback: skip entirely when inside an ng-repeat (checked
      // upfront) or when the current element itself is an ng-repeat root.
      // Both cases mean the positional index is data-driven and therefore volatile.
      const skipNth =
        insideNgRepeat ||
        current.hasAttribute("ng-repeat") ||
        current.hasAttribute("data-ng-repeat") ||
        current.hasAttribute("x-ng-repeat");
      if (!skipNth) {
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(s => s.tagName === current.tagName)
          : [];
        if (siblings.length > 1) {
          const nthPart = part + `:nth-of-type(${siblings.indexOf(current) + 1})`;
          parts[0] = nthPart;
          const nthCandidate = parts.join(" > ");
          try { if (document.querySelectorAll(nthCandidate).length === 1) return nthCandidate; } catch (_) {}
          parts[0] = part; // revert: keep non-positional part for continued upward traversal
        }
      }

      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  /**
   * Sends a recorded event to the background service worker.
   *
   * Strategy:
   * Acts as a gatekeeper that silently drops events if recording is currently toggled 
   * off. Valid events are routed through the standard Chrome extensions messaging API 
   * (`chrome.runtime.sendMessage`). Since the response is not critical to the 
   * recording flow, it catches and ignores any extension context errors (such as 
   * disconnects) to prevent console spam.
   *
   * @param {Object} eventObj - The recorded event data.
   */
  function sendEvent(eventObj) {
    if (!isRecording) return;
    try {
      chrome.runtime.sendMessage({ type: "RECORD_EVENT", event: eventObj }, () => {
        // Ignore response or connection errors
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {
      // Ignore extension context invalidated errors
    }
  }

  /**
   * DOM Event Handlers
   * Each handler captures relevant data for specific user actions
   * and formats them into standardized event objects.
   */

  /**
   * Handles click interactions on the page.
   *
   * Strategy:
   * Evaluates standard left-clicks while explicitly ignoring clicks on the extension's 
   * own recording UI indicator. It also intercepts and cancels clicks that were part 
   * of a long-press interaction to prevent duplicate event registration. Captures 
   * detailed coordinate data, element payload (text content, form state), and standardizes 
   * the event object before dispatching.
   *
   * @param {MouseEvent} e - The native mouse click event.
   */
  function onMouseClick(e) {
    if (e.target.closest?.("#__workflow_rec_indicator__") || e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    const el = e.target;
    sendEvent({
      type: "click",
      selector: generateSelector(el),
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      pageX: Math.round(e.pageX),
      pageY: Math.round(e.pageY),
      tagName: el.tagName.toLowerCase(),
      textContent: el.textContent?.trim().slice(0, 100) || "",
      inputType: el.getAttribute?.("type") || null,
      placeholder: el.getAttribute?.("placeholder") || null,
      label: el.getAttribute?.("aria-label") || el.getAttribute?.("title") || null,
      timestamp: Date.now(),
      url: location.href,
    });
  }

  let longPressTimer = null;
  let longPressFired = false;
  let startX = 0;
  let startY = 0;

  /**
   * Initiates tracking for potential long-press interactions.
   *
   * Strategy:
   * Filters for left-clicks (button 0) and records the initial X/Y coordinates. 
   * Starts a 600ms timer; if the timer concludes without being cleared by mouse 
   * movement or release, it characterizes the interaction as a 'long_press' and 
   * fires the event, flagging `longPressFired` to block the subsequent click event.
   *
   * @param {MouseEvent} e - The native mousedown event.
   */
  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    longPressFired = false;
    startX = e.clientX;
    startY = e.clientY;
    
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      const el = e.target;
      sendEvent({
        type: "long_press",
        selector: generateSelector(el),
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        pageX: Math.round(e.pageX),
        pageY: Math.round(e.pageY),
        tagName: el.tagName.toLowerCase(),
        timestamp: Date.now(),
        url: location.href,
      });
    }, 600);
  }

  /**
   * Evaluates pointer movement to invalidate long-press interactions.
   *
   * Strategy:
   * If a long-press tracking timer is active, measures the pixel delta between the 
   * cursor's current position and its starting position. If the user drags the mouse 
   * beyond a 5px threshold (indicating a drag/select rather than a hold), the timer 
   * is cleared to abort the long-press event.
   *
   * @param {MouseEvent} e - The native mousemove event.
   */
  function onMouseMove(e) {
    if (longPressTimer) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  }

  /**
   * Concludes long-press tracking.
   *
   * Strategy:
   * Clears any active long-press timer if the user releases the mouse button before 
   * the 600ms threshold is reached, effectively preventing the long-press event.
   *
   * @param {MouseEvent} e - The native mouseup event.
   */
  function onMouseUp(e) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  /**
   * Handles right-click / context menu interactions.
   *
   * Strategy:
   * Captures the specific element interacted with alongside the coordinates. 
   * Since native context menus do not yield a click event, this uniquely registers 
   * intent to access secondary actions (i.e. 'right_click').
   *
   * @param {MouseEvent} e - The native contextmenu event.
   */
  function onContextMenu(e) {
    if (e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    const el = e.target;
    sendEvent({
      type: "right_click",
      selector: generateSelector(el),
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      pageX: Math.round(e.pageX),
      pageY: Math.round(e.pageY),
      tagName: el.tagName.toLowerCase(),
      textContent: el.textContent?.trim().slice(0, 100) || "",
      timestamp: Date.now(),
      url: location.href,
    });
  }

  /**
   * Records native toggle interactions (like expanding `<details>` elements).
   *
   * Strategy:
   * Captures the resulting `isOpen` state of the element immediately after the toggle 
   * action fires, allowing the replay mechanism to definitively assert the element's 
   * visual state.
   *
   * @param {Event} e - The native toggle event.
   */
  function onToggle(e) {
    const el = e.target;
    sendEvent({
      type: "toggle",
      selector: generateSelector(el),
      isOpen: el.open !== undefined ? el.open : undefined,
      tagName: el.tagName.toLowerCase(),
      timestamp: Date.now(),
      url: location.href,
    });
  }

  let scrollTimer = null;
  /**
   * Records viewport and inner-element scroll interactions.
   *
   * Strategy:
   * Employs a 150ms debounce layer to prevent flooding the background script with 
   * hundreds of events during a single scroll motion. Once scrolling ceases, it 
   * determines if the scroll occurred on the main window or a nested scrollable 
   * container, capturing the final X/Y scroll coordinates.
   *
   * @param {Event} e - The native scroll event.
   */
  function onScroll(e) {
    if (e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const el = e.target;
      const isWin = el === document || el === document.documentElement || el === document.body;
      sendEvent({
        type: "scroll",
        selector: isWin ? null : generateSelector(el),
        scrollX: isWin ? window.scrollX : el.scrollLeft,
        scrollY: isWin ? window.scrollY : el.scrollTop,
        timestamp: Date.now(),
        url: location.href,
      });
    }, 150);
  }

  /**
   * Records critical keystrokes and shortcuts.
   *
   * Strategy:
   * Filters out standard typing character keys to avoid noise, as form input is 
   * handled separately via `onInput` / `onChange`. Solely captures structural navigation 
   * keys (Enter, Esc, Arrows, F1-F12) and key combos involving modifier keys 
   * (Ctrl, Meta, Alt, Shift), associating them with the currently focused element.
   *
   * @param {KeyboardEvent} e - The native keydown event.
   */
  function onKeyDown(e) {
    if (e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    const special = ["Enter","Escape","Tab","Backspace","Delete",
      "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
      "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"];
    if (!special.includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    sendEvent({
      type: "keydown",
      key: e.key, code: e.code, keyCode: e.keyCode,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey,
      selector: generateSelector(e.target),
      timestamp: Date.now(), url: location.href,
    });
  }

  const inputDebounce = new Map();
  /**
   * Tracks real-time value changes in text inputs and textareas.
   *
   * Strategy:
   * Ignores immediate input events for checkboxes and radio buttons (deferring to `onChange`).
   * Implements a 400ms debounce grouped specifically by the element's CSS selector, 
   * ensuring that rapid continuous typing only emits a single event with the final 
   * grouped value once the user pauses.
   *
   * @param {Event} e - The native input event.
   */
  function onInput(e) {
    if (e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    const el = e.target;
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) return;
    if (isSensitiveInput(el)) return;
    
    const key = generateSelector(el);
    clearTimeout(inputDebounce.get(key));
    
    inputDebounce.set(key, setTimeout(() => {
      sendEvent({
        type: "input", selector: key, value: el.value,
        tagName: el.tagName.toLowerCase(), inputType: el.getAttribute("type") || null,
        timestamp: Date.now(), url: location.href,
      });
      inputDebounce.delete(key);
    }, 400));
  }

  /**
   * Captures committed value updates and boolean component states.
   *
   * Strategy:
   * Ignores standard text inputs since they are more reliably captured by `onInput`. 
   * Specifically targets dropdowns (`<select>`), checkboxes, and radio buttons, 
   * properly extracting `.checked` boolean values for toggles vs `.value` for options, 
   * ensuring accurate replay state.
   *
   * @param {Event} e - The native change event.
   */
  function onChange(e) {
    if (e.target.closest?.("#__wf_console_dialog__") || e.target.closest?.("#__wf_network_dialog__")) return;
    const el = e.target;
    if (el.tagName === "INPUT" && el.type === "text") return;
    if (isSensitiveInput(el)) return;
    
    const isCheckOrRadio = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
    sendEvent({
      type: "change", selector: generateSelector(el),
      value: isCheckOrRadio ? el.checked : (el.value !== undefined ? el.value : el.checked),
      checked: isCheckOrRadio ? el.checked : undefined,
      tagName: el.tagName.toLowerCase(),
      inputType: el.getAttribute?.("type") || null,
      timestamp: Date.now(), url: location.href,
    });
  }

  function isSensitiveInput(el) {
    if (!el || typeof el !== "object") return false;

    const type = String(el.getAttribute?.("type") || "").toLowerCase();
    const autocomplete = String(el.getAttribute?.("autocomplete") || "").toLowerCase();
    if (
      type === "password" ||
      autocomplete === "current-password" ||
      autocomplete === "new-password" ||
      autocomplete === "one-time-code"
    ) {
      return true;
    }

    const textHints = [
      el.getAttribute?.("name"),
      el.getAttribute?.("id"),
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return /(pass(word)?|otp|one[- ]time|token|secret|api[-_ ]?key|session|cookie|cvv|cvc|ssn|social security)/i.test(textHints);
  }

  /**
   * Recording Lifecycle Management
   */

  /**
   * Activates global event interception.
   *
   * Strategy:
   * Sets the `isRecording` flag and binds capture-phase (`true`) event listeners 
   * to the root document. Capture-phase ensures events are recorded before page-level 
   * components can call `stopPropagation()`, guaranteeing visibility into all interactions.
   * Invokes the persistent UI overlay to alert the user.
   */
  function startListening() {
    if (isRecording) return;
    isRecording = true;
    document.addEventListener("click", onMouseClick, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    showRecordingIndicator();
  }

  /**
   * Deactivates event interception.
   *
   * Strategy:
   * Clears the `isRecording` flag and unbinds all exact match capture-phase listeners 
   * from the root document, safely returning the webpage to normal operational overhead. 
   * Removes the persistent UI overlay.
   */
  function stopListening() {
    if (!isRecording) return;
    isRecording = false;
    document.removeEventListener("click", onMouseClick, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("toggle", onToggle, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
    hideRecordingIndicator();
  }

  // Expose API for execution context injection (e.g. chrome.scripting.executeScript)
  window.__wfRecorder = { start: startListening, stop: stopListening };

  /**
   * UI Indicator
   */

  const INDICATOR_ID = "__workflow_rec_indicator__";

  // Inline SVG icons — stroke-based, 18×18 viewBox, no fill.
  const SVG = {
    screenshot: `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="6" width="13" height="10" rx="1.2"/><path d="M5.5 6l1-2h3l1 2"/><circle cx="8" cy="11.5" r="2.2"/></svg>`,
    network:    `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="9" cy="9" r="7"/><ellipse cx="9" cy="9" rx="3" ry="7"/><line x1="2" y1="9" x2="16" y2="9"/></svg>`,
    console:    `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6.5 7.5,9 3,11.5"/><line x1="9" y1="12" x2="15" y2="12"/></svg>`,
    save:       `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,9.5 7,13.5 15,4.5"/></svg>`,
    discard:    `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="4.5" y1="4.5" x2="13.5" y2="13.5"/><line x1="13.5" y1="4.5" x2="4.5" y2="13.5"/></svg>`,
    restart:    `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M5.5 9a3.5 3.5 0 1 0 .7-2.1"/><polyline points="3,5.5 6,6.8 5.5,10"/></svg>`,
  };

  /**
   * L3 — Custom dialog helpers
   *
   * Native confirm() and prompt() are silently suppressed in cross-origin iframes
   * on most modern sites, causing actions to fail invisibly. These lightweight
   * overlays match the extension's dark-glass aesthetic and are fully keyboard
   * accessible (Enter to confirm, Escape to cancel).
   */

  const WF_DIALOG_STYLE = `
    position:fixed;inset:0;z-index:2147483649;
    background:rgba(0,0,0,0.55);
    display:flex;align-items:center;justify-content:center;
  `;
  const WF_PANEL_STYLE = `
    background:linear-gradient(180deg,rgba(20,21,28,0.98),rgba(16,17,22,1));
    border:1.5px solid rgba(239,67,69,0.3);border-radius:12px;
    padding:20px 24px;max-width:320px;width:90vw;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    box-shadow:0 16px 48px rgba(0,0,0,0.6);
  `;
  const WF_MSG_STYLE   = "color:#e5e7eb;font-size:13px;margin:0 0 14px;line-height:1.5;";
  const WF_ROW_STYLE   = "display:flex;gap:8px;justify-content:flex-end;";
  const WF_CANCEL_STYLE = `
    padding:7px 16px;border-radius:6px;
    background:transparent;border:1px solid rgba(255,255,255,0.15);
    color:#9ca3af;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;
  `;
  const WF_OK_STYLE = `
    padding:7px 16px;border-radius:6px;
    background:rgba(239,67,69,0.85);border:none;
    color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;
  `;

  function wfConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = WF_DIALOG_STYLE;
      const panel = document.createElement("div");
      panel.style.cssText = WF_PANEL_STYLE;

      const msg = document.createElement("p");
      msg.style.cssText = WF_MSG_STYLE;
      msg.textContent = message;

      const row = document.createElement("div");
      row.style.cssText = WF_ROW_STYLE;

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = WF_CANCEL_STYLE;

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Confirm";
      confirmBtn.style.cssText = WF_OK_STYLE;

      const done = (result) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(result); };
      cancelBtn.onclick  = () => done(false);
      confirmBtn.onclick = () => done(true);
      const onKey = (e) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true); };
      document.addEventListener("keydown", onKey);

      row.appendChild(cancelBtn);
      row.appendChild(confirmBtn);
      panel.appendChild(msg);
      panel.appendChild(row);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      confirmBtn.focus();
    });
  }

  function wfPrompt(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = WF_DIALOG_STYLE;
      const panel = document.createElement("div");
      panel.style.cssText = WF_PANEL_STYLE;

      const msg = document.createElement("p");
      msg.style.cssText = WF_MSG_STYLE;
      msg.textContent = message;

      const inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.placeholder = "Label (optional)";
      inputEl.style.cssText = `
        width:100%;box-sizing:border-box;
        background:#1e2030;border:1px solid rgba(255,255,255,0.15);
        color:#f0f0f5;border-radius:6px;
        padding:8px 12px;font-size:12px;outline:none;
        font-family:inherit;margin-bottom:14px;
      `;

      const row = document.createElement("div");
      row.style.cssText = WF_ROW_STYLE;

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = WF_CANCEL_STYLE;

      const okBtn = document.createElement("button");
      okBtn.textContent = "OK";
      okBtn.style.cssText = WF_OK_STYLE;

      const done = (result) => { overlay.remove(); resolve(result); };
      cancelBtn.onclick = () => done(null);
      okBtn.onclick     = () => done(inputEl.value);
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter")  done(inputEl.value);
        if (e.key === "Escape") done(null);
      });

      row.appendChild(cancelBtn);
      row.appendChild(okBtn);
      panel.appendChild(msg);
      panel.appendChild(inputEl);
      panel.appendChild(row);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      setTimeout(() => inputEl.focus(), 30);
    });
  }

  /**
   * Renders the visual recording indicator HUD.
   *
   * Strategy:
   * Injects a draggable radial menu with a dark-glass aesthetic, SVG icons, and
   * a ripple-pulsing REC hub. No emojis. All buttons share a single uniform dark-glass
   * style with stroke-only SVG icons at 18×18.
   */
  function showRecordingIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;

    // ── Inject styles ────────────────────────────────────────────────────────
    {
      let s = document.getElementById("__wf_blink_style__");
      if (!s) {
        s = document.createElement("style");
        s.id = "__wf_blink_style__";
        document.head.appendChild(s);
      }
      s.textContent = `
        #__workflow_rec_indicator__{
          --wf-bg: #101116;
          --wf-bg2: #101116;
          --wf-bg3: #101116;
          --wf-border: rgba(239,67,69,0.18);
          --wf-border-strong: rgba(239,67,69,0.3);
          --wf-text: #ef4345;
          --wf-text-muted: rgba(239,67,69,0.78);
          --wf-accent: #ef4345;
          --wf-accent-hover: #ef4345;
          --wf-red: #ef4345;
          --wf-red-hover: #ef4345;
          --wf-green: #ef4345;
          --wf-yellow: #ef4345;
          --wf-cyan: #ef4345;
        }

        @keyframes __wf_ripple__{
          0%  { box-shadow: 0 0 0 0 rgba(239,67,69,0.28), 0 14px 36px rgba(16,17,22,0.34); }
          70% { box-shadow: 0 0 0 14px rgba(239,67,69,0), 0 14px 36px rgba(16,17,22,0.34); }
          100%{ box-shadow: 0 0 0 0 rgba(239,67,69,0), 0 14px 36px rgba(16,17,22,0.34); }
        }

        #__workflow_rec_indicator__{
          position:fixed;
          bottom:25vh;right:28px;
          width:0;height:0;
          z-index:2147483647;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
          touch-action:none;
          user-select:none;
        }

        .__wf_hub__{
          position:absolute;
          width:56px;height:56px;
          border-radius:50%;
          background:
            radial-gradient(circle at 30% 30%, rgba(239,67,69,0.16), transparent 42%),
            linear-gradient(180deg, rgba(20,21,28,0.98), rgba(16,17,22,1));
          border:1.5px solid var(--wf-border-strong);
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
          cursor:grab;
          transform:translate(-50%,-50%);
          animation:__wf_ripple__ 2s ease-out infinite;
          transition:transform 0.2s, box-shadow 0.2s, background 0.2s;
          box-shadow: 0 12px 28px rgba(16,17,22,0.45), inset 0 1px 0 rgba(239,67,69,0.08);
        }
        .__wf_hub__:hover{
          transform:translate(-50%,-50%) scale(1.03);
        }
        .__wf_hub__:active{cursor:grabbing;}
        .__wf_hub_label__{
          font-size:10px;font-weight:800;color:var(--wf-text);letter-spacing:1.1px;line-height:1;
        }
        .__wf_hub_sub__{
          font-size:7.5px;font-weight:600;color:var(--wf-text-muted);letter-spacing:0.5px;line-height:1;
        }

        .__wf_radial_btn__{
          all: unset;
          box-sizing: border-box;
          position:absolute;
          width:44px;height:44px;border-radius:50%;
          background:
            radial-gradient(circle at 30% 28%, rgba(239,67,69,0.12), transparent 40%),
            linear-gradient(180deg, rgba(20,21,28,0.98), rgba(16,17,22,1));
          border:1px solid var(--wf-btn-border, var(--wf-border-strong));
          backdrop-filter:blur(12px);
          -webkit-backdrop-filter:blur(12px);
          cursor:pointer;
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
          box-shadow:0 10px 26px rgba(16,17,22,0.34), inset 0 1px 0 rgba(239,67,69,0.06);
          transform:translate(-50%,-50%) scale(0);
          opacity:0;
          transition:transform 0.28s cubic-bezier(.34,1.56,.64,1),opacity 0.2s ease,border-color 0.15s,background 0.15s,box-shadow 0.15s;
          pointer-events:none;
          color: var(--wf-btn-accent, var(--wf-text));
        }
        .__wf_radial_btn__ svg{
          color:inherit;
          opacity:0.95;
        }
        .__wf_radial_btn__ span.__wf_btn_label__{
          font-size:7.2px;font-weight:800;color:inherit;
          letter-spacing:0.7px;line-height:1;white-space:nowrap;
          text-transform:uppercase;
        }
        .__wf_radial_btn__:hover{
          background:
            radial-gradient(circle at 30% 28%, rgba(239,67,69,0.16), transparent 40%),
            linear-gradient(180deg, rgba(24,25,33,0.98), rgba(16,17,22,1));
          border-color:var(--wf-btn-accent, var(--wf-accent));
          box-shadow:0 14px 30px rgba(16,17,22,0.4), 0 0 0 1px rgba(239,67,69,0.05), 0 0 18px var(--wf-btn-glow, rgba(239,67,69,0.18));
        }
        .__wf_expanded__ .__wf_radial_btn__{
          transform:translate(-50%,-50%) scale(1);
          opacity:1;
          pointer-events:auto;
        }

        /* Themed radial buttons */
        .__wf_btn_cp__ { --wf-btn-accent: var(--wf-text); --wf-btn-border: rgba(239,67,69,0.24); --wf-btn-glow: rgba(239,67,69,0.18); }
        .__wf_btn_net__ { --wf-btn-accent: var(--wf-text); --wf-btn-border: rgba(239,67,69,0.24); --wf-btn-glow: rgba(239,67,69,0.18); }
        .__wf_btn_log__ { --wf-btn-accent: var(--wf-text); --wf-btn-border: rgba(239,67,69,0.24); --wf-btn-glow: rgba(239,67,69,0.18); }
        .__wf_btn_save__ { --wf-btn-accent: var(--wf-text); --wf-btn-border: rgba(239,67,69,0.24); --wf-btn-glow: rgba(239,67,69,0.18); }
        .__wf_btn_del__ { --wf-btn-accent: var(--wf-text); --wf-btn-border: rgba(239,67,69,0.24); --wf-btn-glow: rgba(239,67,69,0.18); }
        .__wf_btn_rst__ { --wf-btn-accent: var(--wf-text); --wf-btn-border: rgba(239,67,69,0.24); --wf-btn-glow: rgba(239,67,69,0.18); }
      `;
    }

    // ── Build hub container ───────────────────────────────────────────────────
    const container = document.createElement("div");
    container.id = INDICATOR_ID;

    // ── Center REC hub ───────────────────────────────────────────────────────
    const hub = document.createElement("div");
    hub.className = "__wf_hub__";
    const recLabel = document.createElement("div");
    recLabel.className = "__wf_hub_label__";
    recLabel.textContent = "REC";
    const recSub = document.createElement("div");
    recSub.className = "__wf_hub_sub__";
    recSub.textContent = "live";
    hub.appendChild(recLabel);
    hub.appendChild(recSub);

    // ── Expand / collapse toggle ──────────────────────────────────────────────
    let expanded = false;

    // We open/close concentrics when clicking on the hub, but we only do it
    // if it wasn't a drag event. We'll handle this in the hub mouse handlers.

    // ── Radial button factory ─────────────────────────────────────────────────
    function makeRadialBtn(svgIcon, acronym, tipText, rx, ry, themeClass, onClick) {
      const btn = document.createElement("button");
      btn.className = "__wf_radial_btn__ " + (themeClass || "");
      btn.style.left = `${rx}px`;
      btn.style.top  = `${ry}px`;
      // H3: Build with DOM APIs. svgIcon is a trusted hardcoded constant so a temp
      // div parse is safe. acronym is always a literal string ("CP", "NET", etc.).
      const tmpDiv = document.createElement("div");
      tmpDiv.innerHTML = svgIcon; // trusted static SVG constant — safe
      while (tmpDiv.firstChild) btn.appendChild(tmpDiv.firstChild);
      const labelSpan = document.createElement("span");
      labelSpan.className = "__wf_btn_label__";
      labelSpan.textContent = acronym;
      btn.appendChild(labelSpan);
      btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return btn;
    }

    const R1 = 72;   // inner ring radius
    const R2 = 136;  // outer ring radius

    function pos(angleDeg, radius) {
      const rad = (angleDeg - 90) * Math.PI / 180;
      return { x: Math.round(radius * Math.cos(rad)), y: Math.round(radius * Math.sin(rad)) };
    }

    // Inner ring — observation tools
    const p1 = pos(210, R1);
    const p2 = pos(270, R1);
    const p3 = pos(330, R1);

    const btnScreenshot = makeRadialBtn(SVG.screenshot, "CP", "Screenshot checkpoint",
      p1.x, p1.y, "__wf_btn_cp__", async () => {
        let label = null;
        try {
          const stored = await chrome.storage.local.get(["promptScreenshotLabel"]);
          if (stored.promptScreenshotLabel) {
            // L3: Use custom prompt dialog instead of native prompt() which is
            // suppressed in cross-origin iframes on many modern sites.
            const prompted = await wfPrompt("Screenshot checkpoint label (optional):");
            if (prompted === null) return;
            label = prompted.trim() || null;
          }
        } catch (_) {}

        chrome.runtime.sendMessage({ type: "ADD_CHECKPOINT", label }).catch(() => {});
      });

    const btnNetwork = makeRadialBtn(SVG.network, "NET", "Toggle Network log",
      p2.x, p2.y, "__wf_btn_net__", () => chrome.runtime.sendMessage({ type: "TOGGLE_NETWORK_DIALOG" }).catch(() => {}));

    const btnConsole = makeRadialBtn(SVG.console, "LOG", "Toggle Console log",
      p3.x, p3.y, "__wf_btn_log__", () => chrome.runtime.sendMessage({ type: "TOGGLE_CONSOLE_DIALOG" }).catch(() => {}));

    // Outer ring — session controls
    const q1 = pos(210, R2);
    const q2 = pos(270, R2);
    const q3 = pos(330, R2);

    const closeAllDialogs = () => {
      chrome.runtime.sendMessage({ type: "CLOSE_CONSOLE_DIALOG" }).catch(() => {});
      chrome.runtime.sendMessage({ type: "CLOSE_NETWORK_DIALOG" }).catch(() => {});
    };

    const btnSave = makeRadialBtn(SVG.save, "SAVE", "Stop & Save",
      q1.x, q1.y, "__wf_btn_save__", () => {
        closeAllDialogs();
        chrome.runtime.sendMessage({ type: "STOP_RECORDING" }).catch(() => {});
      });

    // L3: Use custom confirm dialogs — native confirm() is silently blocked in
    // cross-origin iframes, causing DEL/RST to fail with no feedback.
    const btnDiscard = makeRadialBtn(SVG.discard, "DEL", "Discard recording",
      q2.x, q2.y, "__wf_btn_del__", async () => {
        if (await wfConfirm("Discard this recording?")) {
          closeAllDialogs();
          chrome.runtime.sendMessage({ type: "DISCARD_RECORDING" }).catch(() => {});
        }
      });

    const btnRestart = makeRadialBtn(SVG.restart, "RST", "Restart recording",
      q3.x, q3.y, "__wf_btn_rst__", async () => {
        if (await wfConfirm("Restart recording? Current events will be cleared.")) {
          chrome.runtime.sendMessage({ type: "RESTART_RECORDING" }).catch(() => {});
        }
      });

    container.appendChild(hub);
    container.appendChild(btnScreenshot);
    container.appendChild(btnNetwork);
    container.appendChild(btnConsole);
    container.appendChild(btnSave);
    container.appendChild(btnDiscard);
    container.appendChild(btnRestart);
    document.body.appendChild(container);

    // ── Drag logic ────────────────────────────────────────────────────────────
    // The hub is positioned at fixed bottom/right initially.
    // On drag start we switch to top/left coords to make math easy.
    let dragging = false;
    let dragStartX, dragStartY, startLeft, startTop;

    function getContainerRect() {
      const s = getComputedStyle(container);
      // Convert bottom/right to top/left if needed
      const rect = container.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    }

    let hasDragged = false;
    hub.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hasDragged) {
        expanded = !expanded;
        container.classList.toggle("__wf_expanded__", expanded);
      }
    });

    hub.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      hasDragged = false;
      const rect = getContainerRect();
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      startLeft = rect.left;
      startTop  = rect.top;
      // Switch to absolute top/left positioning so we can move freely
      container.style.bottom = "auto";
      container.style.right  = "auto";
      container.style.left   = startLeft + "px";
      container.style.top    = startTop  + "px";
      hub.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      hasDragged = true;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - 56, startLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - 56, startTop  + dy));
      container.style.left = newLeft + "px";
      container.style.top  = newTop  + "px";
    });

    document.addEventListener("mouseup", (e) => {
      if (!dragging) return;
      dragging = false;
      hub.style.cursor = "grab";
    });

    // Touch support
    hub.addEventListener("touchstart", (e) => {
      hasDragged = false;
      const t = e.touches[0];
      const rect = getContainerRect();
      dragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      startLeft = rect.left;
      startTop  = rect.top;
      container.style.bottom = "auto";
      container.style.right  = "auto";
      container.style.left   = startLeft + "px";
      container.style.top    = startTop  + "px";
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      hasDragged = true;
      const t = e.touches[0];
      const dx = t.clientX - dragStartX;
      const dy = t.clientY - dragStartY;
      const newLeft = Math.max(0, Math.min(window.innerWidth  - 56, startLeft + dx));
      const newTop  = Math.max(0, Math.min(window.innerHeight - 56, startTop  + dy));
      container.style.left = newLeft + "px";
      container.style.top  = newTop  + "px";
    }, { passive: true });

    document.addEventListener("touchend", () => { dragging = false; });
  }

  /**
   * Removes the visual recording indicator badge.
   *
   * Strategy:
   * Safely searches for the badge by identical ID and removes it from the DOM.
   */
  function hideRecordingIndicator() {
    document.getElementById(INDICATOR_ID)?.remove();
  }

  /**
   * Extension Event Listeners
   * Handle incoming state synchronization signals from background worker and local storage.
   */

  // Strategy: Subscribes to changes in local storage key 'wfMode' across all pages, ensuring 
  // that a change from the extension popup or background script propagates immediately 
  // to toggle the listeners on this specific active page.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area !== "local" || !changes.wfMode) return;
        if (changes.wfMode.newValue === "recording") {
          startListening();
        } else {
          stopListening();
        }
      } catch (err) {}
    });
  } catch (e) {}

  // Strategy: Permits direct point-to-point orchestration from the background worker 
  // without relying on storage sync lag. Useful for direct action triggers.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      try {
        if (msg.type === "RECORDER_START") { 
          startListening(); 
          sendResponse({ ok: true }); 
        } else if (msg.type === "RECORDER_STOP") { 
          stopListening(); 
          sendResponse({ ok: true }); 
        }
      } catch (err) {}
      return false;
    });
  } catch (e) {}

  /**
   * Initialization
   * Checks the starting wfMode when script initially executes.
   */

  // Strategy: Ensures if a tab is refreshed or newly opened while a recording session 
  // is globally active, the script instantly resumes recording by fetching the global state.
  try {
    chrome.storage.local.get("wfMode").then(data => {
      if (data.wfMode === "recording") {
        startListening();
      }
    }).catch(() => {
      // Graceful silent failure on init storage fetch
    });
  } catch (e) {}

  /**
   * MAIN-world → ISOLATED-world bridge
   *
   * Strategy:
   * `page-interceptor.js` runs in the page's MAIN JavaScript context and posts
   * structured messages via `window.postMessage`. This listener, running in the
   * ISOLATED world, picks them up and forwards them to the service worker only
   * while recording is active. The sentinel `__wfSrc: '__wf_interceptor__'`
   * prevents cross-talk with unrelated postMessage traffic on the page.
   */
  window.addEventListener("message", (e) => {
    if (e.origin !== window.location.origin) return;
    if (!e.data || e.data.__wfSrc !== "__wf_interceptor__") return;
    // Only forward during an active recording. Check both the in-memory flag
    // and chrome.storage as a fallback — the flag can be stale if the guard
    // fired on re-injection and startListening() wasn't called yet.
    if (!isRecording) {
      // Fast async check — if storage says we're recording, set the flag and proceed.
      try {
        chrome.storage.local.get("wfMode").then((data) => {
          if (data.wfMode === "recording") {
            isRecording = true;
            forwardInterceptorMessage(e.data);
          }
        }).catch(() => {});
      } catch (_) {}
      return;
    }
    forwardInterceptorMessage(e.data);
  });

  function forwardInterceptorMessage(data) {
    try {
      if (data.type === "console_log") {
        chrome.runtime.sendMessage({
          type: "RECORD_CONSOLE_LOG",
          log: {
            message: data.message,
            level: data.level || "log",
            timestamp: data.timestamp,
            url: window.location.href,
          },
        });
      } else if (data.type === "network_call") {
        // Forward network calls captured by MAIN-world fetch/XHR patching.
        // This carries requestBody which chrome.webRequest cannot provide.
        chrome.runtime.sendMessage({
          type: "RECORD_NETWORK_CALL_WITH_BODY",
          call: {
            url: data.url,
            method: data.method,
            status: data.status,
            statusText: data.statusText || null,
            requestHeaders: data.requestHeaders || null,
            requestBody: data.requestBody || null,
            responseHeaders: data.responseHeaders || null,
            responseBody: data.responseBody || null,
            timestamp: data.timestamp,
            tabUrl: window.location.href,
          },
        });
      }
    } catch (_) {}
  }

})();
