/**
 * Popup script — manages idle / recording / playing UI states and
 * communicates with the service worker.
 */

// Dashboard URL — keep in sync with service-worker.js
const DASHBOARD_URL = 'http://localhost:3000';
const DASHBOARD_AUTH_STORAGE_KEYS = ['dashboardAuthToken', 'dashboardAuthUserId', 'dashboardAuthEmail'];
const USER_SETTINGS_STORAGE_KEYS = ['playBufferSeconds', 'promptScreenshotLabel', 'networkMergeWindowMs', 'dynamicBindingEnabled'];
const DEFAULT_USER_SETTINGS = {
  playBufferSeconds: 8,
  promptScreenshotLabel: false,
  networkMergeWindowMs: 500,
  dynamicBindingEnabled: false,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusBadge       = document.getElementById("statusBadge");

// Panels
const panelIdle         = document.getElementById("panelIdle");
const panelRecording    = document.getElementById("panelRecording");
const panelPlaying      = document.getElementById("panelPlaying");

// Idle
const workflowName      = document.getElementById("workflowName");
const btnRecord         = document.getElementById("btnRecord");
const btnOpenDashboard  = document.getElementById("btnOpenDashboard");
const btnOpenSettings   = document.getElementById("btnOpenSettings");
const loadedWorkflowName = document.getElementById("loadedWorkflowName");
const btnPlay           = document.getElementById("btnPlay");
const playBufferSeconds = document.getElementById("playBufferSeconds");
const networkMergeWindowMs = document.getElementById("networkMergeWindowMs");
const promptScreenshotLabelToggle = document.getElementById("promptScreenshotLabelToggle");
const authSignedOut     = document.getElementById("authSignedOut");
const authSignedIn      = document.getElementById("authSignedIn");
const authTabSignin     = document.getElementById("authTabSignin");
const authTabSignup     = document.getElementById("authTabSignup");
const authEmail         = document.getElementById("authEmail");
const authPassword      = document.getElementById("authPassword");
const authConfirmPassword = document.getElementById("authConfirmPassword");
const btnTogglePassword = document.getElementById("btnTogglePassword");
const btnToggleConfirmPassword = document.getElementById("btnToggleConfirmPassword");
const btnAuthSubmit     = document.getElementById("btnAuthSubmit");
const btnExtensionLogout = document.getElementById("btnExtensionLogout");
const authUserEmail     = document.getElementById("authUserEmail");
const authStatus        = document.getElementById("authStatus");
const authProtectedContent = document.getElementById("authProtectedContent");

// Load source tabs
const tabFromFile       = document.getElementById("tabFromFile");
const tabFromDashboard  = document.getElementById("tabFromDashboard");
const paneFromFile      = document.getElementById("paneFromFile");
const paneFromDashboard = document.getElementById("paneFromDashboard");
const btnLoadLabel      = document.getElementById("btnLoadLabel");
const fileInput         = document.getElementById("fileInput");

// Dashboard load
const workflowSelect      = document.getElementById("workflowSelect");
const btnRefreshWorkflows = document.getElementById("btnRefreshWorkflows");
const dbLoadStatus        = document.getElementById("dbLoadStatus");
const btnAddQueueDb       = document.getElementById("btnAddQueueDb");

// Queue
const queueContainer      = document.getElementById("queueContainer");
const queueCount          = document.getElementById("queueCount");
const queueList           = document.getElementById("queueList");

// Recording
const recEventCount     = document.getElementById("recEventCount");
const recCheckpointCount = document.getElementById("recCheckpointCount");
const recDuration       = document.getElementById("recDuration");
const btnCheckpoint     = document.getElementById("btnCheckpoint");
const btnConsoleCheckpoint = document.getElementById("btnConsoleCheckpoint");
const btnNetworkCheckpoint = document.getElementById("btnNetworkCheckpoint");
const btnStopRecording  = document.getElementById("btnStopRecording");
const btnRestartRecording = document.getElementById("btnRestartRecording");
const btnDiscardRecording = document.getElementById("btnDiscardRecording");
const checkpointThumbsRec = document.getElementById("checkpointThumbsRec");


// Playing
const playProgressBar   = document.getElementById("playProgressBar");
const playProgressText  = document.getElementById("playProgressText");
const playCurrentEvent  = document.getElementById("playCurrentEvent");
const btnStopPlayback   = document.getElementById("btnStopPlayback");
const checkpointThumbsPlay = document.getElementById("checkpointThumbsPlay");
const noCheckpointsYet  = document.getElementById("noCheckpointsYet");
const dynamicLiveCard   = document.getElementById("dynamicLiveCard");
const dynamicLiveStatus = document.getElementById("dynamicLiveStatus");
const dynamicLiveList   = document.getElementById("dynamicLiveList");
const btnDynamicResume  = document.getElementById("btnDynamicResume");

// Toast
const toast             = document.getElementById("toast");

// ─── Local state ──────────────────────────────────────────────────────────────

let recordingStartTime  = 0;
let durationTimer       = null;
let authMode            = 'signin';
let dashboardAuth       = {
  token: null,
  userId: null,
  email: null,
};
let dashboardWorkflowsFetched = false;
let userSettings        = { ...DEFAULT_USER_SETTINGS };

// Playing state
let workflowQueue       = [];     // array of parsed workflow JSONs to play sequentially
let playScreenshots     = {};     // currently playing workflow's screenshots
let playDynamicState    = null;   // live dynamic playback state pushed from SW

function renderCheckpointLabelMode() {
  btnCheckpoint.title = promptScreenshotLabelToggle.checked
    ? 'Take screenshot checkpoint and optionally enter a label'
    : 'Take screenshot checkpoint without a label';
}

// ─── Init: sync state from service worker ────────────────────────────────────

/**
 * Aligns the popup UI with the service worker mode on load.
 *
 * Strategy:
 * Sends `GET_STATE`, then calls `showPanel` and starts the duration timer when recording.
 */
async function init() {
  const res = await sendToSW({ type: "GET_STATE" });
  if (!res) return;
  playDynamicState = res.dynamicState || null;
  renderDynamicLivePanel();

  if (res.mode === "recording") {
    showPanel("recording");
    recEventCount.textContent = res.eventCount ?? 0;
    startDurationTimer();
  } else if (res.mode === "playing") {
    showPanel("playing");
  } else {
    showPanel("idle");
  }
}

async function boot() {
  await initUserSettings();
  await init();
  await initAuthState();
}

boot();

// ─── Panel switching ──────────────────────────────────────────────────────────

/**
 * Shows one of idle / recording / playing panels and updates the status badge.
 *
 * Strategy:
 * Toggles `hidden` on the three panel roots and applies badge text plus CSS class.
 */
function showPanel(mode) {
  panelIdle.classList.toggle("hidden", mode !== "idle");
  panelRecording.classList.toggle("hidden", mode !== "recording");
  panelPlaying.classList.toggle("hidden", mode !== "playing");

  statusBadge.textContent = mode === "idle" ? "Idle" : mode === "recording" ? "Recording" : "Playing";
  statusBadge.className = "status-badge " + (mode !== "idle" ? mode : "");
}

// ─── Extension auth ───────────────────────────────────────────────────────────

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function normalizePlayBufferSeconds(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_USER_SETTINGS.playBufferSeconds), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_USER_SETTINGS.playBufferSeconds;
  }
  return Math.min(60, Math.max(0, parsed));
}

function normalizeNetworkMergeWindowMs(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_USER_SETTINGS.networkMergeWindowMs), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_USER_SETTINGS.networkMergeWindowMs;
  }
  return Math.min(2000, Math.max(100, parsed));
}

function normalizeUserSettings(input = {}) {
  return {
    playBufferSeconds: normalizePlayBufferSeconds(input.playBufferSeconds),
    promptScreenshotLabel: Boolean(input.promptScreenshotLabel),
    networkMergeWindowMs: normalizeNetworkMergeWindowMs(input.networkMergeWindowMs),
    dynamicBindingEnabled: Boolean(input.dynamicBindingEnabled),
  };
}

function isDynamicBindingEnabled() {
  return Boolean(userSettings.dynamicBindingEnabled);
}

function applyUserSettings(nextSettings = {}) {
  userSettings = normalizeUserSettings({
    ...userSettings,
    ...nextSettings,
  });
  playBufferSeconds.value = String(userSettings.playBufferSeconds);
  networkMergeWindowMs.value = String(userSettings.networkMergeWindowMs);
  promptScreenshotLabelToggle.checked = userSettings.promptScreenshotLabel;
  renderCheckpointLabelMode();
  renderQueue();
  renderDynamicLivePanel();
  return userSettings;
}

async function persistUserSettingsLocally(nextSettings = {}) {
  const resolvedSettings = applyUserSettings(nextSettings);
  await storageSet({
    playBufferSeconds: resolvedSettings.playBufferSeconds,
    promptScreenshotLabel: resolvedSettings.promptScreenshotLabel,
    networkMergeWindowMs: resolvedSettings.networkMergeWindowMs,
    dynamicBindingEnabled: resolvedSettings.dynamicBindingEnabled,
  });
  return resolvedSettings;
}

async function initUserSettings() {
  const storedSettings = await storageGet(USER_SETTINGS_STORAGE_KEYS);
  await persistUserSettingsLocally(storedSettings);
}

async function syncUserSettingsFromDashboard() {
  if (!dashboardAuth.token) {
    return userSettings;
  }

  try {
    const res = await dashboardFetch('/api/settings', { method: 'GET' }, true);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `Server returned ${res.status}`);
    }

    return persistUserSettingsLocally(data?.settings || {});
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.warn('Could not sync settings from dashboard:', error);
    }
    return userSettings;
  }
}

async function saveUserSettings(nextSettings) {
  const resolvedSettings = await persistUserSettingsLocally(nextSettings);

  if (!dashboardAuth.token) {
    return resolvedSettings;
  }

  try {
    const res = await dashboardFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolvedSettings),
    }, true);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `Server returned ${res.status}`);
    }

    return persistUserSettingsLocally(data?.settings || resolvedSettings);
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      console.warn('Could not save settings to dashboard:', error);
    }
    return resolvedSettings;
  }
}

async function handlePlayBufferSettingsChange() {
  await saveUserSettings({
    playBufferSeconds: playBufferSeconds.value,
  });
}

async function handlePromptScreenshotSettingChange() {
  await saveUserSettings({
    promptScreenshotLabel: promptScreenshotLabelToggle.checked,
  });
}

async function handleNetworkMergeWindowSettingsChange() {
  await saveUserSettings({
    networkMergeWindowMs: networkMergeWindowMs.value,
  });
}

playBufferSeconds.addEventListener('change', handlePlayBufferSettingsChange);
promptScreenshotLabelToggle.addEventListener('change', handlePromptScreenshotSettingChange);
networkMergeWindowMs.addEventListener('change', handleNetworkMergeWindowSettingsChange);

function setAuthMode(mode) {
  authMode = mode;
  authTabSignin.classList.toggle('active', mode === 'signin');
  authTabSignup.classList.toggle('active', mode === 'signup');
  const confirmWrap = document.getElementById('authConfirmPasswordWrap');
  if (confirmWrap) confirmWrap.classList.toggle('hidden', mode !== 'signup');
  authPassword.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  authConfirmPassword.autocomplete = mode === 'signup' ? 'new-password' : 'off';
  btnAuthSubmit.textContent = mode === 'signup' ? 'Create Account' : 'Sign In';
  authStatus.textContent = '';
  authStatus.className = 'db-status';
}

function setAuthStatus(message = '', type = '') {
  authStatus.textContent = message;
  authStatus.className = 'db-status' + (type ? ' ' + type : '');
}

function resetDashboardWorkflowState() {
  workflowSelect.options.length = 1;
  workflowSelect.value = '';
  workflowSelect.disabled = !dashboardAuth.token;
  btnAddQueueDb.disabled = true;
  dashboardWorkflowsFetched = false;
  dbLoadStatus.textContent = dashboardAuth.token
    ? 'Refresh to load your dashboard workflows.'
    : 'Sign in to access dashboard workflows.';
  dbLoadStatus.className = 'db-status';
  workflowQueue = workflowQueue.filter((workflow) => !workflow._dashboardId);
  renderQueue();
}

function renderAuthState() {
  const isSignedIn = Boolean(dashboardAuth.token && dashboardAuth.email);

  authSignedOut.classList.toggle('hidden', isSignedIn);
  authSignedIn.classList.toggle('hidden', !isSignedIn);
  authProtectedContent.classList.toggle('hidden', !isSignedIn);

  if (isSignedIn) {
    authUserEmail.textContent = dashboardAuth.email;
    btnRecord.disabled = false;
    setAuthStatus('');
  } else {
    authUserEmail.textContent = '';
    btnRecord.disabled = true;
    workflowSelect.disabled = true;
    btnAddQueueDb.disabled = true;
    if (tabFromDashboard.classList.contains('active')) {
      dbLoadStatus.textContent = 'Sign in to access dashboard workflows.';
      dbLoadStatus.className = 'db-status';
    }
  }
}

async function persistDashboardAuth(nextAuth) {
  dashboardAuth = {
    token: nextAuth.token || null,
    userId: nextAuth.userId || null,
    email: nextAuth.email || null,
  };

  await storageSet({
    dashboardAuthToken: dashboardAuth.token,
    dashboardAuthUserId: dashboardAuth.userId,
    dashboardAuthEmail: dashboardAuth.email,
  });
  renderAuthState();
}

async function clearDashboardAuth(message = '', type = '') {
  dashboardAuth = { token: null, userId: null, email: null };
  await storageRemove(DASHBOARD_AUTH_STORAGE_KEYS);
  resetDashboardWorkflowState();
  renderAuthState();
  if (message) {
    setAuthStatus(message, type);
  }
}

async function dashboardFetch(path, options = {}, requireAuth = false) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Extension', 'true');

  if (dashboardAuth.token) {
    headers.set('Authorization', `Bearer ${dashboardAuth.token}`);
  } else if (requireAuth) {
    throw new Error('Please sign in to your dashboard account first.');
  }

  const response = await fetch(`${DASHBOARD_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && requireAuth) {
    await clearDashboardAuth('Session expired. Sign in again.', 'error');
    throw new Error('Unauthorized');
  }

  return response;
}

async function initAuthState() {
  setAuthMode('signin');
  renderAuthState();

  const stored = await storageGet(DASHBOARD_AUTH_STORAGE_KEYS);
  if (!stored.dashboardAuthToken) {
    resetDashboardWorkflowState();
    renderAuthState();
    return;
  }

  dashboardAuth = {
    token: stored.dashboardAuthToken || null,
    userId: stored.dashboardAuthUserId || null,
    email: stored.dashboardAuthEmail || null,
  };

  try {
    const res = await dashboardFetch('/api/auth/session', { method: 'GET' }, true);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    await persistDashboardAuth({
      token: dashboardAuth.token,
      userId: data?.user?.userId || null,
      email: data?.user?.email || null,
    });
    await syncUserSettingsFromDashboard();
    resetDashboardWorkflowState();
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      await clearDashboardAuth('Could not restore session. Sign in again.', 'error');
    }
  }
}

async function submitExtensionAuth() {
  const email = authEmail.value.trim();
  const password = authPassword.value;
  const confirmPassword = authConfirmPassword.value;

  if (!email || !password) {
    setAuthStatus('Email and password are required.', 'error');
    return;
  }

  if (authMode === 'signup') {
    if (password.length < 8) {
      setAuthStatus('Password must be at least 8 characters.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      setAuthStatus('Passwords do not match.', 'error');
      return;
    }
  }

  btnAuthSubmit.disabled = true;
  setAuthStatus(authMode === 'signup' ? 'Creating account…' : 'Signing in…');

  try {
    const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const res = await dashboardFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || `Server returned ${res.status}`);
    }

    await persistDashboardAuth({
      token: data?.token || null,
      userId: data?.user?.userId || null,
      email: data?.user?.email || email,
    });
    await syncUserSettingsFromDashboard();

    authPassword.value = '';
    authConfirmPassword.value = '';
    resetDashboardWorkflowState();
    setAuthStatus(authMode === 'signup' ? 'Account created.' : 'Signed in.', 'success');
    setTimeout(() => {
      if (authStatus.textContent === 'Account created.' || authStatus.textContent === 'Signed in.') {
        setAuthStatus('');
      }
    }, 2500);
    showToast(authMode === 'signup' ? 'Account created.' : 'Signed in.', 'success');

    if (tabFromDashboard.classList.contains('active')) {
      fetchDashboardWorkflows();
    }
  } catch (error) {
    setAuthStatus(error.message || 'Authentication failed.', 'error');
  } finally {
    btnAuthSubmit.disabled = false;
  }
}

async function logoutExtensionAuth() {
  btnExtensionLogout.disabled = true;

  try {
    await dashboardFetch('/api/auth/logout', { method: 'POST' }, true);
  } catch (_) {
    // Best effort only. The extension primarily relies on bearer tokens.
  }

  await clearDashboardAuth('Signed out.', 'success');
  setTimeout(() => {
    if (authStatus.textContent === 'Signed out.') {
      setAuthStatus('');
    }
  }, 2500);
  authPassword.value = '';
  authConfirmPassword.value = '';
  showToast('Signed out.', 'success');
  btnExtensionLogout.disabled = false;
}

authTabSignin.addEventListener('click', () => setAuthMode('signin'));
authTabSignup.addEventListener('click', () => setAuthMode('signup'));
btnAuthSubmit.addEventListener('click', submitExtensionAuth);
btnExtensionLogout.addEventListener('click', logoutExtensionAuth);

// Password visibility toggles
const SVG_EYE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const SVG_EYE_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

function setupPasswordToggle(input, btn) {
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    btn.innerHTML = isPass ? SVG_EYE_OFF : SVG_EYE;
    btn.title = isPass ? 'Hide password' : 'Show password';
  });
}

setupPasswordToggle(authPassword, btnTogglePassword);
setupPasswordToggle(authConfirmPassword, btnToggleConfirmPassword);

// Allow submission via Enter key
[authEmail, authPassword, authConfirmPassword].forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitExtensionAuth();
    }
  });
});

// ─── Recording ────────────────────────────────────────────────────────────────

btnRecord.addEventListener("click", async () => {
  if (!dashboardAuth.token) {
    showToast("Sign in to record workflows to your dashboard.", "error");
    return;
  }

  const name = workflowName.value.trim();

  // Resolve the active tab NOW while the popup window is open —
  // the SW cannot reliably resolve currentWindow from its own context.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const res = await sendToSW({ type: "START_RECORDING", name, tabId: activeTab?.id ?? null });
  if (res?.ok) {
    recEventCount.textContent = "0";
    recCheckpointCount.textContent = "0";
    recDuration.textContent = "0s";
    checkpointThumbsRec.innerHTML = "";
    recordingStartTime = Date.now();
    startDurationTimer();
    showPanel("recording");
  } else {
    showToast("Could not start recording: " + (res?.error ?? "unknown"), "error");
  }
});

/**
 * Updates the recording duration label every second while recording.
 *
 * Strategy:
 * Uses `setInterval` from `recordingStartTime` to format minutes and seconds on the DOM.
 */
function startDurationTimer() {
  if (!recordingStartTime) recordingStartTime = Date.now();
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    recDuration.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
  }, 1000);
}

btnCheckpoint.addEventListener("click", async () => {
  let label = null;
  if (promptScreenshotLabelToggle.checked) {
    const promptedLabel = window.prompt("Screenshot checkpoint label (optional):");
    if (promptedLabel === null) {
      return;
    }
    label = promptedLabel.trim() || null;
  }

  btnCheckpoint.disabled = true;
  const res = await sendToSW({ type: "ADD_CHECKPOINT", label });
  btnCheckpoint.disabled = false;

  if (res?.ok) {
    // Thumbnail is added via the CHECKPOINT_ADDED runtime message below
  } else {
    showToast("Checkpoint failed: " + (res?.error ?? "unknown"), "error");
  }
});

// ─── Console Log Checkpoint dialog ────────────────────────────────────────────

btnConsoleCheckpoint.addEventListener("click", () => {
  sendToSW({ type: "TOGGLE_CONSOLE_DIALOG" }).then(() => window.close());
});

// ─── Network Call Checkpoint dialog ───────────────────────────────────────────

btnNetworkCheckpoint.addEventListener("click", () => {
  sendToSW({ type: "TOGGLE_NETWORK_DIALOG" }).then(() => window.close());
});

// ─── HTML escape helper ────────────────────────────────────────────────────────

/**
 * Escapes a string for safe insertion into `innerHTML` when building list rows.
 *
 * Strategy:
 * Replaces `&`, `<`, `>`, and `"` with HTML entities.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

btnStopRecording.addEventListener("click", async () => {
  clearInterval(durationTimer);
  btnStopRecording.disabled = true;

  const stopRes = await sendToSW({ type: "STOP_RECORDING" });
  btnStopRecording.disabled = false;

  if (!stopRes?.ok) {
    showToast("Stop failed: " + (stopRes?.error ?? "unknown"), "error");
    return;
  }

  // Service worker automatically calls saveToDashboard — just notify the user.
  showToast("Recording stopped. Saving to dashboard…", "success");
  showPanel("idle");
});

btnRestartRecording.addEventListener("click", async () => {
  btnRestartRecording.disabled = true;
  const res = await sendToSW({ type: "RESTART_RECORDING" });
  btnRestartRecording.disabled = false;

  if (res?.ok) {
    recEventCount.textContent = "0";
    recCheckpointCount.textContent = "0";
    recDuration.textContent = "0s";
    checkpointThumbsRec.innerHTML = "";
    recordingStartTime = Date.now();
    startDurationTimer();
    showToast("Recording restarted", "success");
  } else {
    showToast("Restart failed: " + (res?.error ?? "unknown"), "error");
  }
});

btnDiscardRecording.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to discard this recording?")) return;
  btnDiscardRecording.disabled = true;
  const res = await sendToSW({ type: "DISCARD_RECORDING" });
  btnDiscardRecording.disabled = false;

  if (res?.ok) {
    clearInterval(durationTimer);
    showPanel("idle");
    showToast("Recording discarded", "success");
  } else {
    showToast("Discard failed: " + (res?.error ?? "unknown"), "error");
  }
});

// ─── Load source tabs ────────────────────────────────────────────────────────

/**
 * Switches between file-based and dashboard-based workflow loading UI.
 *
 * Strategy:
 * Toggles tab and pane visibility; on first open of the dashboard tab, triggers
 * `fetchDashboardWorkflows`.
 */
function switchLoadTab(tab) {
  const isFile = tab === 'file';
  tabFromFile.classList.toggle('active', isFile);
  tabFromDashboard.classList.toggle('active', !isFile);
  paneFromFile.classList.toggle('hidden', !isFile);
  paneFromDashboard.classList.toggle('hidden', isFile);
  if (!isFile && !dashboardAuth.token) {
    workflowSelect.disabled = true;
    btnAddQueueDb.disabled = true;
    dbLoadStatus.textContent = 'Sign in to access dashboard workflows.';
    dbLoadStatus.className = 'db-status';
    return;
  }
  if (!isFile && !dashboardWorkflowsFetched) {
    dashboardWorkflowsFetched = true;
    fetchDashboardWorkflows();
  }
}

tabFromFile.addEventListener('click', () => switchLoadTab('file'));
tabFromDashboard.addEventListener('click', () => switchLoadTab('dashboard'));

/**
 * Loads workflow metadata from the dashboard API into the select control.
 *
 * Strategy:
 * GETs `/api/workflows` with the extension header, repopulates options, and surfaces
 * status text; resets fetch flag on error so retry works.
 */
async function fetchDashboardWorkflows() {
  if (!dashboardAuth.token) {
    dashboardWorkflowsFetched = false;
    workflowSelect.options.length = 1;
    workflowSelect.value = '';
    workflowSelect.disabled = true;
    btnAddQueueDb.disabled = true;
    dbLoadStatus.textContent = 'Sign in to access dashboard workflows.';
    dbLoadStatus.className = 'db-status';
    return;
  }

  dbLoadStatus.textContent = 'Loading…';
  dbLoadStatus.className = 'db-status';
  workflowSelect.disabled = true;
  btnAddQueueDb.disabled = true;
  // Clear old options except placeholder
  workflowSelect.options.length = 1;

  try {
    const res = await dashboardFetch('/api/workflows', { method: 'GET' }, true);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const workflows = await res.json();
    if (!Array.isArray(workflows) || workflows.length === 0) {
      dbLoadStatus.textContent = 'No workflows saved to dashboard yet.';
      return;
    }
    
    // Clear old options here to prevent duplicate appends on concurrent fetches
    workflowSelect.options.length = 1;

    for (const wf of workflows) {
      const opt = document.createElement('option');
      opt.value = wf.id;
      
      let name = wf.name || 'Workflow';
      // If it's a default generated name, replace 'recorded-workflow-' with 'Run '
      if (name.startsWith('recorded-workflow-')) {
        name = name.replace('recorded-workflow-', 'Run ');
      } else if (name.length > 25) {
        // Safe truncate for manually long names
        name = name.slice(0, 23) + '…';
      }
      
      const d = new Date(wf.recordedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      opt.textContent = `${name} (${d})`;
      workflowSelect.appendChild(opt);
    }
    dbLoadStatus.textContent = `${workflows.length} workflow${workflows.length === 1 ? '' : 's'} found`;
  } catch (err) {
    dbLoadStatus.textContent = `Error: ${err.message}`;
    dbLoadStatus.className = 'db-status error';
    dashboardWorkflowsFetched = false;
  } finally {
    workflowSelect.disabled = !dashboardAuth.token;
    btnAddQueueDb.disabled = !dashboardAuth.token || !workflowSelect.value;
  }
}

btnRefreshWorkflows.addEventListener('click', () => {
  workflowSelect.options.length = 1; // Clear UI immediately for feedback
  dashboardWorkflowsFetched = true;
  fetchDashboardWorkflows();
});

workflowSelect.addEventListener('change', () => {
  btnAddQueueDb.disabled = !dashboardAuth.token || !workflowSelect.value;
});

btnAddQueueDb.addEventListener('click', async () => {
  const id = workflowSelect.value;
  if (!id) return;

  dbLoadStatus.textContent = 'Adding to queue…';
  btnAddQueueDb.disabled = true;
  workflowSelect.disabled = true;

  try {
    const res = await dashboardFetch(`/api/workflows/${id}`, { method: 'GET' }, true);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wf = await res.json();
    if (!Array.isArray(wf.events)) throw new Error('Workflow has no events');
    
    workflowQueue.push({
      id: wf.id,
      _dashboardId: wf.id,
      name: wf.name,
      recordedAt: wf.recordedAt,
      events: wf.events,
      dynamicInputs: normalizeWorkflowDynamicInputs(wf.dynamicInputs),
      loopEnabled: false,
      loopCount: 2,
    });
    renderQueue();
    
    dbLoadStatus.textContent = `Added: ${wf.name}`;
    dbLoadStatus.className = 'db-status';
  } catch (err) {
    dbLoadStatus.textContent = `Failed to load: ${err.message}`;
    dbLoadStatus.className = 'db-status error';
  } finally {
    workflowSelect.value = ''; // Reset UI
    btnAddQueueDb.disabled = true;
    workflowSelect.disabled = !dashboardAuth.token;
  }
});

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeWorkflowDynamicInputs(input) {
  if (!isRecord(input)) {
    return {
      version: 1,
      variables: {},
      bindings: [],
    };
  }

  const rawVariables = isRecord(input.variables) ? input.variables : {};
  const rawBindings = Array.isArray(input.bindings) ? input.bindings : [];
  const variables = {};

  Object.entries(rawVariables).forEach(([key, variable]) => {
    if (!key || !isRecord(variable)) return;
    if (variable.kind === 'date_range') {
      variables[key] = {
        kind: 'date_range',
        start: typeof variable.start === 'string' ? variable.start : '',
        end: typeof variable.end === 'string' ? variable.end : '',
        stepUnit: variable.stepUnit === 'week' || variable.stepUnit === 'month' ? variable.stepUnit : 'day',
        stepValue: Math.max(1, Math.trunc(clampNumber(variable.stepValue, 1, 365, 1))),
        output: variable.output === 'datetime-local' || variable.output === 'text' ? variable.output : 'date',
      };
    } else if (variable.kind === 'number_sequence') {
      variables[key] = {
        kind: 'number_sequence',
        start: clampNumber(variable.start, -1e12, 1e12, 0),
        step: clampNumber(variable.step, -1e9, 1e9, 1),
        decimals: variable.decimals == null ? null : Math.max(0, Math.min(8, Math.trunc(clampNumber(variable.decimals, 0, 8, 0)))),
        min: variable.min == null ? null : clampNumber(variable.min, -1e12, 1e12, -1e12),
        max: variable.max == null ? null : clampNumber(variable.max, -1e12, 1e12, 1e12),
      };
    }
  });

  const bindings = rawBindings
    .map((binding) => {
      if (!isRecord(binding)) return null;
      const eventIndex = Math.max(0, Math.trunc(clampNumber(binding.eventIndex, 0, 1e6, -1)));
      const variableKey = typeof binding.variableKey === 'string' ? binding.variableKey : '';
      if (!variableKey || !Number.isFinite(eventIndex)) return null;
      return {
        eventIndex,
        variableKey,
        selector: typeof binding.selector === 'string' ? binding.selector : null,
        mode: 'replace',
      };
    })
    .filter((binding) => binding && variables[binding.variableKey]);

  return {
    version: 1,
    variables,
    bindings,
  };
}

function ensureWorkflowDynamicInputs(workflow) {
  workflow.dynamicInputs = normalizeWorkflowDynamicInputs(workflow.dynamicInputs);
  return workflow.dynamicInputs;
}

function detectDynamicSuggestions(events = []) {
  if (!Array.isArray(events)) return [];
  const suggestions = [];
  const datePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/;

  events.forEach((event, eventIndex) => {
    if (!event) return;
    const selector = typeof event.selector === 'string' ? event.selector : null;
    const inputType = String(event.inputType || '').toLowerCase();
    const tagName = String(event.tagName || '').toLowerCase();

    if (event.type === 'click') {
      const hintText = `${selector || ''} ${event.placeholder || ''} ${event.label || ''}`.toLowerCase();
      const looksDateField =
        (tagName === 'input' || tagName === 'textarea') &&
        /date|selecteddate|range/.test(hintText) &&
        !/daterangepicker|calendar|applybtn|cancelbtn/.test(hintText);
      if (looksDateField) {
        suggestions.push({
          eventIndex,
          selector,
          kind: 'date_range',
          rawValue: toDateInputValue(new Date()),
          inputType: 'date-range-click',
          sourceType: 'click',
        });
      }
      return;
    }

    if (event.type !== 'input' && event.type !== 'change') return;
    const rawValue = event.value;
    const valueString = rawValue == null ? '' : String(rawValue).trim();

    if (typeof rawValue === 'boolean') return;
    if (!valueString) return;

    const looksDate =
      inputType === 'date' ||
      inputType === 'datetime-local' ||
      datePattern.test(valueString);

    if (looksDate) {
      suggestions.push({
        eventIndex,
        selector,
        kind: 'date_range',
        rawValue: valueString,
        inputType,
        sourceType: event.type,
      });
      return;
    }

    const maybeNumber = Number.parseFloat(valueString);
    const looksNumber =
      inputType === 'number' ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(valueString) ||
      Number.isFinite(maybeNumber);
    if (looksNumber && Number.isFinite(maybeNumber)) {
      suggestions.push({
        eventIndex,
        selector,
        kind: 'number_sequence',
        rawValue: valueString,
        numericValue: maybeNumber,
        inputType,
        sourceType: event.type,
      });
    }
  });

  return suggestions;
}

function uniqueVariableKey(dynamicInputs, prefix) {
  const existing = new Set(Object.keys(dynamicInputs.variables || {}));
  let idx = 1;
  let key = `${prefix}_${idx}`;
  while (existing.has(key)) {
    idx += 1;
    key = `${prefix}_${idx}`;
  }
  return key;
}

function toDateInputValue(source) {
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysISO(sourceDateString, days) {
  const parsed = new Date(sourceDateString);
  if (Number.isNaN(parsed.getTime())) return sourceDateString;
  parsed.setDate(parsed.getDate() + days);
  return toDateInputValue(parsed);
}

function addVariableFromSuggestion(workflow, suggestion) {
  const dynamicInputs = ensureWorkflowDynamicInputs(workflow);
  const prefix = suggestion.kind === 'date_range' ? 'date_var' : 'num_var';
  const variableKey = uniqueVariableKey(dynamicInputs, prefix);

  if (suggestion.kind === 'date_range') {
    const normalizedDate = toDateInputValue(suggestion.rawValue) || toDateInputValue(new Date());
    const rangeStyleOutput = suggestion.sourceType === 'click' || suggestion.inputType === 'date-range-click';
    dynamicInputs.variables[variableKey] = {
      kind: 'date_range',
      start: normalizedDate,
      end: addDaysISO(normalizedDate, 6),
      stepUnit: 'day',
      stepValue: 1,
      output: rangeStyleOutput
        ? 'text'
        : suggestion.inputType === 'datetime-local'
          ? 'datetime-local'
          : 'date',
    };
  } else {
    dynamicInputs.variables[variableKey] = {
      kind: 'number_sequence',
      start: Number.isFinite(suggestion.numericValue) ? suggestion.numericValue : 0,
      step: 1,
      decimals: 0,
      min: null,
      max: null,
    };
  }

  const existingIdx = dynamicInputs.bindings.findIndex((binding) => binding.eventIndex === suggestion.eventIndex);
  const nextBinding = {
    eventIndex: suggestion.eventIndex,
    variableKey,
    selector: suggestion.selector,
    mode: 'replace',
  };
  if (existingIdx >= 0) {
    dynamicInputs.bindings[existingIdx] = nextBinding;
  } else {
    dynamicInputs.bindings.push(nextBinding);
  }
}

function renderDynamicEditor(item, workflow, workflowIndex) {
  const dynamicInputs = ensureWorkflowDynamicInputs(workflow);
  const suggestions = detectDynamicSuggestions(workflow.events || []);
  const dynamicWrap = document.createElement('div');
  dynamicWrap.className = 'queue-dynamic';

  const title = document.createElement('div');
  title.className = 'queue-dynamic-title';
  title.textContent = 'Dynamic Inputs';
  dynamicWrap.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'queue-dynamic-summary';
  summary.textContent = `${dynamicInputs.bindings.length} binding${dynamicInputs.bindings.length === 1 ? '' : 's'} · ${Object.keys(dynamicInputs.variables).length} variable${Object.keys(dynamicInputs.variables).length === 1 ? '' : 's'}`;
  dynamicWrap.appendChild(summary);

  const suggestionList = document.createElement('div');
  suggestionList.className = 'queue-dynamic-suggestions';
  suggestions.slice(0, 4).forEach((suggestion) => {
    const row = document.createElement('div');
    row.className = 'queue-dynamic-row';

    const label = document.createElement('div');
    label.className = 'queue-dynamic-label';
    const eventLabel = suggestion.selector ? `${suggestion.selector.slice(0, 32)}` : `Event ${suggestion.eventIndex + 1}`;
    label.textContent = `${suggestion.kind === 'date_range' ? 'Date' : 'Number'} · #${suggestion.eventIndex + 1} · ${eventLabel}`;

    const bindBtn = document.createElement('button');
    bindBtn.className = 'btn btn-secondary queue-dynamic-btn';
    bindBtn.textContent = 'Bind';
    bindBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      addVariableFromSuggestion(workflow, suggestion);
      renderQueue();
    });

    row.appendChild(label);
    row.appendChild(bindBtn);
    suggestionList.appendChild(row);
  });

  if (suggestionList.childElementCount > 0) {
    dynamicWrap.appendChild(suggestionList);
  }

  const variableEntries = Object.entries(dynamicInputs.variables);
  variableEntries.forEach(([variableKey, variable]) => {
    const row = document.createElement('div');
    row.className = 'queue-dynamic-var';

    const rowHeader = document.createElement('div');
    rowHeader.className = 'queue-dynamic-var-head';
    const keyEl = document.createElement('code');
    keyEl.textContent = variableKey;
    rowHeader.appendChild(keyEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'queue-item-remove';
    removeBtn.textContent = 'x';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      delete dynamicInputs.variables[variableKey];
      dynamicInputs.bindings = dynamicInputs.bindings.filter((binding) => binding.variableKey !== variableKey);
      renderQueue();
    });
    rowHeader.appendChild(removeBtn);
    row.appendChild(rowHeader);

    if (variable.kind === 'date_range') {
      const startInput = document.createElement('input');
      startInput.type = 'date';
      startInput.className = 'input queue-dynamic-input';
      startInput.value = variable.start || '';
      startInput.addEventListener('change', () => {
        variable.start = startInput.value;
      });

      const endInput = document.createElement('input');
      endInput.type = 'date';
      endInput.className = 'input queue-dynamic-input';
      endInput.value = variable.end || '';
      endInput.addEventListener('change', () => {
        variable.end = endInput.value;
      });

      const unitSelect = document.createElement('select');
      unitSelect.className = 'db-select queue-dynamic-select';
      ['day', 'week', 'month'].forEach((unit) => {
        const option = document.createElement('option');
        option.value = unit;
        option.textContent = unit;
        if (variable.stepUnit === unit) option.selected = true;
        unitSelect.appendChild(option);
      });
      unitSelect.addEventListener('change', () => {
        variable.stepUnit = unitSelect.value;
      });

      const stepInput = document.createElement('input');
      stepInput.type = 'number';
      stepInput.min = '1';
      stepInput.max = '365';
      stepInput.className = 'input queue-dynamic-input';
      stepInput.value = String(variable.stepValue ?? 1);
      stepInput.addEventListener('change', () => {
        variable.stepValue = Math.max(1, Number.parseInt(stepInput.value, 10) || 1);
        stepInput.value = String(variable.stepValue);
      });

      row.appendChild(startInput);
      row.appendChild(endInput);
      row.appendChild(unitSelect);
      row.appendChild(stepInput);
    } else {
      const startInput = document.createElement('input');
      startInput.type = 'number';
      startInput.className = 'input queue-dynamic-input';
      startInput.value = String(variable.start ?? 0);
      startInput.addEventListener('change', () => {
        variable.start = Number.parseFloat(startInput.value) || 0;
      });

      const stepInput = document.createElement('input');
      stepInput.type = 'number';
      stepInput.className = 'input queue-dynamic-input';
      stepInput.value = String(variable.step ?? 1);
      stepInput.addEventListener('change', () => {
        variable.step = Number.parseFloat(stepInput.value) || 1;
      });

      const minInput = document.createElement('input');
      minInput.type = 'number';
      minInput.className = 'input queue-dynamic-input';
      minInput.placeholder = 'Min (opt)';
      minInput.value = variable.min == null ? '' : String(variable.min);
      minInput.addEventListener('change', () => {
        variable.min = minInput.value === '' ? null : Number.parseFloat(minInput.value);
      });

      const maxInput = document.createElement('input');
      maxInput.type = 'number';
      maxInput.className = 'input queue-dynamic-input';
      maxInput.placeholder = 'Max (opt)';
      maxInput.value = variable.max == null ? '' : String(variable.max);
      maxInput.addEventListener('change', () => {
        variable.max = maxInput.value === '' ? null : Number.parseFloat(maxInput.value);
      });

      row.appendChild(startInput);
      row.appendChild(stepInput);
      row.appendChild(minInput);
      row.appendChild(maxInput);
    }

    dynamicWrap.appendChild(row);
  });

  if (dynamicInputs.bindings.length > 0) {
    const bindingBlock = document.createElement('div');
    bindingBlock.className = 'queue-dynamic-bindings';
    dynamicInputs.bindings.forEach((binding, bindingIndex) => {
      const bindingRow = document.createElement('div');
      bindingRow.className = 'queue-dynamic-binding-row';

      const bindingText = document.createElement('span');
      bindingText.className = 'queue-dynamic-binding-text';
      bindingText.textContent = `#${binding.eventIndex + 1} → ${binding.variableKey}`;

      const select = document.createElement('select');
      select.className = 'db-select queue-dynamic-select';
      Object.keys(dynamicInputs.variables).forEach((variableKey) => {
        const option = document.createElement('option');
        option.value = variableKey;
        option.textContent = variableKey;
        if (binding.variableKey === variableKey) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', () => {
        binding.variableKey = select.value;
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'queue-item-remove';
      removeBtn.textContent = 'x';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        dynamicInputs.bindings.splice(bindingIndex, 1);
        renderQueue();
      });

      bindingRow.appendChild(bindingText);
      bindingRow.appendChild(select);
      bindingRow.appendChild(removeBtn);
      bindingBlock.appendChild(bindingRow);
    });
    dynamicWrap.appendChild(bindingBlock);
  }

  if (Object.keys(dynamicInputs.variables).length === 0 && suggestions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-dynamic-summary';
    empty.textContent = 'No date/number input suggestions found in this workflow.';
    dynamicWrap.appendChild(empty);
  }

  item.appendChild(dynamicWrap);
  workflowQueue[workflowIndex].dynamicInputs = normalizeWorkflowDynamicInputs(dynamicInputs);
}

/**
 * Renders the playback queue list and enables or disables the Play button.
 *
 * Strategy:
 * Builds DOM rows with remove handlers, toggles queue container visibility, and mirrors
 * queue length into the Play button label via `innerHTML`.
 */
function renderQueue() {
  queueList.innerHTML = '';
  if (workflowQueue.length === 0) {
    queueContainer.classList.add('hidden');
    btnPlay.disabled = true;
    btnPlay.innerHTML = '<span class="btn-icon" aria-hidden="true"></span> Play Queue';
    return;
  }
  
  queueContainer.classList.remove('hidden');
  queueCount.textContent = workflowQueue.length;
  btnPlay.disabled = false;
  btnPlay.innerHTML = `<span class="btn-icon" aria-hidden="true"></span> Play Queue (${workflowQueue.length})`;

  workflowQueue.forEach((wf, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    
    let displayName = wf.name || 'Workflow';
    if (displayName.startsWith('recorded-workflow-')) displayName = displayName.replace('recorded-workflow-', 'Run ');
    
    const topRow = document.createElement('div');
    topRow.className = 'queue-item-top';

    const nameEl = document.createElement('div');
    nameEl.className = 'queue-item-name';
    nameEl.textContent = `${i + 1}. ${displayName}`;

    const controlsRow = document.createElement('div');
    controlsRow.className = 'queue-item-controls';

    const loopControls = document.createElement('div');
    loopControls.className = 'queue-loop-controls';

    const loopLabel = document.createElement('label');
    loopLabel.className = 'queue-loop-label';

    const loopCheckbox = document.createElement('input');
    loopCheckbox.type = 'checkbox';
    loopCheckbox.checked = Boolean(wf.loopEnabled);
    const commitLoopToggle = () => {
      wf.loopEnabled = loopCheckbox.checked;
      if (wf.loopEnabled && (!Number.isInteger(wf.loopCount) || wf.loopCount < 2)) {
        wf.loopCount = 2;
      }
      renderQueue();
    };
    loopCheckbox.addEventListener('change', commitLoopToggle);
    loopCheckbox.addEventListener('input', commitLoopToggle);

    const loopText = document.createElement('span');
    loopText.textContent = 'Loop';

    const loopStepper = document.createElement('div');
    loopStepper.className = 'queue-loop-stepper';
    loopStepper.classList.toggle('hidden', !wf.loopEnabled);

    const loopMinus = document.createElement('button');
    loopMinus.type = 'button';
    loopMinus.className = 'queue-loop-stepper-btn';
    loopMinus.textContent = '−';
    loopMinus.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextValue = Math.max(2, (Number.parseInt(loopCount.value, 10) || 2) - 1);
      wf.loopCount = nextValue;
      loopCount.value = String(nextValue);
    });

    const loopCount = document.createElement('input');
    loopCount.type = 'text';
    loopCount.inputMode = 'numeric';
    loopCount.pattern = '[0-9]*';
    loopCount.value = String(Math.max(2, Number.parseInt(wf.loopCount, 10) || 2));
    loopCount.className = 'input queue-loop-count';
    loopCount.addEventListener('click', (event) => event.stopPropagation());
    const commitLoopCount = () => {
      const nextValue = Math.max(2, Number.parseInt(loopCount.value, 10) || 2);
      wf.loopCount = nextValue;
      loopCount.value = String(nextValue);
    };
    loopCount.addEventListener('input', commitLoopCount);
    loopCount.addEventListener('change', commitLoopCount);

    const loopPlus = document.createElement('button');
    loopPlus.type = 'button';
    loopPlus.className = 'queue-loop-stepper-btn';
    loopPlus.textContent = '+';
    loopPlus.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextValue = Math.min(99, (Number.parseInt(loopCount.value, 10) || 2) + 1);
      wf.loopCount = nextValue;
      loopCount.value = String(nextValue);
    });

    loopStepper.appendChild(loopMinus);
    loopStepper.appendChild(loopCount);
    loopStepper.appendChild(loopPlus);

    loopLabel.appendChild(loopCheckbox);
    loopLabel.appendChild(loopText);
    loopControls.appendChild(loopLabel);
    loopControls.appendChild(loopStepper);
    
    const rmBtn = document.createElement('button');
    rmBtn.className = 'queue-item-remove';
    rmBtn.textContent = 'x';
    rmBtn.onclick = () => {
      workflowQueue.splice(i, 1);
      renderQueue();
    };
    
    topRow.appendChild(nameEl);
    topRow.appendChild(rmBtn);
    controlsRow.appendChild(loopControls);
    item.appendChild(topRow);
    item.appendChild(controlsRow);
    if (isDynamicBindingEnabled()) {
      renderDynamicEditor(item, wf, i);
    }
    queueList.appendChild(item);
  });
}

// ─── File loading ─────────────────────────────────────────────────────────────

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);

    if (!Array.isArray(parsed.events)) throw new Error("Invalid workflow: missing events array");

    workflowQueue.push({
      ...parsed,
      name: parsed.name || file.name,
      dynamicInputs: normalizeWorkflowDynamicInputs(parsed.dynamicInputs),
      loopEnabled: false,
      loopCount: 2,
    });
    renderQueue();
    showToast("Added to queue!", "success");
  } catch (err) {
    showToast("Failed to parse: " + err.message, "error");
  }

  // Reset file input so same file can be re-loaded
  fileInput.value = "";
});

// ─── Playback ─────────────────────────────────────────────────────────────────

btnPlay.addEventListener("click", async () => {
  if (workflowQueue.length === 0) return;

  playScreenshots = {};
  playDynamicState = null;
  renderDynamicLivePanel();
  playProgressBar.style.width = "0%";
  playProgressText.textContent = `0 / ${workflowQueue[0].events.length}`;
  playCurrentEvent.textContent = "Starting Queue…";
  checkpointThumbsPlay.innerHTML = "";
  noCheckpointsYet.style.display = "block";

  const workflows = workflowQueue.map((workflow) => ({
    ...workflow,
    dynamicInputs: isDynamicBindingEnabled()
      ? normalizeWorkflowDynamicInputs(workflow.dynamicInputs)
      : null,
    loopEnabled: Boolean(workflow.loopEnabled),
    loopCount: workflow.loopEnabled
      ? Math.max(2, Number.parseInt(workflow.loopCount, 10) || 2)
      : 1,
  }));

  const res = await sendToSW({ type: "START_PLAYBACK", workflows });
  if (res?.ok) {
    showPanel("playing");
  } else {
    showToast("Playback error: " + (res?.error ?? "unknown"), "error");
  }
});

btnStopPlayback.addEventListener("click", async () => {
  await sendToSW({ type: "STOP_PLAYBACK" });
  playDynamicState = null;
  renderDynamicLivePanel();
  showPanel("idle");
  showToast("Playback stopped.", "");
});

btnDynamicResume?.addEventListener("click", async () => {
  const response = await sendToSW({ type: "PLAYBACK_RESUME" });
  if (!response?.ok) {
    showToast(response?.error || "Playback is not paused.", "error");
  }
});


// ─── Service worker message listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "EVENT_RECORDED":
      if (recEventCount) recEventCount.textContent = msg.count;
      break;

    case "CHECKPOINT_ADDED":
      if (recCheckpointCount) {
        recCheckpointCount.textContent = parseInt(recCheckpointCount.textContent || "0") + 1;
      }
      if (msg.screenshotDataUrl) {
        addThumbnail(checkpointThumbsRec, msg.screenshotDataUrl, msg.label, msg.index);
      }
      break;

    case "CONSOLE_CHECKPOINT_ADDED":
      if (recCheckpointCount) {
        recCheckpointCount.textContent = parseInt(recCheckpointCount.textContent || "0") + 1;
      }
      break;

    case "NETWORK_CHECKPOINT_ADDED":
      if (recCheckpointCount) {
        recCheckpointCount.textContent = parseInt(recCheckpointCount.textContent || "0") + 1;
      }
      break;

    case "DASHBOARD_SAVE_COMPLETE":
      showToast("Workflow saved to Dashboard.", "success");
      break;

    case "DASHBOARD_SAVE_FAILED":
      showToast(`Dashboard save failed: ${msg.error || "unknown error"}`, "error");
      break;

    case "PLAYBACK_PROGRESS": {
      const pct = msg.total > 0 ? Math.round((msg.index / msg.total) * 100) : 0;
      playProgressBar.style.width = pct + "%";
      playProgressText.textContent = `${msg.index} / ${msg.total}`;
      const ev = msg.event;
      const evDesc = ev.type === "checkpoint"
        ? `Screenshot checkpoint: ${ev.label}`
        : ev.type === "console_checkpoint"
          ? `Console checkpoint: ${ev.label}`
          : ev.type === "network_checkpoint"
            ? `Network checkpoint: ${ev.label}`
            : ev.type === "tab_switch"
              ? `Tab: ${ev.url?.replace(/^https?:\/\//, "").slice(0, 40) ?? ""}`
              : `${ev.type}${ev.selector ? " → " + ev.selector.slice(0, 35) : ""}`;
      playCurrentEvent.textContent = evDesc;
      break;
    }

    case "CHECKPOINT_REACHED":
      noCheckpointsYet.style.display = "none";
      if (msg.screenshotDataUrl) {
        playScreenshots[msg.index] = msg.screenshotDataUrl;
        addThumbnail(checkpointThumbsPlay, msg.screenshotDataUrl, msg.label, msg.index);
      }
      break;

    case "PLAYBACK_DYNAMIC_STATE":
      if (!isDynamicBindingEnabled()) {
        playDynamicState = null;
        renderDynamicLivePanel();
        break;
      }
      playDynamicState = msg;
      renderDynamicLivePanel();
      break;

    case "PLAYBACK_DYNAMIC_PAUSED":
      if (!isDynamicBindingEnabled()) {
        break;
      }
      playDynamicState = {
        ...(playDynamicState || {}),
        active: true,
        paused: true,
        pauseIssue: msg,
      };
      renderDynamicLivePanel();
      showToast(msg?.message || "Playback paused for dynamic input.", "error");
      break;

    case "WORKFLOW_PLAYBACK_COMPLETE":
      showToast(`Completed: ${msg.name}`, "success");
      break;

    case "WORKFLOW_PLAYBACK_FAILED": {
      const step = msg.failedStep;
      const stepDesc = step
        ? `Step ${step.index + 1} (${step.type}${step.selector ? ": " + step.selector.slice(0, 35) : ""})`
        : "unknown step";
      showToast(`Failed at ${stepDesc}`, "error");
      // Only return to idle — do NOT call handlePlaybackComplete() here because
      // that function shows "Entire queue completed." (success), which would
      // immediately overwrite this error toast with a false-positive message.
      playDynamicState = null;
      renderDynamicLivePanel();
      showPanel("idle");
      break;
    }

    case "QUEUE_COMPLETE":
      playProgressBar.style.width = "100%";
      handlePlaybackComplete();
      break;

    case "PLAYBACK_STOPPED":
      playDynamicState = null;
      renderDynamicLivePanel();
      showPanel("idle");
      break;

    default:
      break;
  }
});

/**
 * Returns the UI to idle after a full queue finishes and shows a completion toast.
 *
 * Strategy:
 * Calls `showPanel("idle")` then `showToast` for a neutral success message.
 */
function handlePlaybackComplete() {
  playDynamicState = null;
  renderDynamicLivePanel();
  showPanel("idle");
  showToast("Entire queue completed.", "success");
}

function parseDateSafe(value) {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateLikeInput(date, output) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (output === 'datetime-local') return `${y}-${m}-${d}T${hh}:${mm}`;
  if (output === 'text') return `${y}-${m}-${d} ${hh}:${mm}`;
  return `${y}-${m}-${d}`;
}

function shiftDateValue(value, stepUnit, amount, output) {
  const parsed = parseDateSafe(value);
  if (!parsed) return value;
  if (stepUnit === 'month') {
    parsed.setMonth(parsed.getMonth() + amount);
  } else if (stepUnit === 'week') {
    parsed.setDate(parsed.getDate() + (amount * 7));
  } else {
    parsed.setDate(parsed.getDate() + amount);
  }
  return formatDateLikeInput(parsed, output);
}

async function applyDynamicOverride(variableKey, value) {
  if (!playDynamicState?.active) return;
  const res = await sendToSW({
    type: "PLAYBACK_DYNAMIC_UPDATE",
    workflowQueueIndex: playDynamicState.workflowQueueIndex,
    overrides: {
      [variableKey]: value,
    },
  });
  if (!res?.ok) {
    showToast(`Dynamic update failed: ${res?.error || 'unknown error'}`, 'error');
  }
}

function renderDynamicLivePanel() {
  if (!dynamicLiveCard || !dynamicLiveStatus || !dynamicLiveList || !btnDynamicResume) return;
  if (!isDynamicBindingEnabled()) {
    dynamicLiveCard.classList.add('hidden');
    btnDynamicResume.classList.add('hidden');
    dynamicLiveStatus.textContent = 'Dynamic bindings are disabled in dashboard settings.';
    dynamicLiveStatus.className = 'db-status';
    dynamicLiveList.innerHTML = '';
    return;
  }
  dynamicLiveList.innerHTML = '';

  const statePayload = playDynamicState;
  if (!statePayload?.active || !isRecord(statePayload.dynamicInputs?.variables)) {
    dynamicLiveCard.classList.add('hidden');
    btnDynamicResume.classList.add('hidden');
    dynamicLiveStatus.textContent = 'No dynamic bindings active.';
    return;
  }

  dynamicLiveCard.classList.remove('hidden');
  const pauseIssue = statePayload.pauseIssue;
  if (statePayload.paused && pauseIssue) {
    dynamicLiveStatus.textContent = `Paused at step #${(pauseIssue.eventIndex ?? 0) + 1}: ${pauseIssue.message || pauseIssue.reason || 'Dynamic value issue'}`;
    dynamicLiveStatus.className = 'db-status error';
    btnDynamicResume.classList.remove('hidden');
  } else {
    dynamicLiveStatus.textContent = `Loop ${Number.parseInt(statePayload.loopIndex, 10) + 1} dynamic values are active.`;
    dynamicLiveStatus.className = 'db-status';
    btnDynamicResume.classList.add('hidden');
  }

  const values = isRecord(statePayload.values) ? statePayload.values : {};
  const errors = isRecord(statePayload.errors) ? statePayload.errors : {};
  const overrides = isRecord(statePayload.overrides) ? statePayload.overrides : {};

  Object.entries(statePayload.dynamicInputs.variables).forEach(([variableKey, variable]) => {
    const row = document.createElement('div');
    row.className = 'dynamic-live-row';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'dynamic-live-meta';

    const keyEl = document.createElement('code');
    keyEl.textContent = variableKey;
    labelWrap.appendChild(keyEl);

    const infoEl = document.createElement('div');
    infoEl.className = 'dynamic-live-value';
    if (errors[variableKey]) {
      infoEl.textContent = errors[variableKey].message || errors[variableKey].reason || 'Invalid value';
      infoEl.classList.add('error');
    } else {
      const currentValue = overrides[variableKey] ?? values[variableKey] ?? '';
      infoEl.textContent = String(currentValue);
    }
    labelWrap.appendChild(infoEl);

    const controls = document.createElement('div');
    controls.className = 'dynamic-live-controls';

    const input = document.createElement('input');
    input.className = 'input dynamic-live-input';
    input.value = String(overrides[variableKey] ?? values[variableKey] ?? '');

    if (variable.kind === 'number_sequence') {
      input.type = 'number';
      input.step = String(variable.step || 1);
      if (variable.min != null) input.min = String(variable.min);
      if (variable.max != null) input.max = String(variable.max);
    } else if (variable.kind === 'date_range') {
      input.type = variable.output === 'datetime-local' ? 'datetime-local' : 'date';
    } else {
      input.type = 'text';
    }

    input.addEventListener('change', () => {
      applyDynamicOverride(variableKey, input.value);
    });

    const decBtn = document.createElement('button');
    decBtn.className = 'btn btn-secondary dynamic-live-btn';
    decBtn.textContent = '-';
    decBtn.addEventListener('click', async () => {
      const currentValue = overrides[variableKey] ?? values[variableKey] ?? '';
      if (variable.kind === 'number_sequence') {
        const numeric = Number.parseFloat(String(currentValue || variable.start || 0));
        const next = Number.isFinite(numeric) ? numeric - (Number.parseFloat(String(variable.step || 1)) || 1) : (variable.start || 0);
        input.value = String(next);
        await applyDynamicOverride(variableKey, next);
      } else if (variable.kind === 'date_range') {
        const stepAmount = Number.parseInt(String(variable.stepValue || 1), 10) || 1;
        const next = shiftDateValue(currentValue || variable.start, variable.stepUnit, -stepAmount, variable.output);
        input.value = String(next);
        await applyDynamicOverride(variableKey, next);
      }
    });

    const incBtn = document.createElement('button');
    incBtn.className = 'btn btn-secondary dynamic-live-btn';
    incBtn.textContent = '+';
    incBtn.addEventListener('click', async () => {
      const currentValue = overrides[variableKey] ?? values[variableKey] ?? '';
      if (variable.kind === 'number_sequence') {
        const numeric = Number.parseFloat(String(currentValue || variable.start || 0));
        const next = Number.isFinite(numeric) ? numeric + (Number.parseFloat(String(variable.step || 1)) || 1) : (variable.start || 0);
        input.value = String(next);
        await applyDynamicOverride(variableKey, next);
      } else if (variable.kind === 'date_range') {
        const stepAmount = Number.parseInt(String(variable.stepValue || 1), 10) || 1;
        const next = shiftDateValue(currentValue || variable.start, variable.stepUnit, stepAmount, variable.output);
        input.value = String(next);
        await applyDynamicOverride(variableKey, next);
      }
    });

    controls.appendChild(decBtn);
    controls.appendChild(input);
    controls.appendChild(incBtn);

    row.appendChild(labelWrap);
    row.appendChild(controls);
    dynamicLiveList.appendChild(row);
  });
}

// ─── Thumbnail helper ─────────────────────────────────────────────────────────

/**
 * Appends a small screenshot preview with label to a strip container.
 *
 * Strategy:
 * Creates image and caption nodes, wires click to open the data URL in a new window.
 */
function addThumbnail(container, dataUrl, label, index) {
  const item = document.createElement("div");
  item.className = "thumb-item";
  item.title = label || `Checkpoint ${index + 1}`;

  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = label || `Checkpoint ${index + 1}`;

  const lbl = document.createElement("div");
  lbl.className = "thumb-label";
  lbl.textContent = label || `#${index + 1}`;

  item.appendChild(img);
  item.appendChild(lbl);

  // Click thumbnail to open full screenshot
  item.addEventListener("click", () => {
    const win = window.open();
    if (win) {
      // H1: Use DOM API instead of document.write to avoid policy issues and XSS risk.
      const img = win.document.createElement("img");
      img.src = dataUrl;
      img.style.cssText = "max-width:100%;display:block;";
      win.document.body.appendChild(img);
    }
  });

  container.appendChild(item);
}

// ─── Dashboard button ─────────────────────────────────────────────────────────

btnOpenDashboard.addEventListener("click", () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

btnOpenSettings.addEventListener("click", () => {
  chrome.tabs.create({ url: `${DASHBOARD_URL}/settings` });
});

// ─── Utility: send message to service worker ──────────────────────────────────

/**
 * Promise wrapper around `chrome.runtime.sendMessage` to the service worker.
 *
 * Strategy:
 * Resolves with the callback result or `null` when `lastError` is set or send throws.
 */
function sendToSW(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("SW error:", chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(res);
        }
      });
    } catch (err) {
      console.warn("sendToSW threw:", err.message);
      resolve(null);
    }
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

/**
 * Shows a transient toast message with optional success/error styling.
 *
 * Strategy:
 * Sets text and class on the toast node, clears any prior timer, auto-hides after 3s.
 */
function showToast(message, type = "") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = "toast" + (type ? " " + type : "");
  toastTimer = setTimeout(() => {
    toast.className = "toast hidden";
  }, 3000);
}
