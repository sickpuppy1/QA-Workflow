/**
 * Service Worker — Orchestrator
 *
 * Strategy:
 * Acts as the centralized state machine for the entire extension. It manages the global 
 * 'mode' (idle | recording | playing), orchestrates the injection of content scripts across 
 * all tabs, routes messages between the popup and content frames, and handles all external 
 * backend communications (saving to the dashboard). The SW is designed to be ephemeral 
 * (it may go dormant), so it aggressively stores critical state to `chrome.storage.local`.
 */

// ─── State ────────────────────────────────────────────────────────────────────

// Dashboard API base URL — update this if deploying the dashboard elsewhere
const DASHBOARD_URL = 'http://localhost:3000';
const DASHBOARD_AUTH_TOKEN_KEY = 'dashboardAuthToken';
const RECENT_CAPTURE_WINDOW = 200;
const DEFAULT_NETWORK_MERGE_WINDOW_MS = 500;
const DEFAULT_DYNAMIC_BINDING_ENABLED = false;

// L2: Debug logging flag. Set to `true` during local development to enable
// verbose diagnostic output. Must remain `false` in production — some diagnostic
// logs expose user-sourced data (console message content, network URLs).
const __DEBUG__ = false;
/** @param {...any} args */
const debug = (...args) => { if (__DEBUG__) console.warn('[WF:debug]', ...args); };

const state = {
  mode: "idle",       // 'idle' | 'recording' | 'playing'

  // Recording
  workflowName: "",
  recordingSessionId: null,
  events: [],
  recordingCheckpoints: [],
  screenshots: {},    // stepIndex -> dataUrl (both rec & play)
  screenshotCount: 0,
  recordingTabId: null,

  // Console / network interception (populated during recording)
  consoleLogs: {},    // { [tabId]: [{ message, timestamp, url }] }
  networkCalls: {},   // { [tabId]: [{ url, method, status, timestamp }] }
  networkClearCutoffs: {},
  networkMergeWindowMs: DEFAULT_NETWORK_MERGE_WINDOW_MS,
  dynamicBindingEnabled: DEFAULT_DYNAMIC_BINDING_ENABLED,
  dialogState: { consoleOpen: false, networkOpen: false },

  // Playing
  workflowsToPlay: [],
  workflowToPlay: null,
  playbackIndex: 0,
  playbackTabId: null,
  dynamicRuntime: null,
  dynamicPause: null,
};

const RECORDING_DB_NAME = "workflow-recorder-db";
const RECORDING_DB_VERSION = 1;
const RECORDING_STORE_NAME = "recording_state";
const ACTIVE_RECORDING_KEY = "active_recording";

function normalizeNetworkMergeWindowMs(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_NETWORK_MERGE_WINDOW_MS), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_NETWORK_MERGE_WINDOW_MS;
  return Math.min(2000, Math.max(100, parsed));
}

function normalizeDynamicBindingEnabled(value) {
  return Boolean(value);
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDynamicInputs(input) {
  if (!isRecord(input)) return null;

  const rawVariables = isRecord(input.variables) ? input.variables : {};
  const rawBindings = Array.isArray(input.bindings) ? input.bindings : [];
  const variables = {};

  for (const [key, rawVariable] of Object.entries(rawVariables)) {
    if (!key || !isRecord(rawVariable)) continue;
    if (rawVariable.kind === "date_range") {
      const start = typeof rawVariable.start === "string" ? rawVariable.start : "";
      const end = typeof rawVariable.end === "string" ? rawVariable.end : "";
      const stepUnit = rawVariable.stepUnit === "week" || rawVariable.stepUnit === "month" ? rawVariable.stepUnit : "day";
      const output = rawVariable.output === "datetime-local" || rawVariable.output === "text" ? rawVariable.output : "date";
      const stepValue = Math.max(1, Math.trunc(clampNumber(rawVariable.stepValue, 1, 365, 1)));
      variables[key] = {
        kind: "date_range",
        start,
        end,
        stepUnit,
        stepValue,
        output,
      };
    } else if (rawVariable.kind === "number_sequence") {
      const start = clampNumber(rawVariable.start, -1e12, 1e12, 0);
      const step = clampNumber(rawVariable.step, -1e9, 1e9, 1);
      const decimals = rawVariable.decimals == null ? null : Math.max(0, Math.min(8, Math.trunc(clampNumber(rawVariable.decimals, 0, 8, 0))));
      const min = rawVariable.min == null ? null : clampNumber(rawVariable.min, -1e12, 1e12, -1e12);
      const max = rawVariable.max == null ? null : clampNumber(rawVariable.max, -1e12, 1e12, 1e12);
      variables[key] = {
        kind: "number_sequence",
        start,
        step,
        decimals,
        min,
        max,
      };
    }
  }

  const bindings = rawBindings
    .map((binding) => {
      if (!isRecord(binding)) return null;
      const eventIndex = Math.trunc(clampNumber(binding.eventIndex, 0, 1e6, -1));
      const variableKey = typeof binding.variableKey === "string" ? binding.variableKey : "";
      if (eventIndex < 0 || !variableKey) return null;
      return {
        eventIndex,
        variableKey,
        selector: typeof binding.selector === "string" ? binding.selector : null,
        mode: "replace",
      };
    })
    .filter((entry) => entry && variables[entry.variableKey]);

  if (Object.keys(variables).length === 0 || bindings.length === 0) return null;

  return {
    version: 1,
    variables,
    bindings,
  };
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatDateForOutput(date, output) {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hour = padDatePart(date.getHours());
  const minute = padDatePart(date.getMinutes());

  if (output === "datetime-local") {
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }
  if (output === "text") {
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }
  return `${year}-${month}-${day}`;
}

function addDateByStep(sourceDate, stepUnit, stepValue, loopIndex) {
  const date = new Date(sourceDate.getTime());
  const steps = Math.max(0, loopIndex) * Math.max(1, stepValue);
  if (steps === 0) return date;
  if (stepUnit === "month") {
    date.setMonth(date.getMonth() + steps);
    return date;
  }
  const dayDelta = stepUnit === "week" ? steps * 7 : steps;
  date.setDate(date.getDate() + dayDelta);
  return date;
}

function resolveDynamicVariableValue(variable, loopIndex, overrideValue) {
  if (!variable || typeof variable !== "object") {
    return { ok: false, reason: "missing_variable", message: "Dynamic variable is missing." };
  }

  if (variable.kind === "date_range") {
    const parseDateSafe = (value) => {
      const date = new Date(String(value ?? ""));
      return Number.isNaN(date.getTime()) ? null : date;
    };

    const startDate = parseDateSafe(variable.start);
    const endDate = parseDateSafe(variable.end);
    if (!startDate || !endDate) {
      return { ok: false, reason: "invalid_date_config", message: "Date range has an invalid start or end value." };
    }
    if (startDate.getTime() > endDate.getTime()) {
      return { ok: false, reason: "invalid_date_config", message: "Date range start is after end." };
    }

    const output = variable.output === "datetime-local" || variable.output === "text" ? variable.output : "date";
    const stepUnit = variable.stepUnit === "week" || variable.stepUnit === "month" ? variable.stepUnit : "day";
    const stepValue = Math.max(1, Math.trunc(clampNumber(variable.stepValue, 1, 365, 1)));
    const shiftedStartDate = addDateByStep(
      startDate,
      stepUnit,
      stepValue,
      loopIndex
    );
    const shiftedEndDate = addDateByStep(
      endDate,
      stepUnit,
      stepValue,
      loopIndex
    );

    if (overrideValue != null && String(overrideValue).trim() !== "") {
      const rawOverride = String(overrideValue).trim();
      if (output === "text" && rawOverride.includes(" - ")) {
        const [rawStart, rawEnd] = rawOverride.split(" - ").map((value) => value.trim());
        const parsedStart = parseDateSafe(rawStart);
        const parsedEnd = parseDateSafe(rawEnd);
        if (!parsedStart || !parsedEnd || parsedEnd.getTime() < parsedStart.getTime()) {
          return { ok: false, reason: "invalid_override", message: "Date-range override is invalid." };
        }
        return {
          ok: true,
          value: `${formatDateForOutput(parsedStart, "date")} - ${formatDateForOutput(parsedEnd, "date")}`,
          rangeStart: formatDateForOutput(parsedStart, "date"),
          rangeEnd: formatDateForOutput(parsedEnd, "date"),
        };
      }

      const overrideDate = parseDateSafe(rawOverride);
      if (!overrideDate) {
        return { ok: false, reason: "invalid_override", message: "Date override is invalid." };
      }
      if (overrideDate.getTime() < startDate.getTime() || overrideDate.getTime() > endDate.getTime()) {
        return { ok: false, reason: "range_exhausted", message: "Date override falls outside the configured period." };
      }
      return { ok: true, value: formatDateForOutput(overrideDate, output) };
    }

    if (output === "text") {
      return {
        ok: true,
        value: `${formatDateForOutput(shiftedStartDate, "date")} - ${formatDateForOutput(shiftedEndDate, "date")}`,
        rangeStart: formatDateForOutput(shiftedStartDate, "date"),
        rangeEnd: formatDateForOutput(shiftedEndDate, "date"),
      };
    }

    if (shiftedStartDate.getTime() > endDate.getTime()) {
      return { ok: false, reason: "range_exhausted", message: "Computed date exceeded configured end date." };
    }

    return { ok: true, value: formatDateForOutput(shiftedStartDate, output) };
  }

  if (variable.kind === "number_sequence") {
    const parseNum = (value) => {
      const parsed = Number.parseFloat(String(value ?? ""));
      return Number.isFinite(parsed) ? parsed : null;
    };

    const decimals = variable.decimals == null ? null : Math.max(0, Math.min(8, Math.trunc(clampNumber(variable.decimals, 0, 8, 0))));
    let resolved = 0;
    if (overrideValue != null && String(overrideValue).trim() !== "") {
      const overrideNum = parseNum(overrideValue);
      if (overrideNum == null) {
        return { ok: false, reason: "invalid_override", message: "Numeric override is invalid." };
      }
      resolved = overrideNum;
    } else {
      const start = clampNumber(variable.start, -1e12, 1e12, 0);
      const step = clampNumber(variable.step, -1e9, 1e9, 1);
      resolved = start + (step * Math.max(0, loopIndex));
    }

    if (decimals != null) {
      resolved = Number(resolved.toFixed(decimals));
    }

    if (variable.min != null && resolved < variable.min) {
      return { ok: false, reason: "range_exhausted", message: "Numeric value is below the configured minimum." };
    }
    if (variable.max != null && resolved > variable.max) {
      return { ok: false, reason: "range_exhausted", message: "Numeric value is above the configured maximum." };
    }

    return { ok: true, value: resolved };
  }

  return { ok: false, reason: "unsupported_variable", message: "Unsupported dynamic variable kind." };
}

function buildDynamicRuntime(workflow, workflowQueueIndex, loopIndex) {
  const dynamicInputs = normalizeDynamicInputs(workflow?.dynamicInputs);
  if (!dynamicInputs) return null;

  const bindingsByEventIndex = {};
  dynamicInputs.bindings.forEach((binding) => {
    if (!bindingsByEventIndex[binding.eventIndex]) {
      bindingsByEventIndex[binding.eventIndex] = binding;
    }
  });

  return {
    workflowQueueIndex,
    loopIndex,
    dynamicInputs,
    bindingsByEventIndex,
    overrides: {},
    resolvedValues: {},
    errors: {},
    syntheticDatePickerOpen: false,
  };
}

function recomputeDynamicRuntime(runtime) {
  if (!runtime) return null;
  runtime.resolvedValues = {};
  runtime.errors = {};
  for (const [variableKey, variable] of Object.entries(runtime.dynamicInputs.variables || {})) {
    const resolved = resolveDynamicVariableValue(variable, runtime.loopIndex, runtime.overrides?.[variableKey]);
    if (resolved.ok) {
      runtime.resolvedValues[variableKey] = resolved.value;
    } else {
      runtime.errors[variableKey] = {
        reason: resolved.reason || "unknown",
        message: resolved.message || "Unable to resolve variable",
      };
    }
  }
  return runtime;
}

function dynamicStatePayload() {
  const runtime = state.dynamicRuntime;
  if (!runtime) {
    return {
      type: "PLAYBACK_DYNAMIC_STATE",
      active: false,
      workflowQueueIndex: null,
      loopIndex: null,
      values: {},
      errors: {},
      overrides: {},
      dynamicInputs: null,
      paused: false,
      pauseIssue: null,
    };
  }

  return {
    type: "PLAYBACK_DYNAMIC_STATE",
    active: true,
    workflowQueueIndex: runtime.workflowQueueIndex,
    loopIndex: runtime.loopIndex,
    values: runtime.resolvedValues || {},
    errors: runtime.errors || {},
    overrides: runtime.overrides || {},
    dynamicInputs: runtime.dynamicInputs,
    paused: Boolean(state.dynamicPause),
    pauseIssue: state.dynamicPause?.issue || null,
  };
}

async function broadcastDynamicState() {
  await broadcastToPopup(dynamicStatePayload());
}

function clearDynamicPauseWithResult(result = "aborted") {
  const pause = state.dynamicPause;
  if (!pause) return;
  state.dynamicPause = null;
  try {
    pause.resolve(result);
  } catch (_) {}
}

async function waitForDynamicResume(issue) {
  clearDynamicPauseWithResult("aborted");
  let resolver;
  const waiter = new Promise((resolve) => {
    resolver = resolve;
  });
  state.dynamicPause = { issue, resolve: resolver };
  await broadcastToPopup({
    type: "PLAYBACK_DYNAMIC_PAUSED",
    ...issue,
  });
  await broadcastDynamicState();
  return waiter;
}

function getNetworkClearCutoff(tabId) {
  if (!tabId) return 0;
  return state.networkClearCutoffs?.[tabId] || 0;
}

function isStaleNetworkEntry(tabId, entry) {
  const cutoff = getNetworkClearCutoff(tabId);
  if (!cutoff) return false;
  const timestamp = typeof entry?.timestamp === "number" ? entry.timestamp : 0;
  return timestamp > 0 && timestamp <= cutoff;
}

function pruneNetworkEntries(tabId) {
  if (!tabId) return [];
  const nextItems = (state.networkCalls[tabId] || []).filter((entry) => !isStaleNetworkEntry(tabId, entry));
  state.networkCalls[tabId] = nextItems;
  return nextItems;
}

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(RECORDING_DB_NAME, RECORDING_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(RECORDING_STORE_NAME)) {
          db.createObjectStore(RECORDING_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function readActiveRecordingSnapshotFromDb() {
  try {
    const db = await openRecordingDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDING_STORE_NAME, "readonly");
      const store = tx.objectStore(RECORDING_STORE_NAME);
      const req = store.get(ACTIVE_RECORDING_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function writeActiveRecordingSnapshotToDb(snapshot) {
  try {
    const db = await openRecordingDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDING_STORE_NAME, "readwrite");
      const store = tx.objectStore(RECORDING_STORE_NAME);
      store.put(snapshot, ACTIVE_RECORDING_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (_) {}
}

async function clearActiveRecordingSnapshotFromDb() {
  try {
    const db = await openRecordingDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDING_STORE_NAME, "readwrite");
      const store = tx.objectStore(RECORDING_STORE_NAME);
      store.delete(ACTIVE_RECORDING_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (_) {}
}

function buildAuthoritativeRecordingSnapshot() {
  return {
    workflowName: state.workflowName,
    recordingSessionId: state.recordingSessionId,
    events: state.events || [],
    recordingCheckpoints: state.recordingCheckpoints || [],
    screenshots: state.screenshots || {},
    screenshotCount: state.screenshotCount || 0,
  };
}

function isCheckpointEventType(type) {
  return type === "checkpoint" || type === "console_checkpoint" || type === "network_checkpoint";
}

function truncateForStorage(value, maxLen = 2000) {
  if (typeof value !== "string") return value ?? null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function sanitizeHeadersForStorage(headers, maxKeys = 24, maxValueLen = 160) {
  const source = headers && typeof headers === "object" ? headers : {};
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, maxKeys)
      .map(([key, value]) => [key, truncateForStorage(typeof value === "string" ? value : String(value), maxValueLen)])
  );
}

function sanitizeCheckpointForStorage(item) {
  if (!item) return item;
  return {
    ...item,
    logMessage: truncateForStorage(item.logMessage, 1000),
    networkUrl: truncateForStorage(item.networkUrl, 1000),
    networkRequestBody: truncateForStorage(item.networkRequestBody, 2000),
    networkResponseBody: truncateForStorage(item.networkResponseBody, 2000),
    networkStatusText: truncateForStorage(item.networkStatusText, 120),
    networkRequestHeaders: sanitizeHeadersForStorage(item.networkRequestHeaders),
    networkResponseHeaders: sanitizeHeadersForStorage(item.networkResponseHeaders),
    logContextBefore: Array.isArray(item.logContextBefore) ? item.logContextBefore.slice(-1) : [],
    logContextAfter: Array.isArray(item.logContextAfter) ? item.logContextAfter.slice(0, 1) : [],
  };
}

function sanitizeEventForStorage(item) {
  return isCheckpointEventType(item?.type) ? sanitizeCheckpointForStorage(item) : item;
}

function buildRecordingSnapshotForStorage() {
  return {
    workflowName: state.workflowName,
    recordingSessionId: state.recordingSessionId,
    events: (state.events || []).map(sanitizeEventForStorage),
    recordingCheckpoints: (state.recordingCheckpoints || []).map(sanitizeCheckpointForStorage),
    screenshotCount: state.screenshotCount,
  };
}

function createRecordingSessionId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return `rec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function compareByTimestamp(a, b) {
  return (a?.timestamp || 0) - (b?.timestamp || 0);
}

function networkFieldCount(call) {
  if (!call) return 0;
  let score = 0;
  if (call.statusText) score += 1;
  if (call.requestBody != null) score += 2;
  if (call.responseBody != null) score += 2;
  if (call.requestHeaders && Object.keys(call.requestHeaders).length > 0) score += 2;
  if (call.responseHeaders && Object.keys(call.responseHeaders).length > 0) score += 2;
  return score;
}

function canMergeNetworkCalls(a, b, windowMs = DEFAULT_NETWORK_MERGE_WINDOW_MS) {
  if (!a || !b) return false;
  if ((a.url || null) !== (b.url || null)) return false;
  if ((a.method || "GET") !== (b.method || "GET")) return false;
  if (a.status != null && b.status != null && a.status !== b.status) return false;
  const ta = typeof a.timestamp === "number" ? a.timestamp : null;
  const tb = typeof b.timestamp === "number" ? b.timestamp : null;
  if (ta != null && tb != null && Math.abs(ta - tb) > windowMs) return false;
  return true;
}

function mergeNetworkCallEntries(existing, incoming) {
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
    tabUrl: incoming?.tabUrl ?? existing?.tabUrl ?? null,
  };
}

function upsertRecordedNetworkCall(tabId, call) {
  state.networkCalls[tabId] = state.networkCalls[tabId] || [];
  const calls = state.networkCalls[tabId];
  let bestIndex = -1;
  let bestScore = -1;

  for (let i = calls.length - 1; i >= 0; i--) {
    if (!canMergeNetworkCalls(calls[i], call, state.networkMergeWindowMs)) continue;
    const score = networkFieldCount(calls[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex >= 0) {
    calls[bestIndex] = mergeNetworkCallEntries(calls[bestIndex], call);
    return calls[bestIndex];
  }

  if (calls.length >= RECENT_CAPTURE_WINDOW) calls.shift();
  calls.push(call);
  return call;
}

async function readBufferedCheckpointIntents() {
  try {
    const stored = await chrome.storage.local.get("wfCheckpointIntents");
    return Array.isArray(stored.wfCheckpointIntents) ? stored.wfCheckpointIntents : [];
  } catch (_) {
    return [];
  }
}

async function mergeBufferedCheckpointIntents() {
  if (!state.recordingSessionId) return false;

  const intents = await readBufferedCheckpointIntents();
  const relevantIntents = intents.filter((entry) =>
    entry &&
    entry.sessionId === state.recordingSessionId &&
    entry.event &&
    isCheckpointEventType(entry.event.type)
  );

  if (relevantIntents.length === 0) return false;

  const eventKeys = new Set((state.events || []).map(recordingItemKey));
  const checkpointKeys = new Set((state.recordingCheckpoints || []).map(recordingItemKey));
  let changed = false;

  relevantIntents.forEach(({ event }) => {
    const key = recordingItemKey(event);
    if (!eventKeys.has(key)) {
      state.events.push(event);
      eventKeys.add(key);
      changed = true;
    }
    if (!checkpointKeys.has(key)) {
      state.recordingCheckpoints.push(event);
      checkpointKeys.add(key);
      changed = true;
    }
  });

  if (changed) {
    state.events.sort(compareByTimestamp);
    state.recordingCheckpoints.sort(compareByTimestamp);
  }

  return changed;
}

// ─── Storage helpers (chrome.storage.LOCAL) ───────────────────────────────────

/**
 * Persists the recording active state.
 *
 * Strategy:
 * Writes 'recording' to `chrome.storage.local` alongside initializing empty event arrays.
 * Because it uses `local` (instead of `session`), this write triggers `chrome.storage.onChanged` 
 * inside every injected content script globally, allowing all tabs to immediately start 
 * capturing DOM events without needing direct message dispatches to each one.
 */
async function setRecordingActive() {
  try {
    await chrome.storage.local.set({
      wfMode: "recording",
      wfRecordingSessionId: state.recordingSessionId,
      wfEvents: [],
      wfCheckpoints: [],
      wfCheckpointIntents: [],
      wfScreenshotCount: 0,
    });
    await chrome.storage.session.set({
      wfRecordingSnapshot: {
        workflowName: "",
        recordingSessionId: state.recordingSessionId,
        events: [],
        recordingCheckpoints: [],
        screenshotCount: 0,
      },
      wfNetworkClearCutoffs: {},
    });
    await writeActiveRecordingSnapshotToDb({
      workflowName: "",
      recordingSessionId: state.recordingSessionId,
      events: [],
      recordingCheckpoints: [],
      screenshots: {},
      screenshotCount: 0,
    });
  } catch (e) {
    console.error("[WFRec] setRecordingActive failed:", e);
  }
}

/**
 * Clears the recording active state.
 *
 * Strategy:
 * Forces `wfMode` to 'idle', prompting the same global `onChanged` broadcast to all 
 * content scripts to deactivate their listeners. Also cleans up heavy arrays (wfEvents, 
 * wfScreenshotCount) from storage to free up disk space.
 */
async function setRecordingIdle() {
  try {
    await chrome.storage.local.set({ wfMode: "idle" });
    await chrome.storage.local.remove([
      "wfEvents",
      "wfCheckpoints",
      "wfCheckpointIntents",
      "wfRecordingSessionId",
      "wfScreenshotCount",
    ]);
    await chrome.storage.session.remove("wfRecordingSnapshot");
    await chrome.storage.session.remove("wfNetworkClearCutoffs");
    await clearActiveRecordingSnapshotFromDb();
  } catch (_) {}
}

/**
 * Periodically backs up the recorded events array.
 *
 * Strategy:
 * Service workers can be terminated by Chrome at any time. By regularly saving the active 
 * `state.events` memory array to local storage, the extension ensures no data is lost 
 * if the user takes too long between clicks and the SW goes to sleep.
 */
async function persistEvents() {
  try {
    const storedEvents = (state.events || []).map(sanitizeEventForStorage);
    const storedCheckpoints = (state.recordingCheckpoints || []).map(sanitizeCheckpointForStorage);
    await chrome.storage.local.set({
      wfRecordingSessionId: state.recordingSessionId,
      wfEvents: storedEvents,
      wfCheckpoints: storedCheckpoints,
      wfScreenshotCount: state.screenshotCount,
    });
    await chrome.storage.session.set({
      wfRecordingSnapshot: buildRecordingSnapshotForStorage(),
    });
    await writeActiveRecordingSnapshotToDb(buildAuthoritativeRecordingSnapshot());
  } catch (_) {}
}

function recordingItemKey(item) {
  if (item?.checkpointId) return `checkpoint:${item.checkpointId}`;
  return JSON.stringify([
    item?.type ?? null,
    item?.label ?? null,
    item?.timestamp ?? null,
    item?.url ?? null,
  ]);
}

async function appendCheckpointToRecordingState(checkpointEvent) {
  state.events.push(checkpointEvent);
  state.recordingCheckpoints.push(checkpointEvent);
  state.events.sort(compareByTimestamp);
  state.recordingCheckpoints.sort(compareByTimestamp);

  const eventKey = recordingItemKey(checkpointEvent);

  try {
    await writeActiveRecordingSnapshotToDb(buildAuthoritativeRecordingSnapshot());

    const session = await chrome.storage.session.get("wfRecordingSnapshot");
    const snapshot = session.wfRecordingSnapshot || null;
    const nextEvents = Array.isArray(state.events) ? [...state.events] : [];
    const nextCheckpoints = Array.isArray(state.recordingCheckpoints) ? [...state.recordingCheckpoints] : [];

    if (Array.isArray(snapshot?.events)) {
      snapshot.events.forEach((item) => {
        if (!nextEvents.some((existing) => recordingItemKey(existing) === recordingItemKey(item))) {
          nextEvents.push(item);
        }
      });
    }
    if (Array.isArray(snapshot?.recordingCheckpoints)) {
      snapshot.recordingCheckpoints.forEach((item) => {
        if (!nextCheckpoints.some((existing) => recordingItemKey(existing) === recordingItemKey(item))) {
          nextCheckpoints.push(item);
        }
      });
    }
    if (!nextEvents.some((item) => recordingItemKey(item) === eventKey)) {
      nextEvents.push(checkpointEvent);
    }
    if (!nextCheckpoints.some((item) => recordingItemKey(item) === eventKey)) {
      nextCheckpoints.push(checkpointEvent);
    }

    nextEvents.sort(compareByTimestamp);
    nextCheckpoints.sort(compareByTimestamp);

    state.events = nextEvents;
    state.recordingCheckpoints = nextCheckpoints;

    const storedEvents = nextEvents.map(sanitizeEventForStorage);
    const storedCheckpoints = nextCheckpoints.map(sanitizeCheckpointForStorage);
    await chrome.storage.local.set({
      wfRecordingSessionId: state.recordingSessionId,
      wfEvents: storedEvents,
      wfCheckpoints: storedCheckpoints,
      wfScreenshotCount: state.screenshotCount,
    });
    await chrome.storage.session.set({
      wfRecordingSnapshot: {
        workflowName: state.workflowName,
        recordingSessionId: state.recordingSessionId,
        events: storedEvents,
        recordingCheckpoints: storedCheckpoints,
        screenshotCount: state.screenshotCount,
      },
    });
  } catch (_) {
    await persistEvents();
  }
}

async function hydrateRecordingStateFromStorage() {
  try {
    const dbSnapshot = await readActiveRecordingSnapshotFromDb();
    if (dbSnapshot) {
      if (dbSnapshot.recordingSessionId) {
        state.recordingSessionId = dbSnapshot.recordingSessionId;
      }
      if (Array.isArray(dbSnapshot.events) && dbSnapshot.events.length > state.events.length) {
        state.events = dbSnapshot.events;
      }
      if (Array.isArray(dbSnapshot.recordingCheckpoints) && dbSnapshot.recordingCheckpoints.length > state.recordingCheckpoints.length) {
        state.recordingCheckpoints = dbSnapshot.recordingCheckpoints;
      }
      if (dbSnapshot.screenshots && Object.keys(dbSnapshot.screenshots).length > Object.keys(state.screenshots || {}).length) {
        state.screenshots = dbSnapshot.screenshots;
      }
      if ((dbSnapshot.screenshotCount || 0) > (state.screenshotCount || 0)) {
        state.screenshotCount = dbSnapshot.screenshotCount || 0;
      }
      if (dbSnapshot.workflowName) {
        state.workflowName = dbSnapshot.workflowName;
      }
    }

    const [session, local] = await Promise.all([
      chrome.storage.session.get("wfRecordingSnapshot"),
      chrome.storage.local.get(["wfEvents", "wfCheckpoints", "wfRecordingSessionId", "wfScreenshotCount"]),
    ]);

    console.log([session,local]);

    const snapshot = session.wfRecordingSnapshot || null;
    const localEvents = Array.isArray(local.wfEvents) ? local.wfEvents : [];
    const localCheckpoints = Array.isArray(local.wfCheckpoints) ? local.wfCheckpoints : [];
    const sessionEvents = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const sessionCheckpoints = Array.isArray(snapshot?.recordingCheckpoints) ? snapshot.recordingCheckpoints : [];

    if (!state.recordingSessionId) {
      state.recordingSessionId = local.wfRecordingSessionId || snapshot?.recordingSessionId || null;
    }

    if (localEvents.length > sessionEvents.length && localEvents.length > state.events.length) {
      state.events = localEvents;
    } else if (sessionEvents.length > state.events.length) {
      state.events = sessionEvents;
    }

    if (localCheckpoints.length > sessionCheckpoints.length && localCheckpoints.length > state.recordingCheckpoints.length) {
      state.recordingCheckpoints = localCheckpoints;
    } else if (sessionCheckpoints.length > state.recordingCheckpoints.length) {
      state.recordingCheckpoints = sessionCheckpoints;
    }

    state.screenshotCount = Math.max(
      state.screenshotCount || 0,
      local.wfScreenshotCount || 0,
      snapshot?.screenshotCount || 0
    );

    if (snapshot?.workflowName) {
      state.workflowName = snapshot.workflowName;
    }
  } catch (_) {}
}

// ─── SW wake-up: restore in-memory state from local storage ──────────────────

/**
 * Initialize on SW Wake-up
 *
 * Strategy:
 * Uses a global `readyPromise` to block incoming message handling until the SW successfully 
 * pulls its saved state back from `chrome.storage.local`. This prevents race conditions 
 * where a content script sends an event immediately after waking the SW, but before the 
 * SW realizes it is supposed to be in 'recording' mode, thereby dropping the event.
 */
let _readyResolve;
const readyPromise = new Promise(r => { _readyResolve = r; });
let recordingMutationChain = Promise.resolve();

function enqueueRecordingMutation(task) {
  const run = recordingMutationChain.then(task, task);
  recordingMutationChain = run.catch(() => {});
  return run;
}

(async () => {
  try {
    const stored = await chrome.storage.local.get(["wfMode", "wfEvents", "wfCheckpoints", "wfRecordingSessionId", "wfScreenshotCount", "networkMergeWindowMs", "dynamicBindingEnabled"]);
    if (stored.wfMode === "recording") {
      state.mode = "recording";
      state.events = stored.wfEvents || [];
      state.recordingCheckpoints = stored.wfCheckpoints || [];
      state.recordingSessionId = stored.wfRecordingSessionId || null;
      state.screenshotCount = stored.wfScreenshotCount || 0;
    }
    state.networkMergeWindowMs = normalizeNetworkMergeWindowMs(stored.networkMergeWindowMs);
    state.dynamicBindingEnabled = normalizeDynamicBindingEnabled(stored.dynamicBindingEnabled);
  } catch (_) {}

  try {
    const session = await chrome.storage.session.get(["wfRecordingSnapshot", "wfNetworkCalls", "wfNetworkClearCutoffs"]);
    const dbSnapshot = await readActiveRecordingSnapshotFromDb();
    if (dbSnapshot) {
      state.workflowName = dbSnapshot.workflowName || state.workflowName;
      state.recordingSessionId = dbSnapshot.recordingSessionId || state.recordingSessionId;
      if ((dbSnapshot.events || []).length > (state.events || []).length) {
        state.events = dbSnapshot.events || state.events;
      }
      if ((dbSnapshot.recordingCheckpoints || []).length > (state.recordingCheckpoints || []).length) {
        state.recordingCheckpoints = dbSnapshot.recordingCheckpoints || state.recordingCheckpoints;
      }
      if (dbSnapshot.screenshots && Object.keys(dbSnapshot.screenshots).length > Object.keys(state.screenshots || {}).length) {
        state.screenshots = dbSnapshot.screenshots || state.screenshots;
      }
      state.screenshotCount = Math.max(
        state.screenshotCount || 0,
        dbSnapshot.screenshotCount || 0
      );
    }

    if (session.wfRecordingSnapshot) {
      state.workflowName = session.wfRecordingSnapshot.workflowName || state.workflowName;
      state.recordingSessionId = session.wfRecordingSnapshot.recordingSessionId || state.recordingSessionId;
      if ((session.wfRecordingSnapshot.events || []).length > (state.events || []).length) {
        state.events = session.wfRecordingSnapshot.events || state.events;
      }
      if ((session.wfRecordingSnapshot.recordingCheckpoints || []).length > (state.recordingCheckpoints || []).length) {
        state.recordingCheckpoints = session.wfRecordingSnapshot.recordingCheckpoints || state.recordingCheckpoints;
      }
      state.screenshotCount = Math.max(
        state.screenshotCount || 0,
        session.wfRecordingSnapshot.screenshotCount || 0
      );
    }

    if (session.wfNetworkCalls) {
      state.networkCalls = session.wfNetworkCalls;
    }
    if (session.wfNetworkClearCutoffs) {
      state.networkClearCutoffs = session.wfNetworkClearCutoffs;
    }
  } catch (_) {}

  _readyResolve();
})();

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.networkMergeWindowMs) {
      state.networkMergeWindowMs = normalizeNetworkMergeWindowMs(changes.networkMergeWindowMs.newValue);
    }
    if (changes.dynamicBindingEnabled) {
      state.dynamicBindingEnabled = normalizeDynamicBindingEnabled(changes.dynamicBindingEnabled.newValue);
      if (!state.dynamicBindingEnabled) {
        state.dynamicRuntime = null;
        clearDynamicPauseWithResult("aborted");
        broadcastDynamicState();
      }
    }
  });
} catch (_) {}

// ─── Message routing ──────────────────────────────────────────────────────────

/**
 * Core Message Router
 *
 * Strategy:
 * Central dispatch for all extension communications. Evaluates the `msg.type` and routes 
 * it to the appropriate async handler. Returns `true` for asynchronous operations to keep 
 * the Chrome messaging channel open until `sendResponse` is called. For recording events, 
 * explicitly awaits `readyPromise` first to guarantee state stability before processing.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // H4 — Security guard: reject messages from any external extension or source.
  // All legitimate senders (popup, content scripts) share this extension's ID.
  if (sender.id && sender.id !== chrome.runtime.id) return false;

  switch (msg.type) {
    case "START_RECORDING":
      enqueueRecordingMutation(() => handleStartRecording(msg, sendResponse));
      return true;

    case "STOP_RECORDING":
      enqueueRecordingMutation(() => handleStopRecording(sendResponse));
      return true;

    case "RECORD_EVENT":
      enqueueRecordingMutation(async () => {
        await readyPromise;
        handleRecordEvent(msg.event);
        sendResponse({ ok: true });
      });
      return true; // async response — keep message channel open

    case "RESTART_RECORDING":
      enqueueRecordingMutation(() => handleRestartRecording(sendResponse));
      return true;

    case "DISCARD_RECORDING":
      enqueueRecordingMutation(() => handleDiscardRecording(sendResponse));
      return true;

    case "ADD_CHECKPOINT":
      enqueueRecordingMutation(() => handleAddCheckpoint(msg.label, sendResponse));
      return true;

    case "RECORD_CONSOLE_LOG":
      readyPromise.then(() => {
        if (state.mode === "recording") {
          const tid = sender.tab?.id;
          if (tid) {
            state.consoleLogs[tid] = state.consoleLogs[tid] || [];
            if (state.consoleLogs[tid].length >= RECENT_CAPTURE_WINDOW) {
              state.consoleLogs[tid].shift();
            }
            state.consoleLogs[tid].push(msg.log);
          }
        }
        sendResponse({ ok: true });
      });
      return true;

    case "RECORD_NETWORK_CALL":
      // Network calls are now captured via chrome.webRequest (recordNetworkCall).
      // This handler is kept as a no-op fallback for any legacy callers.
      sendResponse({ ok: true });
      return false;

    case "RECORD_NETWORK_CALL_WITH_BODY":
      // Enriches the network call record from chrome.webRequest with request/response
      // body data that only the MAIN world fetch/XHR interceptor can see.
      readyPromise.then(() => {
        if (state.mode === "recording") {
          const tid = sender.tab?.id;
          if (tid) {
            const call = msg.call;
            if (isStaleNetworkEntry(tid, call)) {
              sendResponse({ ok: true });
              return;
            }
            const mergedCall = upsertRecordedNetworkCall(tid, call);
            chrome.storage.session.set({ wfNetworkCalls: state.networkCalls }).catch(() => {});
            chrome.tabs.sendMessage(tid, { type: "NETWORK_CALL_LIVE", call: mergedCall }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
      });
      return true;

    case "GET_CONSOLE_LOGS":
      sendResponse({ logs: state.consoleLogs[sender.tab?.id] || [] });
      return false;

    case "GET_NETWORK_CALLS":
      sendResponse({ calls: pruneNetworkEntries(sender.tab?.id) });
      return false;

    case "CLEAR_CONSOLE_LOGS":
      if (sender.tab?.id) {
        state.consoleLogs[sender.tab.id] = [];
      }
      sendResponse({ ok: true });
      return false;

    case "CLEAR_NETWORK_CALLS":
      if (sender.tab?.id) {
        state.networkClearCutoffs[sender.tab.id] = Date.now();
        state.networkCalls[sender.tab.id] = [];
        chrome.storage.session.set({
          wfNetworkCalls: state.networkCalls,
          wfNetworkClearCutoffs: state.networkClearCutoffs,
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;

    case "TOGGLE_CONSOLE_DIALOG":
      state.dialogState.consoleOpen = !state.dialogState.consoleOpen;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "TOGGLE_NETWORK_DIALOG":
      state.dialogState.networkOpen = !state.dialogState.networkOpen;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "CLOSE_CONSOLE_DIALOG":
      state.dialogState.consoleOpen = false;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "CLOSE_NETWORK_DIALOG":
      state.dialogState.networkOpen = false;
      broadcastDialogStateToActiveTab();
      sendResponse({ ok: true });
      return false;

    case "ADD_CONSOLE_CHECKPOINT":
      enqueueRecordingMutation(() => handleAddConsoleCheckpoint(
        msg.logEntry || msg.logMessage,
        msg.label,
        msg.contextBefore || [],
        msg.contextAfter || [],
        msg.checkpointId || null,
        msg.checkpointTimestamp || null,
        sendResponse,
      ));
      return true;

    case "ADD_NETWORK_CHECKPOINT":
      enqueueRecordingMutation(() => handleAddNetworkCheckpoint(
        msg.networkUrl,
        msg.networkMethod,
        msg.networkStatus,
        msg.networkStatusText || null,
        msg.networkRequestHeaders || null,
        msg.networkResponseHeaders || null,
        msg.networkRequestBody || null,
        msg.networkResponseBody || null,
        msg.label,
        msg.checkpointId || null,
        msg.checkpointTimestamp || null,
        sendResponse,
      ));
      return true;

    case "START_PLAYBACK":
      handleStartPlayback(msg.workflows, sendResponse);
      return true;

    case "PLAYBACK_DYNAMIC_UPDATE": {
      if (!state.dynamicBindingEnabled) {
        sendResponse({ ok: false, error: "Dynamic bindings are disabled in dashboard settings." });
        return false;
      }
      const runtime = state.dynamicRuntime;
      if (!runtime) {
        sendResponse({ ok: false, error: "No dynamic runtime is active." });
        return false;
      }
      if (
        msg.workflowQueueIndex != null &&
        Number.parseInt(msg.workflowQueueIndex, 10) !== Number.parseInt(runtime.workflowQueueIndex, 10)
      ) {
        sendResponse({ ok: false, error: "Dynamic runtime belongs to a different queued workflow." });
        return false;
      }
      const updates = isRecord(msg.overrides) ? msg.overrides : {};
      Object.entries(updates).forEach(([variableKey, value]) => {
        if (runtime.dynamicInputs.variables[variableKey]) {
          runtime.overrides[variableKey] = value;
        }
      });
      recomputeDynamicRuntime(runtime);
      broadcastDynamicState();
      sendResponse({ ok: true });
      return false;
    }

    case "PLAYBACK_RESUME":
      if (!state.dynamicBindingEnabled) {
        sendResponse({ ok: false, error: "Dynamic bindings are disabled in dashboard settings." });
        return false;
      }
      if (!state.dynamicPause) {
        sendResponse({ ok: false, error: "Playback is not paused for dynamic input." });
        return false;
      }
      clearDynamicPauseWithResult("resumed");
      broadcastDynamicState();
      sendResponse({ ok: true });
      return false;

    case "STOP_PLAYBACK":
      state.mode = "idle";
      state.workflowsToPlay = [];
      state.workflowToPlay = null;
      state.dynamicRuntime = null;
      clearDynamicPauseWithResult("aborted");
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab) chrome.tabs.sendMessage(tab.id, { type: 'PLAYBACK_HUD_HIDE' }).catch(() => {});
      }).catch(() => {});
      broadcastToPopup({ type: "PLAYBACK_STOPPED" });
      broadcastDynamicState();
      sendResponse({ mode: state.mode, eventCount: state.events.length });
      return false;

    case "GET_STATE":
      sendResponse({
        mode: state.mode,
        eventCount: state.events.length,
        dynamicState: dynamicStatePayload(),
      });
      return false;

    case "EXPORT_WORKFLOW":
      handleExportWorkflow(sendResponse);
      return true;

    default:
      sendResponse({ error: "Unknown message type" });
      return false;
  }
});

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * Begins a new recording session.
 *
 * Strategy:
 * Resets local state, updates storage to broadcast the flag globally, and then actively 
 * queries every open tab in the browser to inject and execute the recorder content script. 
 * This ensures even tabs that were open before the extension was installed can immediately 
 * participate in the recording.
 */
async function handleStartRecording(msg, sendResponse) {
  if (state.mode !== "idle") {
    sendResponse({ error: "Already in " + state.mode + " mode" });
    return;
  }

  resetState();
  state.mode = "recording";
  state.recordingTabId = msg.tabId ?? null;
  state.workflowName = msg.name || "";
  state.recordingSessionId = createRecordingSessionId();
  state.dialogState = { consoleOpen: false, networkOpen: false };

  // 1. Write wfMode="recording" to local storage.
  await setRecordingActive();
  await persistEvents();

  // 2. Ensure content scripts are injected and activated on all tabs.
  await activateRecorderOnAllTabs();

  sendResponse({ ok: true, mode: state.mode });
}

/**
 * Terminates the current recording session.
 *
 * Strategy:
 * Reverts the system to 'idle' mode. It triggers a global teardown by updating storage, 
 * but also explicitly messages all tabs to deactivate their DOM listeners. Finally, 
 * it packages all captured events and screenshots for the popup and asynchronously 
 * initiates an auto-save to the external dashboard.
 */
async function handleStopRecording(sendResponse) {
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  await hydrateRecordingStateFromStorage();
  await mergeBufferedCheckpointIntents();
  await persistEvents();
  const eventsSnapshot = JSON.parse(JSON.stringify(state.events || []));
  const checkpointsSnapshot = JSON.parse(JSON.stringify(state.recordingCheckpoints || []));
  const screenshotsSnapshot = JSON.parse(JSON.stringify(state.screenshots || {}));

  state.mode = "idle";

  await setRecordingIdle();
  await deactivateRecorderOnAllTabs();
  chrome.storage.session.remove("wfNetworkCalls").catch(() => {});
  chrome.storage.session.remove("wfNetworkClearCutoffs").catch(() => {});

  sendResponse({ ok: true, events: eventsSnapshot, screenshots: screenshotsSnapshot });

  // Auto-save to dashboard (fire-and-forget)
  saveToDashboard(eventsSnapshot, screenshotsSnapshot, checkpointsSnapshot)
    .then(() => {
      broadcastToPopup({ type: "DASHBOARD_SAVE_COMPLETE" });
    })
    .catch((e) => {
      console.warn('[WFRec] Dashboard save failed:', e);
      broadcastToPopup({
        type: "DASHBOARD_SAVE_FAILED",
        error: e?.message || "Failed to save workflow to dashboard",
      });
    });
}

/**
 * Restarts the current recording session.
 *
 * Strategy:
 * Clears the currently accumulated events and screenshots, keeping the active 
 * mode as 'recording' and maintaining the workflow name, so the user can start fresh.
 */
async function handleRestartRecording(sendResponse) {
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  state.events = [];
  state.recordingCheckpoints = [];
  state.screenshots = {};
  state.screenshotCount = 0;
  state.recordingSessionId = createRecordingSessionId();
  state.consoleLogs = {};
  state.networkCalls = {};
  state.networkClearCutoffs = {};
  state.dialogState = { consoleOpen: false, networkOpen: false };
  broadcastDialogStateToActiveTab();

  await setRecordingActive();
  await persistEvents();
  await chrome.storage.session.set({ wfNetworkCalls: {} }).catch(() => {});
  await chrome.storage.session.set({ wfNetworkClearCutoffs: {} }).catch(() => {});

  sendResponse({ ok: true });
}

/**
 * Discards the current recording session without saving.
 *
 * Strategy:
 * Reverts the system to 'idle' mode. Triggers a global teardown by updating storage, 
 * explicitly messaging all tabs to deactivate their DOM listeners, and skipping the 
 * dashboard save step.
 */
async function handleDiscardRecording(sendResponse) {
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  state.mode = "idle";
  state.workflowName = "";
  state.recordingSessionId = null;

  await setRecordingIdle();
  await deactivateRecorderOnAllTabs();
  chrome.storage.session.remove("wfNetworkCalls").catch(() => {});
  chrome.storage.session.remove("wfNetworkClearCutoffs").catch(() => {});

  sendResponse({ ok: true });
}

/**
 * Processes an incoming DOM event from a content script.
 *
 * Strategy:
 * Pushes the verified event to the in-memory array. Implementing a pacing mechanic, 
 * it strictly persists the array to `chrome.storage` every 5 events to balance I/O 
 * overhead with data safety against SW dormancy. Finally, it broadcasts the new count 
 * to refresh the Popup UI.
 *
 * @param {Object} event - The recorded DOM interaction event.
 */
function handleRecordEvent(event) {
  if (state.mode !== "recording") {
    return;
  }
  state.events.push(event);

  if (state.events.length % 5 === 0) persistEvents();

  broadcastToPopup({ type: "EVENT_RECORDED", count: state.events.length });
}

/**
 * Helper to capture a screenshot without the extension's UI bleeding into it.
 * Temporarily hides the recorder HUD, player HUD, and logs dialogs, waits for DOM paint,
 * and restores them immediately after capturing the snapshot.
 */
async function captureCleanScreenshot(tab) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const overlays = [
          document.getElementById("__workflow_rec_indicator__"),
          document.getElementById("__workflow_player_hud__"),
          document.getElementById("__wf_console_dialog__"),
          document.getElementById("__wf_network_dialog__")
        ];
        window.__wf_hidden_overlays = overlays.map(el => el ? el.style.display : null);
        overlays.forEach(el => { if (el) el.style.display = 'none'; });
      }
    });
    // Wait for the DOM composite/paint to reflect the hidden display state
    await new Promise(r => setTimeout(r, 60));
  } catch (_) {}

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const overlays = [
          document.getElementById("__workflow_rec_indicator__"),
          document.getElementById("__workflow_player_hud__"),
          document.getElementById("__wf_console_dialog__"),
          document.getElementById("__wf_network_dialog__")
        ];
        overlays.forEach((el, i) => { if (el) el.style.display = window.__wf_hidden_overlays?.[i] || ''; });
      }
    });
  } catch (_) {}

  return dataUrl;
}

/**
 * Captures a visual checkpoint of the active tab.
 *
 * Strategy:
 * Validates the active tab, invokes `captureCleanScreenshot` to generate a base64 
 * image, and appends a specialized 'checkpoint' event to the events array. It immediately 
 * persists to storage because checkpoints are critical, high-value data points.
 *
 * @param {string} label - Human-readable name for the checkpoint.
 * @param {Function} sendResponse - Callback to resolve the extension message.
 */
async function handleAddCheckpoint(label, sendResponse) {
  await readyPromise;
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendResponse({ error: "No active tab" });
    return;
  }

  try {
    const dataUrl = await captureCleanScreenshot(tab);
    const index = state.screenshotCount++;
    state.screenshots[index] = dataUrl;

    const checkpointEvent = {
      type: "checkpoint",
      checkpointId: createRecordingSessionId(),
      label: label || `Checkpoint ${index + 1}`,
      screenshotIndex: index,
      url: tab.url,
      timestamp: Date.now(),
    };
    await appendCheckpointToRecordingState(checkpointEvent);

    broadcastToPopup({
      type: "CHECKPOINT_ADDED",
      index,
      label: checkpointEvent.label,
      screenshotDataUrl: dataUrl,
    });

    sendResponse({ ok: true, index, label: checkpointEvent.label });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

/**
 * Records a console-log-based checkpoint.
 *
 * Strategy:
 * Creates a specialized checkpoint event whose trigger condition is a console.log
 * message that matches `logMessage` (substring). During playback the service worker
 * will inject a MAIN-world watcher that resolves when that message appears.
 *
 * @param {string} logMessage - The console message substring to watch for.
 * @param {string} label - Human-readable name shown in the UI.
 * @param {Function} sendResponse
 */
async function handleAddConsoleCheckpoint(logEntryOrMessage, label, contextBefore, contextAfter, checkpointId, checkpointTimestamp, sendResponse) {
  await readyPromise;
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendResponse({ error: "No active tab" });
    return;
  }

  try {
    const selectedEntry = typeof logEntryOrMessage === "string"
      ? { message: logEntryOrMessage, level: "log", timestamp: Date.now(), url: tab.url }
      : (logEntryOrMessage || {});
    const logMessage = selectedEntry.message || "";
    const autoLabel = label || `Console: ${logMessage.slice(0, 40)}`;
    const checkpointEvent = {
      type: "console_checkpoint",
      checkpointId: checkpointId || createRecordingSessionId(),
      label: autoLabel,
      logMessage,
      logLevel: selectedEntry.level || "log",
      logTimestamp: selectedEntry.timestamp || Date.now(),
      logUrl: selectedEntry.url || tab.url,
      logContextBefore: Array.isArray(contextBefore) ? contextBefore.slice(-1) : [],
      logContextAfter: Array.isArray(contextAfter) ? contextAfter.slice(0, 1) : [],
      url: tab.url,
      timestamp: checkpointTimestamp || Date.now(),
    };
    await appendCheckpointToRecordingState(checkpointEvent);

    broadcastToPopup({ type: "CONSOLE_CHECKPOINT_ADDED", label: autoLabel });
    sendResponse({ ok: true, label: autoLabel, checkpointId: checkpointEvent.checkpointId });
  } catch (err) {
    sendResponse({ error: err?.message || "Failed to add console checkpoint" });
  }
}

/**
 * Records a network-call-based checkpoint.
 *
 * Strategy:
 * Creates a checkpoint event whose trigger condition is a network request matching
 * the given URL pattern and HTTP method. During playback the service worker injects
 * a MAIN-world fetch/XHR watcher that resolves when a matching call completes.
 *
 * @param {string} networkUrl - URL substring to match.
 * @param {string} networkMethod - HTTP method (e.g. "GET", "POST").
 * @param {number} networkStatus - HTTP status code captured during recording.
 * @param {string} label - Human-readable name.
 * @param {Function} sendResponse
 */
async function handleAddNetworkCheckpoint(networkUrl, networkMethod, networkStatus, networkStatusText, networkRequestHeaders, networkResponseHeaders, networkRequestBody, networkResponseBody, label, checkpointId, checkpointTimestamp, sendResponse) {
  await readyPromise;
  if (state.mode !== "recording") {
    sendResponse({ error: "Not recording" });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    sendResponse({ error: "No active tab" });
    return;
  }

  try {
    const autoLabel = label || `Network: ${networkMethod} ${(networkUrl || "").slice(0, 35)}`;
    const checkpointEvent = {
      type: "network_checkpoint",
      checkpointId: checkpointId || createRecordingSessionId(),
      label: autoLabel,
      networkUrl,
      networkMethod,
      networkStatus,
      networkStatusText: networkStatusText || null,
      networkRequestHeaders: networkRequestHeaders || null,
      networkResponseHeaders: networkResponseHeaders || null,
      networkRequestBody: networkRequestBody || null,
      networkResponseBody: networkResponseBody || null,
      url: tab.url,
      timestamp: checkpointTimestamp || Date.now(),
    };
    await appendCheckpointToRecordingState(checkpointEvent);

    broadcastToPopup({ type: "NETWORK_CHECKPOINT_ADDED", label: autoLabel });
    sendResponse({ ok: true, label: autoLabel, checkpointId: checkpointEvent.checkpointId });
  } catch (err) {
    sendResponse({ error: err?.message || "Failed to add network checkpoint" });
  }
}

// ─── Activate / deactivate recorder on all open tabs ─────────────────────────

/**
 * Broadcasts recorder activation to all open tabs.
 *
 * Strategy:
 * Queries all tabs and executes `activateTabRecorder` concurrently via `Promise.allSettled`, 
 * which guarantees that a failure on standard restricted URLs (like chrome:// settings pages) 
 * won't throw an unhandled rejection that blocks injection on valid web pages.
 */
async function activateRecorderOnAllTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const results = await Promise.allSettled(
    tabs.map(tab => activateTabRecorder(tab.id, "start"))
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn("[WorkflowRec] Could not activate tab", tabs[i]?.id, r.reason?.message);
    }
  });
}

/**
 * Broadcasts recorder deactivation to all open tabs.
 *
 * Strategy:
 * Queries every tab and calls `activateTabRecorder(tabId, "stop")` in parallel via
 * `Promise.allSettled` so restricted URLs do not block cleanup on normal pages.
 */
async function deactivateRecorderOnAllTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled(tabs.map(tab => activateTabRecorder(tab.id, "stop")));
}

/**
 * Syncs the global dialog state (which log dialog is open) to the currently active tab.
 */
async function broadcastDialogStateToActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "SYNC_DIALOG_STATE",
        consoleOpen: state.dialogState.consoleOpen,
        networkOpen: state.dialogState.networkOpen
      }).catch(() => {});
    }
  } catch (e) {}
}

/**
 * Connects a specific tab to the recording loop.
 *
 * Strategy:
 * Employs a belt-and-suspenders methodology. First, it forces script injection via `chrome.scripting`. 
 * Even if the script is already there, it's necessary in case the context is stale. Following 
 * a brief initialization delay, it blasts a direct message to the tab to engage the listeners.
 *
 * @param {number} tabId - Target tab ID.
 * @param {string} action - 'start' or 'stop'.
 */
async function activateTabRecorder(tabId, action) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/recorder.js", "content/logs-dialog.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content/logs-dialog.css"],
    });
  } catch (err) {
    return;
  }

  if (action === "start") {
    // Activate the isolated-world listener before patching the MAIN world so that
    // isRecording is true before __wfRecording is set to true. This closes the race
    // window where network calls could be posted by the interceptor before recorder.js
    // is ready to forward them.
    try {
      await chrome.tabs.sendMessage(tabId, { type: "RECORDER_START" });
    } catch (err) {
      // Expected on restricted pages
    }

    // Inject page-interceptor.js into the MAIN world so it can patch console.log,
    // fetch, and XHR on the page itself (invisible to the ISOLATED content script).
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/page-interceptor.js"],
        world: "MAIN",
      });
    } catch (_) {
      // Restricted pages (chrome://, extensions) will silently fail — that's fine.
    }
  } else {
    // Flip the recording flag in MAIN world so ongoing interceptors stop posting.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => { window.__wfRecording = false; },
      });
    } catch (_) {}

    await new Promise(r => setTimeout(r, 100));

    try {
      await chrome.tabs.sendMessage(tabId, { type: "RECORDER_STOP" });
    } catch (err) {
      // Expected on restricted pages
    }
  }

  if (action === "start") {
    // Determine if this is the active tab and trigger its dialog if it should be open
    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs.length && activeTabs[0].id === tabId) {
        broadcastDialogStateToActiveTab();
      }
    } catch (_) {}
  }
}

// ─── Network capture via webRequest ──────────────────────────────────────────

/**
 * Stores a captured network call in the worker cache and streams it to the network dialog.
 *
 * Strategy:
 * Called from both onCompleted and onErrorOccurred webRequest listeners. Waits
 * for readyPromise so state.mode is accurate even after a SW restart. Persists to
 * session storage on every write so data survives SW dormancy, and emits
 * NETWORK_CALL_LIVE updates for the network dialog.
 */
function recordNetworkCall(tabId, call) {
  readyPromise.then(() => {
    if (state.mode !== "recording") return;
    if (!tabId || tabId < 0) return;
    if (isStaleNetworkEntry(tabId, call)) return;
    const mergedCall = upsertRecordedNetworkCall(tabId, call);
    chrome.storage.session.set({ wfNetworkCalls: state.networkCalls }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "NETWORK_CALL_LIVE", call: mergedCall }).catch(() => {});
  });
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    recordNetworkCall(details.tabId, {
      url: details.url,
      method: details.method,
      status: details.statusCode,
      timestamp: details.timeStamp,
    });
  },
  { urls: ["*://*/*", "http://*/*", "https://*/*", "<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    recordNetworkCall(details.tabId, {
      url: details.url,
      method: details.method,
      status: 0,
      timestamp: details.timeStamp,
    });
  },
  { urls: ["*://*/*", "http://*/*", "https://*/*", "<all_urls>"] }
);

// ─── Tab switch tracking ──────────────────────────────────────────────────────

/**
 * On Tab Switch listener
 *
 * Strategy:
 * Intercepts when the user clicks between Chrome tabs. If recording, it logs a specialized 
 * 'tab_switch' event ensuring playback knows when to navigate. It immediately triggers injection/activation 
 * on the new tab, guaranteeing the tab is primed to capture the very next click.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state.mode !== "recording") return;

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    state.events.push({
      type: "tab_switch",
      tabId: activeInfo.tabId,
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
    });
    broadcastToPopup({ type: "EVENT_RECORDED", count: state.events.length });

    await activateTabRecorder(activeInfo.tabId, "start");
  } catch (_) {}
});

/**
 * On Tab Updated listener
 *
 * Strategy:
 * Captures standard page loads and SPAs. Whenever a tab finishes loading (`changeInfo.status === "complete"`),
 * the original injected script content is purged by the browser. This listener detects that purge and 
 * synchronously reactivates the recorder to resume tracking.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (state.mode !== "recording") return;
  if (changeInfo.status !== "complete") return;

  await activateTabRecorder(tabId, "start");
});

/**
 * On Frame Navigation listener
 *
 * Strategy:
 * Specifically targets top-level (frameId 0) hard reloads or URL bar commits. It logs a 'reload' 
 * event so the playback sequence knows it must explicitly refresh the page to maintain an accurate DOM state.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (state.mode !== "recording") return;
  if (details.frameId !== 0) return;
  if (details.transitionType === "reload") {
     state.events.push({
       type: "reload",
       url: details.url,
       timestamp: Date.now()
     });
     persistEvents();
     broadcastToPopup({ type: "EVENT_RECORDED", count: state.events.length });
  }
});

// ─── Playback ─────────────────────────────────────────────────────────────────

function getWorkflowLoopCount(workflow) {
  const raw = Number.parseInt(workflow?.loopCount, 10);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(99, raw);
}

function getWorkflowDisplayName(workflow) {
  const baseName = workflow?.name || "workflow";
  const loopCount = Number.parseInt(workflow?._loopCount, 10) || 1;
  const loopIteration = Number.parseInt(workflow?._loopIteration, 10) || 1;
  return loopCount > 1 ? `${baseName} (${loopIteration}/${loopCount})` : baseName;
}

function getWorkflowStartUrl(workflow) {
  const events = Array.isArray(workflow?.events) ? workflow.events : [];
  for (const event of events) {
    if (typeof event?.url === "string" && event.url) {
      return event.url;
    }
  }
  return null;
}

async function primePlaybackTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/player.js"]
    });
  } catch (e) {
    console.warn("Could not inject player.js for loop iteration:", e);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/playback-capture.js"],
      world: "MAIN",
    });
  } catch (_) {}
}

async function prepareWorkflowLoopIteration(workflow, loopIndex) {
  if (loopIndex === 0) return;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  const startUrl = getWorkflowStartUrl(workflow);
  if (startUrl && activeTab.url !== startUrl) {
    await chrome.tabs.update(activeTab.id, { url: startUrl });
    await waitForTabLoad(activeTab.id);
    await sleep(800);
  }

  await primePlaybackTab(activeTab.id);
}

/**
 * Initializes the playback sequence across a queue of workflows.
 *
 * Strategy:
 * Validates the queue, sets up internal memory tracking for screenshots/progress, and switches mode 
 * to 'playing'. Passes execution immediately to `runPlaybackQueue()` allowing the async loops to process 
 * independently.
 */
async function handleStartPlayback(workflows, sendResponse) {
  if (state.mode !== "idle") {
    sendResponse({ error: "Already in " + state.mode + " mode" });
    return;
  }
  if (!Array.isArray(workflows) || workflows.length === 0) {
    sendResponse({ error: "Invalid workflow queue" });
    return;
  }

  state.mode = "playing";
  const config = await chrome.storage.local.get(["playBufferSeconds", "dynamicBindingEnabled"]);
  state.dynamicBindingEnabled = normalizeDynamicBindingEnabled(config.dynamicBindingEnabled);
  state.workflowsToPlay = workflows.map((workflow) => ({
    ...workflow,
    loopCount: getWorkflowLoopCount(workflow),
    dynamicInputs: state.dynamicBindingEnabled
      ? normalizeDynamicInputs(workflow?.dynamicInputs)
      : null,
  }));
  state.playbackIndex = 0;
  state.screenshots = {};
  state.screenshotCount = 0;
  state.dynamicRuntime = null;
  clearDynamicPauseWithResult("aborted");

  state.playBufferMs = (config.playBufferSeconds !== undefined ? parseInt(config.playBufferSeconds) : 8) * 1000;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.playbackTabId = tab?.id ?? null;

  // Inject player.js dynamically into the active tab to ensure the HUD is ready,
  // especially if the extension was just reloaded and the tab's old context is dead.
  if (state.playbackTabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.playbackTabId },
        files: ["content/player.js"]
      });
    } catch (e) {}

    // Inject the playback capture accumulator into MAIN world BEFORE any steps run.
    // This ensures console logs and network calls fired by step-1's actions are already
    // captured in window.__wfPlayLogs / window.__wfPlayNet when later checkpoint steps run.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.playbackTabId },
        files: ["content/playback-capture.js"],
        world: "MAIN",
      });
    } catch (e) {}
  }

  sendResponse({ ok: true });
  broadcastDynamicState();
  runPlaybackQueue();
}

/**
 * Iterates through the queue of queued workflows.
 *
 * Strategy:
 * Executes each workflow fully sequentially via `runSinglePlayback()`. When the loop terminates (either 
 * gracefully or via user stop), resets the state to 'idle', clears the HUD from the active tab, and signals 
 * completion to the popup UI.
 */
async function runPlaybackQueue() {
  let anyFailed = false;
  for (let q = 0; q < state.workflowsToPlay.length; q++) {
    const workflow = state.workflowsToPlay[q];
    const loopCount = getWorkflowLoopCount(workflow);

    for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
      await prepareWorkflowLoopIteration(workflow, loopIndex);
      state.workflowToPlay = {
        ...workflow,
        _loopIteration: loopIndex + 1,
        _loopCount: loopCount,
      };
      state.dynamicRuntime = state.dynamicBindingEnabled
        ? buildDynamicRuntime(workflow, q, loopIndex)
        : null;
      recomputeDynamicRuntime(state.dynamicRuntime);
      await broadcastDynamicState();
      if (state.mode !== "playing") break;
      const runStatus = await runSinglePlayback();
      // Stop the queue on first failure — subsequent workflows would be meaningless.
      if (runStatus === "failed") {
        anyFailed = true;
        break;
      }
    }

    if (state.mode !== "playing" || anyFailed) {
      break;
    }
  }
  
  if (state.mode === "playing") {
    state.mode = "idle";
    state.dynamicRuntime = null;
    clearDynamicPauseWithResult("aborted");
    if (!anyFailed) {
      try {
        const [finalTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (finalTab) chrome.tabs.sendMessage(finalTab.id, { type: 'PLAYBACK_HUD_HIDE' }).catch(() => {});
      } catch (_) {}
      // Only tell the popup the queue finished cleanly when nothing failed.
      // WORKFLOW_PLAYBACK_FAILED was already broadcast for the failing workflow,
      // so the popup already knows — sending QUEUE_COMPLETE on top would overwrite
      // the error state with a false-success message.
      broadcastToPopup({ type: 'QUEUE_COMPLETE' });
    }
  }
  broadcastDynamicState();
}

/**
 * Replays a single recorded workflow's events.
 *
 * Strategy:
 * Iterates over the chronologically sorted event array. For each event, it updates the visual HUD on 
 * the active tab and dispatches the action via `dispatchPlaybackEvent`. It intentionally respects the 
 * recorded time deltas between events (capped at 3 seconds) to emulate human behavior and give SPAs 
 * enough time to resolve async state changes before the next click. Upon completion, uploads the 
 * run's telemetry to the dashboard.
 */
async function runSinglePlayback() {
  const workflow = state.workflowToPlay;
  if (!workflow) return "aborted";
  const workflowName = getWorkflowDisplayName(workflow);

  const events = workflow.events;
  const results = { checkpoints: {} };
  let runStatus = "passed";
  let failedStep = null;

  for (let i = 0; i < events.length; i++) {
    if (state.mode !== "playing") {
      runStatus = "aborted";
      break;
    }

    const event = events[i];
    let eventToDispatch = event;
    if (state.dynamicBindingEnabled && state.dynamicRuntime) {
      while (state.mode === "playing") {
        const binding = state.dynamicRuntime.bindingsByEventIndex?.[i];
        if (!binding) break;
        const variable = state.dynamicRuntime.dynamicInputs.variables?.[binding.variableKey];
        if (!variable) {
          const pauseResult = await waitForDynamicResume({
            reason: "missing_variable",
            message: `Dynamic variable "${binding.variableKey}" is missing for event #${i + 1}.`,
            eventIndex: i,
            variableKey: binding.variableKey,
          });
          if (pauseResult !== "resumed") {
            runStatus = "aborted";
          }
          recomputeDynamicRuntime(state.dynamicRuntime);
          await broadcastDynamicState();
          continue;
        }

        const resolved = resolveDynamicVariableValue(
          variable,
          state.dynamicRuntime.loopIndex,
          state.dynamicRuntime.overrides?.[binding.variableKey]
        );

        if (!resolved.ok) {
          const pauseResult = await waitForDynamicResume({
            reason: resolved.reason || "dynamic_resolution_failed",
            message: resolved.message || "Could not resolve dynamic value.",
            eventIndex: i,
            variableKey: binding.variableKey,
          });
          if (pauseResult !== "resumed") {
            runStatus = "aborted";
            break;
          }
          recomputeDynamicRuntime(state.dynamicRuntime);
          await broadcastDynamicState();
          continue;
        }

        if (event.type === "input" || event.type === "change") {
          eventToDispatch = {
            ...event,
            selector: binding.selector || event.selector || null,
            value: resolved.value,
            _dynamicValue: true,
            _dynamicVariableKey: binding.variableKey,
          };
        } else if (event.type === "click" && variable.kind === "date_range") {
          eventToDispatch = {
            ...event,
            type: "input",
            selector: binding.selector || event.selector || null,
            value: resolved.value,
            _dynamicValue: true,
            _dynamicVariableKey: binding.variableKey,
            _dynamicFromClick: true,
            _dynamicOpenDatePickerSequence: true,
          };
        } else {
          eventToDispatch = {
            ...event,
            selector: binding.selector || event.selector || null,
            value: resolved.value,
            _dynamicValue: true,
            _dynamicVariableKey: binding.variableKey,
          };
        }
        state.dynamicRuntime.resolvedValues[binding.variableKey] = resolved.value;
        delete state.dynamicRuntime.errors[binding.variableKey];
        await broadcastDynamicState();
        break;
      }

      if (runStatus === "aborted") {
        break;
      }
    }
    const nextEvent = events[i + 1];

    if (
      state.dynamicRuntime?.syntheticDatePickerOpen &&
      event.type === "click" &&
      !eventToDispatch?._dynamicFromClick
    ) {
      const selector = typeof event.selector === "string" ? event.selector : "";
      const isDatePickerInternal = /daterangepicker|calendar|applyBtn|cancelBtn|table-condensed/i.test(selector);
      if (isDatePickerInternal) {
        if (/applyBtn|cancelBtn/i.test(selector)) {
          state.dynamicRuntime.syntheticDatePickerOpen = false;
        }
        continue;
      }
      state.dynamicRuntime.syntheticDatePickerOpen = false;
    }

    broadcastToPopup({ type: "PLAYBACK_PROGRESS", index: i, total: events.length, event: eventToDispatch });

    const label = event.type === "checkpoint"
      ? `Screenshot: ${event.label}`
      : event.type === "console_checkpoint"
      ? `Console: ${event.label}`
      : event.type === "network_checkpoint"
      ? `Network: ${event.label}`
      : `Step ${i + 1}/${events.length}: ${event.type}${event.selector ? " — " + event.selector.slice(0, 40) : ""}`;

    try {
      const [hudTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (hudTab) {
        if (event.type === "tab_switch") {
          chrome.tabs.sendMessage(hudTab.id, { type: "PLAYBACK_HUD_HIDE" }).catch(() => {});
        } else {
          chrome.tabs.sendMessage(hudTab.id, {
            type: "PLAYBACK_HUD_UPDATE",
            label,
            progress: i + 1,
            total: events.length,
          }).catch(() => {});
        }
      }
    } catch (_) {}

    let dispatchResult = { ok: true };
    try {
      dispatchResult = await dispatchPlaybackEvent(eventToDispatch, results, {
        label,
        progress: i + 1,
        total: events.length
      });
    } catch (err) {
      dispatchResult = { ok: false, reason: "exception" };
      console.warn("Error dispatching playback event:", event.type, err);
    }

    if (!dispatchResult.ok) {
      runStatus = "failed";
      failedStep = {
        index: i,
        type: event.type,
        selector: event.selector || null,
        reason: dispatchResult.reason || "unknown",
      };
      broadcastToPopup({
        type: "WORKFLOW_PLAYBACK_FAILED",
        name: workflowName,
        failedStep,
      });

      try {
        const [hudTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (hudTab) {
          chrome.tabs.sendMessage(hudTab.id, {
            type: "PLAYBACK_HUD_FAIL",
            reason: `Action failed: ${dispatchResult.reason || "unknown error"}`
          }).catch(() => {});
        }
      } catch (_) {}

      break;
    }

    if (state.dynamicRuntime && eventToDispatch?._dynamicOpenDatePickerSequence) {
      state.dynamicRuntime.syntheticDatePickerOpen = true;
    }

    if (nextEvent && event.timestamp && nextEvent.timestamp) {
      const delta = Math.min(nextEvent.timestamp - event.timestamp, 3000);
      if (delta > 50) await sleep(delta);
    } else {
      await sleep(200);
    }
  }

  const playedAt = Date.now();

  if (runStatus === "passed") {
    broadcastToPopup({ type: "WORKFLOW_PLAYBACK_COMPLETE", name: workflowName });
  }

  if (workflow._dashboardId && runStatus !== "aborted") {
    saveRunToDashboard(
      workflow._dashboardId,
      workflow.events || [],
      results.checkpoints,
      playedAt,
      runStatus,
      failedStep,
    ).catch(e => console.warn("[WFRec] Playback run save failed:", e));
  }

  return runStatus;
}

// ─── Dashboard sync helpers ───────────────────────────────────────────────────

async function getDashboardAuthToken() {
  const stored = await chrome.storage.local.get([DASHBOARD_AUTH_TOKEN_KEY]);
  const token = stored?.[DASHBOARD_AUTH_TOKEN_KEY];
  return typeof token === 'string' && token.trim() ? token : null;
}

async function getDashboardRequestHeaders(includeJson = true) {
  const token = await getDashboardAuthToken();
  if (!token) {
    throw new Error('Sign in from the extension popup first.');
  }

  const headers = new Headers();
  headers.set('X-Extension', 'true');
  headers.set('Authorization', `Bearer ${token}`);
  if (includeJson) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

/**
 * Saves a completed recording to the remote Dashboard.
 *
 * Strategy:
 * Packages the array of events and maps out screenshot data into a unified JSON blob, dispatching it to 
 * the `DASHBOARD_URL` via POST. It records the newly minted remote ID on the local workflow instance 
 * to correlate future playback runs to this master template.
 */
async function saveToDashboard(events, screenshots, checkpointsOverride = null) {
  const headers = await getDashboardRequestHeaders();
  const name = state.workflowName || ('recorded-workflow-' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  const screenshotMap = {};
  const checkpointSource = Array.isArray(checkpointsOverride) && checkpointsOverride.length > 0
    ? checkpointsOverride
    : (Array.isArray(events)
      ? events
        .filter((event) =>
          event?.type === "checkpoint" ||
          event?.type === "console_checkpoint" ||
          event?.type === "network_checkpoint"
        )
      : []);
  const checkpoints = checkpointSource.map((event, index) => ({
          index,
          checkpointId: event.checkpointId ?? null,
          type: event.type,
          label: event.label || null,
          url: event.url || null,
          timestamp: event.timestamp || null,
          screenshotIndex: event.screenshotIndex ?? null,
          logMessage: event.logMessage ?? null,
          logLevel: event.logLevel ?? null,
          logTimestamp: event.logTimestamp ?? null,
          logUrl: event.logUrl ?? null,
          logContextBefore: event.logContextBefore ?? [],
          logContextAfter: event.logContextAfter ?? [],
          networkUrl: event.networkUrl ?? null,
          networkMethod: event.networkMethod ?? null,
          networkStatus: event.networkStatus ?? null,
          networkStatusText: event.networkStatusText ?? null,
          networkRequestHeaders: event.networkRequestHeaders ?? null,
          networkResponseHeaders: event.networkResponseHeaders ?? null,
          networkRequestBody: event.networkRequestBody ?? null,
          networkResponseBody: event.networkResponseBody ?? null,
        }));
  if (screenshots) {
    for (const [k, v] of Object.entries(screenshots)) {
      screenshotMap[k] = v;
    }
  }
  const res = await fetch(`${DASHBOARD_URL}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, events, screenshots: screenshotMap, checkpoints }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (state.workflowToPlay) state.workflowToPlay._dashboardId = data.id;
  return data.id;
}

/**
 * Saves a completed playback run (execution) to the remote Dashboard.
 *
 * Strategy:
 * Bundles the checkpoints validated during the automated run and posts them against the `workflowId` 
 * to serve as proof-of-work/QA artifacts on the dashboard.
 */
async function saveRunToDashboard(workflowId, events, checkpointsByIndex, playedAt, status = 'passed', failedStep = null) {
  const headers = await getDashboardRequestHeaders();
  // Derive labels from the actual checkpoint events so the run reflects what was recorded.
  const checkpointEvents = (events || []).filter(e =>
    e.type === 'checkpoint' || e.type === 'console_checkpoint' || e.type === 'network_checkpoint'
  );
  const checkpoints = {};
  for (const [k, entry] of Object.entries(checkpointsByIndex || {})) {
    const cp = checkpointEvents[parseInt(k)];
    const checkpointType =
      entry?.checkpointType ||
      (cp?.type === "console_checkpoint" ? "console" :
      cp?.type === "network_checkpoint" ? "network" : "screenshot");
    checkpoints[k] = {
      dataUrl: entry?.dataUrl ?? null,
      label: entry?.label ?? cp?.label ?? `Checkpoint ${parseInt(k) + 1}`,
      checkpointType,
      capturedData: entry?.capturedData ?? null,
    };
  }
  const body = {
    workflowId,
    playedAt,
    checkpoints,
    status,
    failedEventIndex: failedStep?.index ?? null,
    failedEventType: failedStep?.type ?? null,
    failedEventSelector: failedStep?.selector ?? null,
  };
  const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.id;
}

/**
 * Routes individual playback events to the correct execution layer.
 *
 * Strategy:
 * Distinguishes between browser-level events (tabs switching, reloading) and page-level DOM events. 
 * Browser events invoke standard Chrome extension APIs. DOM events (clicks, inputs) inject `replayEventInPage` 
 * directly into the target tab's execution context. Checkpoint events halt playback briefly to snap and 
 * store a fresh screenshot before pinging the UI to flash.
 *
 * @param {Object} event - The single event to execute.
 * @param {Object} results - Accumulator for the session's generated metadata (screenshots).
 */
async function dispatchPlaybackEvent(event, results, meta) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  switch (event.type) {
    case "click":
    case "right_click":
    case "long_press":
    case "toggle":
    case "scroll":
    case "keydown":
    case "input":
    case "change": {
      if (!activeTab) return { ok: false, reason: "no_active_tab" };
      try {
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: replayEventInPage,
          args: [event, state.playBufferMs || 8000],
        });
        const result = injectionResults?.[0]?.result;
        if (result && result.ok === false) {
          return { ok: false, reason: result.reason ?? "element_not_found" };
        }
      } catch (err) {
        return { ok: false, reason: "script_error" };
      }
      return { ok: true };
    }

    case "tab_switch":
      try {
        await handlePlaybackTabSwitch(event, meta);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err.message || "tab_switch_failed" };
      }

    case "reload":
      if (activeTab) {
        await chrome.tabs.reload(activeTab.id);
        await waitForTabLoad(activeTab.id);
        await sleep(800);
      }
      return { ok: true };

    case "checkpoint": {
      await sleep(300);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        try {
          const dataUrl = await captureCleanScreenshot(tab);
          const idx = state.screenshotCount++;
          results.checkpoints[idx] = {
            label: event.label,
            checkpointType: "screenshot",
            dataUrl,
            capturedData: null,
          };
          state.screenshots[idx] = dataUrl;
          broadcastToPopup({
            type: "CHECKPOINT_REACHED",
            index: idx,
            label: event.label,
            screenshotDataUrl: dataUrl,
          });
          chrome.tabs.sendMessage(tab.id, { type: "PLAYBACK_CHECKPOINT_FLASH", label: event.label }).catch(() => {});
        } catch (err) {}
      }
      return { ok: true };
    }

    case "console_checkpoint": {
      const [cpTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!cpTab) return { ok: true }; // soft-pass if no tab

      // Notify HUD we are checking for this log.
      chrome.tabs.sendMessage(cpTab.id, {
        type: "PLAYBACK_WAITING_CHECKPOINT",
        checkpointType: "console",
        label: event.label,
        detail: event.logMessage,
      }).catch(() => {});

      let matchedEntry = null;
      try {
        // Strategy: First check the retroactive buffer (window.__wfPlayLogs) accumulated
        // since playback start. If the message was already logged by an earlier action,
        // we find it immediately instead of timing out waiting for a future event.
        const found = await chrome.scripting.executeScript({
          target: { tabId: cpTab.id },
          world: "MAIN",
          func: (targetMsg, timeoutMs) => {
            function snapshotForIndex(logs, idx) {
              if (idx < 0 || idx >= logs.length) return null;
              return {
                entry: logs[idx] || null,
                before: idx > 0 ? [logs[idx - 1]] : [],
                after: idx < logs.length - 1 ? [logs[idx + 1]] : [],
              };
            }

            // 1. Retroactive check — did this log appear before this checkpoint step?
            const logs = window.__wfPlayLogs || [];
            const matchIndex = logs.findIndex(e => e.message && e.message.includes(targetMsg));
            if (matchIndex >= 0) return snapshotForIndex(logs, matchIndex);

            // 2. Live watcher — wait for a future matching event (short window).
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                window.removeEventListener("__wf_log_capture__", handler);
                resolve(null);
              }, timeoutMs);
              function handler(ev) {
                if (ev.detail && ev.detail.message && ev.detail.message.includes(targetMsg)) {
                  clearTimeout(timer);
                  window.removeEventListener("__wf_log_capture__", handler);
                  const nextLogs = window.__wfPlayLogs || [];
                  const nextIndex = nextLogs.findIndex((entry) =>
                    entry &&
                    entry.timestamp === ev.detail.timestamp &&
                    entry.message === ev.detail.message
                  );
                  resolve(snapshotForIndex(nextLogs, nextIndex >= 0 ? nextIndex : nextLogs.length - 1));
                }
              }
              window.addEventListener("__wf_log_capture__", handler);
            });
          },
          args: [event.logMessage, Math.min(state.playBufferMs || 8000, 5000)],
        });

        matchedEntry = found?.[0]?.result || null;
        if (!matchedEntry) {
          // L2: Gate behind __DEBUG__ — event.logMessage is user-sourced page content.
          debug("[WFPlay] console_checkpoint not matched:", event.logMessage);
          // Soft-pass: do not fail the workflow for a missed log checkpoint —
          // take the screenshot anyway so the run has some evidence.
        }
      } catch (err) {
        console.warn("[WFPlay] console_checkpoint error:", err);
      }

      const idx = state.screenshotCount++;
      results.checkpoints[idx] = {
        label: event.label,
        checkpointType: "console",
        dataUrl: null,
        capturedData: JSON.stringify({
          matched: !!matchedEntry?.entry,
          expectedMessage: event.logMessage ?? null,
          expectedLevel: event.logLevel ?? null,
          expectedUrl: event.logUrl ?? null,
          expectedTimestamp: event.logTimestamp ?? null,
          expectedContextBefore: event.logContextBefore ?? [],
          expectedContextAfter: event.logContextAfter ?? [],
          capturedMessage: matchedEntry?.entry?.message ?? null,
          capturedLevel: matchedEntry?.entry?.level ?? null,
          capturedUrl: matchedEntry?.entry?.url ?? null,
          capturedTimestamp: matchedEntry?.entry?.timestamp ?? null,
          capturedContextBefore: matchedEntry?.before ?? [],
          capturedContextAfter: matchedEntry?.after ?? [],
        }),
      };
      broadcastToPopup({ type: "CHECKPOINT_REACHED", index: idx, label: event.label, checkpointType: "console" });
      chrome.tabs.sendMessage(cpTab.id, { type: "PLAYBACK_CHECKPOINT_FLASH", label: event.label }).catch(() => {});

      return { ok: true };
    }

    case "network_checkpoint": {
      const [netTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!netTab) return { ok: true };

      // Notify HUD we are checking for this network call.
      chrome.tabs.sendMessage(netTab.id, {
        type: "PLAYBACK_WAITING_CHECKPOINT",
        checkpointType: "network",
        label: event.label,
        detail: `${event.networkMethod} ${event.networkUrl}`,
      }).catch(() => {});

      let matchedCall = null;
      try {
        // Strategy: First check window.__wfPlayNet for calls already captured before
        // this checkpoint step. Only arm a live watcher if not yet found.
        const found = await chrome.scripting.executeScript({
          target: { tabId: netTab.id },
          world: "MAIN",
          func: (targetUrl, targetMethod, timeoutMs) => {
            function normalizeUrl(url) {
              try {
                const parsed = new URL(url, window.location.href);
                const pathname = parsed.pathname.length > 1
                  ? parsed.pathname.replace(/\/+$/, "")
                  : parsed.pathname;
                return {
                  href: parsed.href,
                  origin: parsed.origin,
                  pathname,
                  search: parsed.search,
                };
              } catch (_) {
                const text = String(url || "");
                return {
                  href: text,
                  origin: "",
                  pathname: text,
                  search: "",
                };
              }
            }

            function isNetworkMatch(candidate, expectedUrl, expectedMethod) {
              if (!candidate || !candidate.url) return false;
              if (expectedMethod && candidate.method !== expectedMethod) return false;

              const expected = normalizeUrl(expectedUrl);
              const actual = normalizeUrl(candidate.url);

              if (expected.origin && actual.origin && expected.origin !== actual.origin) return false;
              if (expected.pathname !== actual.pathname) return false;
              if (expected.search && expected.search !== actual.search) return false;
              return true;
            }

            // 1. Retroactive check
            const calls = window.__wfPlayNet || [];
            const past = calls.find((c) => isNetworkMatch(c, targetUrl, targetMethod));
            if (past) return past;

            // 2. Live watcher
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                window.removeEventListener("__wf_net_capture__", handler);
                resolve(null);
              }, timeoutMs);
              function handler(ev) {
                const c = ev.detail;
                if (isNetworkMatch(c, targetUrl, targetMethod)) {
                  clearTimeout(timer);
                  window.removeEventListener("__wf_net_capture__", handler);
                  resolve(c);
                }
              }
              window.addEventListener("__wf_net_capture__", handler);
            });
          },
          args: [event.networkUrl, event.networkMethod, Math.min(state.playBufferMs || 8000, 5000)],
        });
        matchedCall = found?.[0]?.result || null;
        if (matchedCall) {
          const enriched = await chrome.scripting.executeScript({
          target: { tabId: netTab.id },
          world: "MAIN",
          func: async (targetUrl, targetMethod, targetTimestamp, settleMs) => {
              function normalizeUrl(url) {
                try {
                  const parsed = new URL(url, window.location.href);
                  const pathname = parsed.pathname.length > 1
                    ? parsed.pathname.replace(/\/+$/, "")
                    : parsed.pathname;
                  return {
                    origin: parsed.origin,
                    pathname,
                    search: parsed.search,
                  };
                } catch (_) {
                  const text = String(url || "");
                  return {
                    origin: "",
                    pathname: text,
                    search: "",
                  };
                }
              }

              function isNetworkMatch(candidate, expectedUrl, expectedMethod) {
                if (!candidate || !candidate.url) return false;
                if (expectedMethod && candidate.method !== expectedMethod) return false;

                const expected = normalizeUrl(expectedUrl);
                const actual = normalizeUrl(candidate.url);

                if (expected.origin && actual.origin && expected.origin !== actual.origin) return false;
                if (expected.pathname !== actual.pathname) return false;
                if (expected.search && expected.search !== actual.search) return false;
                return true;
              }

              function findMatch() {
                const calls = window.__wfPlayNet || [];
                for (let i = calls.length - 1; i >= 0; i--) {
                  const call = calls[i];
                  if (!isNetworkMatch(call, targetUrl, targetMethod)) continue;
                  if (targetTimestamp && call.timestamp !== targetTimestamp) continue;
                  return call;
                }
                return null;
              }

              const startedAt = Date.now();
              let latest = findMatch();
              while (Date.now() - startedAt < settleMs) {
                if (latest && (latest.responseBody != null || latest.requestBody != null)) break;
                await new Promise((resolve) => setTimeout(resolve, 50));
                latest = findMatch() || latest;
              }
              return latest;
            },
            args: [
              event.networkUrl,
              event.networkMethod,
              matchedCall.timestamp || null,
              400,
            ],
          });
          matchedCall = enriched?.[0]?.result || matchedCall;
        }
        if (!matchedCall) {
          // L2: Gate behind __DEBUG__ — event.networkUrl may contain private URLs.
          debug("[WFPlay] network_checkpoint not matched:", event.networkMethod, event.networkUrl);
        }
      } catch (err) {
        console.warn("[WFPlay] network_checkpoint error:", err);
      }

      const idx = state.screenshotCount++;
      results.checkpoints[idx] = {
        label: event.label,
        checkpointType: "network",
        dataUrl: null,
        capturedData: JSON.stringify({
          matched: !!matchedCall,
          expectedUrl: event.networkUrl ?? null,
          expectedMethod: event.networkMethod ?? null,
          expectedStatus: event.networkStatus ?? null,
          expectedStatusText: event.networkStatusText ?? null,
          expectedRequestHeaders: event.networkRequestHeaders ?? null,
          expectedResponseHeaders: event.networkResponseHeaders ?? null,
          expectedRequestBody: event.networkRequestBody ?? null,
          expectedResponseBody: event.networkResponseBody ?? null,
          capturedUrl: matchedCall?.url ?? null,
          capturedMethod: matchedCall?.method ?? null,
          capturedStatus: matchedCall?.status ?? null,
          capturedStatusText: matchedCall?.statusText ?? null,
          requestHeaders: matchedCall?.requestHeaders ?? null,
          responseHeaders: matchedCall?.responseHeaders ?? null,
          requestBody: matchedCall?.requestBody ?? null,
          responseBody: matchedCall?.responseBody ?? null,
          capturedTimestamp: matchedCall?.timestamp ?? null,
        }),
      };
      broadcastToPopup({ type: "CHECKPOINT_REACHED", index: idx, label: event.label, checkpointType: "network" });
      chrome.tabs.sendMessage(netTab.id, { type: "PLAYBACK_CHECKPOINT_FLASH", label: event.label }).catch(() => {});

      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

/**
 * Handles cross-tab navigation during playback.
 *
 * Strategy:
 * Checks all open tabs to find if a tab matching the target URL already exists. If yes, it activates 
 * that tab. If no, it opens a new tab. It then strictly blocks playback via `waitForTabLoad` until 
 * the new/switched tab reports `status === "complete"`, preventing race conditions where events trigger 
 * on an empty DOM.
 */
async function handlePlaybackTabSwitch(event, meta) {
  if (!event.url) throw new Error("No URL provided for tab_switch");

  const tabs = await chrome.tabs.query({});
  let targetTabId;
  const match = tabs.find(t => t.url && t.url.startsWith(event.url.split("?")[0]));

  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId) {
      await chrome.windows.update(match.windowId, { focused: true });
    }
    targetTabId = match.id;
  } else {
    const newTab = await chrome.tabs.create({ url: event.url });
    targetTabId = newTab.id;
  }

  const tabInfo = await chrome.tabs.get(targetTabId);
  if (tabInfo && tabInfo.status !== "complete") {
    await waitForTabLoad(targetTabId);
  }
  await sleep(800);

  // Inject player.js dynamically into the newly switched tab to ensure the HUD renders
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["content/player.js"]
    });
    if (meta) {
      chrome.tabs.sendMessage(targetTabId, {
        type: "PLAYBACK_HUD_UPDATE",
        label: meta.label,
        progress: meta.progress,
        total: meta.total,
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("Could not inject player.js after tab switch:", e);
  }

  // Re-inject the capture accumulator into MAIN world so it continues buffering
  // console logs and network calls after the navigation.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["content/playback-capture.js"],
      world: "MAIN",
    });
  } catch (_) {}
}

/**
 * Blocks execution until a target tab finishes loading.
 *
 * Strategy:
 * Returns a Promise that resolves when `chrome.tabs.onUpdated` signals the tab is 'complete'. Applies a 
 * hard 10-second timeout guarantee to ensure the queue doesn't lock permanently if a site hangs.
 *
 * @param {number} tabId - Target tab identifier.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let timeoutId;
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });
}

/**
 * Sets playback mode to idle and notifies the popup (helper for a minimal stop response).
 *
 * Strategy:
 * The main `STOP_PLAYBACK` branch in the message listener performs fuller cleanup; this
 * function matches a narrow stop contract (mode + popup broadcast + `sendResponse`).
 */
function handleStopPlayback(sendResponse) {
  state.mode = "idle";
  state.dynamicRuntime = null;
  clearDynamicPauseWithResult("aborted");
  broadcastToPopup({ type: "PLAYBACK_STOPPED" });
  broadcastDynamicState();
  sendResponse({ ok: true });
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Returns the in-memory recording as a serializable workflow payload for download.
 *
 * Strategy:
 * Builds a plain object with name, timestamp, events, and screenshot count, then responds
 * with the parallel `screenshots` map for the popup to package as JSON.
 */
async function handleExportWorkflow(sendResponse) {
  const workflow = {
    name: state.workflowName || ("recorded-workflow-" + Date.now()),
    recordedAt: Date.now(),
    events: state.events,
    screenshotCount: state.screenshotCount,
  };
  sendResponse({ ok: true, workflow, screenshots: state.screenshots });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Clears all mutable session fields before a new recording or after discarding state.
 *
 * Strategy:
 * Resets arrays, maps, counters, and playback pointers while leaving `mode` to callers.
 */
function resetState() {
  state.events = [];
  state.recordingCheckpoints = [];
  state.screenshots = {};
  state.screenshotCount = 0;
  state.recordingSessionId = null;
  state.consoleLogs = {};
  state.networkCalls = {};
  state.networkClearCutoffs = {};
  state.playbackIndex = 0;
  state.playbackTabId = null;
  state.workflowsToPlay = [];
  state.workflowToPlay = null;
  state.dynamicRuntime = null;
  clearDynamicPauseWithResult("aborted");
  state.recordingTabId = null;
  state.workflowName = "";
}

/**
 * Promise-based delay helper for playback pacing and post-navigation waits.
 *
 * Strategy:
 * Wraps `setTimeout` in a Promise for use with `await` in async playback loops.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sends a one-way message to the extension popup if it is open.
 *
 * Strategy:
 * Uses `chrome.runtime.sendMessage` and swallows errors when no receiver exists.
 */
async function broadcastToPopup(msg) {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (_) {}
}

/**
 * Injected into page context during playback to replay DOM events.
 *
 * Strategy:
 * Operates completely hermetically — it receives its arguments serialized as JSON by the chrome API 
 * and cannot rely on SW scope. For clicks, it dispatches the complete `mousedown -> mouseup -> click` 
 * triplet to fool thick client frameworks (React/Angular) into triggering their synthetic event handlers. 
 * For inputs, it utilizes native property descriptors `Object.getOwnPropertyDescriptor().set` to bypass 
 * framework value hijackers, directly mutating the DOM node and explicitly raising `input` and `change` 
 * events to force state binding updates.
 *
 * @param {Object} event - The serialized playback instruction object.
 */
async function replayEventInPage(event, timeoutMs = 8000) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Interactive event types that require a target element to succeed.
  // "scroll" is intentionally excluded: it has a legitimate window-fallback and should
  // never be treated as a hard failure when the recorded element is gone.
  const interactiveTypes = ["click", "right_click", "long_press", "toggle", "input", "change", "keydown"];

  // Use the CSS selector as the authoritative element signal.
  // elementFromPoint() is intentionally NOT used as a selector fallback — it always
  // returns the topmost element at those pixel coordinates (body, container, overlay)
  // even when the intended target is absent, producing silent false-positives that
  // mark runs as "passed" even though nothing was actually clicked.
  //
  // When a selector is recorded but fails after the full timeout, a relaxed version
  // is tried by stripping positional :nth-of-type() qualifiers (common cause of
  // breakage in AngularJS ng-repeat lists after re-renders). If multiple candidates
  // match the relaxed selector, the one whose centre is closest to the recorded
  // x/y coordinates is chosen.
  let resolvedEl = null;

  if (interactiveTypes.includes(event.type)) {
    if (event.selector) {
      let isWaiting = false;
      const startTime = Date.now();

      // Phase 1 — wait for the exact recorded selector.
      // Uses querySelectorAll so that when multiple elements match (e.g. a selector
      // without nth-of-type), the one whose centre is closest to the recorded
      // click coordinates is chosen rather than blindly taking the first DOM match.
      while (Date.now() - startTime < timeoutMs) {
        try {
          const matches = Array.from(document.querySelectorAll(event.selector));
          if (matches.length === 1) {
            resolvedEl = matches[0];
            break;
          } else if (matches.length > 1) {
            if (event.x !== undefined && event.y !== undefined) {
              resolvedEl = matches.reduce((best, c) => {
                const r = c.getBoundingClientRect();
                const dist = Math.hypot(r.left + r.width / 2 - event.x, r.top + r.height / 2 - event.y);
                const rb = best.getBoundingClientRect();
                return dist < Math.hypot(rb.left + rb.width / 2 - event.x, rb.top + rb.height / 2 - event.y) ? c : best;
              });
            } else {
              resolvedEl = matches[0];
            }
            break;
          }
        } catch (_) {}

        isWaiting = true;
        const stepEl = document.getElementById("__wf_hud_step__");
        if (stepEl) {
          if (!stepEl.dataset.originalText) stepEl.dataset.originalText = stepEl.textContent;
          const remaining = Math.ceil((timeoutMs - (Date.now() - startTime)) / 1000);
          stepEl.textContent = `Waiting for element... (${remaining}s)`;
        }
        await wait(250);
      }

      if (isWaiting) {
        const stepEl = document.getElementById("__wf_hud_step__");
        if (stepEl && stepEl.dataset.originalText) stepEl.textContent = stepEl.dataset.originalText;
      }

      // Phase 2 — if the exact selector timed out, try a relaxed version that
      // strips :nth-of-type() qualifiers. This recovers from ng-repeat / v-for
      // re-renders where the element class is stable but its list position changed.
      if (!resolvedEl) {
        const relaxed = event.selector.replace(/:nth-of-type\(\d+\)/g, "");
        if (relaxed !== event.selector) {
          try {
            const stepEl = document.getElementById("__wf_hud_step__");
            if (stepEl) stepEl.textContent = "Trying relaxed selector\u2026";

            const candidates = Array.from(document.querySelectorAll(relaxed));
            if (candidates.length === 1) {
              resolvedEl = candidates[0];
            } else if (candidates.length > 1 && event.x !== undefined && event.y !== undefined) {
              // Pick the candidate whose centre is closest to the recorded click point.
              resolvedEl = candidates.reduce((best, c) => {
                const r = c.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const dist = Math.hypot(cx - event.x, cy - event.y);
                const rb = best.getBoundingClientRect();
                const bx = rb.left + rb.width / 2;
                const by = rb.top + rb.height / 2;
                return dist < Math.hypot(bx - event.x, by - event.y) ? c : best;
              });
            }
          } catch (_) {}
        }
      }

      // Phase 3 — last-resort coordinate hit-test.
      // Only reached when both Phase 1 (exact selector) and Phase 2 (relaxed selector)
      // produced zero DOM candidates. elementFromPoint() is used deliberately here but
      // with a strict coherence guard: we only accept the hit if the element (or one of
      // its ancestors) actually matches the loose selector. Without this guard,
      // elementFromPoint() always returns *something* (a random div, a nav bar, etc.)
      // causing the step to silently pass even though the intended element is gone.
      //
      // Two pitfalls handled explicitly:
      //  a) The player HUD is fixed to the viewport and can sit on top of the target
      //     coordinates, causing elementFromPoint to return a HUD element instead of
      //     the page element. The HUD is temporarily hidden for the hit-test.
      //  b) pageX/pageY (scroll-adjusted) are used so the target is always addressed
      //     in document space. If the target is currently scrolled off-screen the page
      //     is scrolled to bring it into the viewport before the hit-test.
      if (!resolvedEl && event.x !== undefined && event.y !== undefined &&
          (event.type === "click" || event.type === "right_click")) {
        try {
          const stepEl = document.getElementById("__wf_hud_step__");
          if (stepEl) stepEl.textContent = "Trying coordinates\u2026";

          // Hide extension overlays so they don't intercept the hit-test.
          const hud    = document.getElementById("__workflow_player_hud__");
          const recInd = document.getElementById("__workflow_rec_indicator__");
          const prevHudPE    = hud?.style.pointerEvents;
          const prevRecIndPE = recInd?.style.pointerEvents;
          if (hud)    hud.style.pointerEvents    = "none";
          if (recInd) recInd.style.pointerEvents = "none";

          // Prefer page-space coordinates so scroll position at playback time
          // doesn't affect the result. Fall back to client coords if not recorded.
          const pageX = event.pageX !== undefined ? event.pageX : event.x;
          const pageY = event.pageY !== undefined ? event.pageY : event.y;
          let vpX = pageX - window.scrollX;
          let vpY = pageY - window.scrollY;

          // If the target is outside the current viewport, scroll it into view first.
          if (vpY < 0 || vpY > window.innerHeight || vpX < 0 || vpX > window.innerWidth) {
            window.scrollTo(
              Math.max(0, pageX - window.innerWidth  / 2),
              Math.max(0, pageY - window.innerHeight / 2)
            );
            await wait(100);
            vpX = pageX - window.scrollX;
            vpY = pageY - window.scrollY;
          }

          const hit = document.elementFromPoint(vpX, vpY);

          // Restore overlays.
          if (hud)    hud.style.pointerEvents    = prevHudPE    ?? "";
          if (recInd) recInd.style.pointerEvents = prevRecIndPE ?? "";

          if (hit && hit !== document.body && hit !== document.documentElement) {
            // Walk up to the element the selector targets (not a child dot/span).
            // e.g. "p.billingtext5:nth-of-type(4)" → leaf "p.billingtext5"
            const leafRaw = event.selector.split(/\s*>\s*/).pop() || "";
            const leafSel = leafRaw.replace(/:nth-of-type\(\d+\)/g, "").trim();
            let candidate = hit;
            if (leafSel) {
              try { candidate = hit.closest(leafSel) || hit; } catch (_) {}
            }

            // ── Coherence guard ──────────────────────────────────────────────
            // Only accept the coordinate-hit candidate if it (or an ancestor)
            // actually matches the loose selector. If it doesn't, the element is
            // genuinely absent — return element_not_found instead of silently
            // clicking a random element at those coordinates.
            let coherent = false;
            if (leafSel) {
              try {
                coherent = candidate.matches(leafSel) || !!candidate.closest(leafSel);
              } catch (_) {}
            }
            // If we have no loose selector to verify against, allow the hit
            // (original behaviour for un-selectable elements recorded by coords only).
            if (!leafSel || coherent) {
              resolvedEl = candidate;
            }
          }
        } catch (_) {}
      }

      if (!resolvedEl) return { ok: false, reason: "element_not_found" };
    }
    // No selector recorded → fall through; resolvedEl stays null and the
    // coordinate path below handles it.
  }

  // Element resolution for the actual event dispatch.
  // Coordinates are only used when no selector was recorded at all.
  function getElement(selector, x, y) {
    if (resolvedEl) return resolvedEl;
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
    }
    if (x !== undefined && y !== undefined) {
      return document.elementFromPoint(x, y);
    }
    return null;
  }

  const el = getElement(event.selector, event.x, event.y);

  // Guard: no element resolved by any strategy → genuine missing element.
  if (interactiveTypes.includes(event.type) && !el) {
    return { ok: false, reason: "element_not_found" };
  }

  if (event.type === "click") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y }));
    el.focus?.();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y }));

    const isCheckbox = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
    if (isCheckbox) {
      const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "checked"
      )?.set;
      if (nativeCheckedSetter) {
        nativeCheckedSetter.call(el, el.type === "radio" ? true : !el.checked);
      } else {
        el.checked = el.type === "radio" ? true : !el.checked;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (event.type === "right_click") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
    el.focus?.();
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 2 }));
  } else if (event.type === "long_press") {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
    el.focus?.();
    await new Promise(r => setTimeout(r, 600));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: event.x, clientY: event.y, button: 0 }));
  } else if (event.type === "toggle") {
    if (el.tagName === "DETAILS") {
      el.open = event.isOpen !== undefined ? event.isOpen : !el.open;
      el.dispatchEvent(new Event("toggle", { bubbles: true }));
    } else {
      el.dispatchEvent(new Event("toggle", { bubbles: true }));
    }
  } else if (event.type === "scroll") {
    const target = el || window;
    if (target === window) {
      window.scrollTo({ left: event.scrollX, top: event.scrollY, behavior: "instant" });
    } else {
      target.scrollTop = event.scrollY;
      target.scrollLeft = event.scrollX;
    }
  } else if (event.type === "keydown") {
    const target = el || document.activeElement;
    if (target) {
      target.dispatchEvent(new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        bubbles: true,
        cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent("keyup", {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        bubbles: true,
        cancelable: true,
      }));
    }
  } else if (event.type === "input" || event.type === "change") {
    if (typeof event.value === "boolean" || (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio"))) {
      const nativeCheckedSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "checked"
      )?.set;
      const newChecked = typeof event.value === "boolean" ? event.value : !el.checked;
      if (nativeCheckedSetter) {
        nativeCheckedSetter.call(el, newChecked);
      } else {
        el.checked = newChecked;
      }
    } else if ("value" in el) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, event.value);
      } else {
        el.value = event.value;
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return { ok: true };
}
