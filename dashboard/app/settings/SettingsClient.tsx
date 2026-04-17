'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { UserSettingsRecord } from '@/lib/data'

interface Props {
  initialSettings: UserSettingsRecord
  userEmail: string
}

/** Logged-in settings page for extension preferences synced from MongoDB. */
export default function SettingsClient({ initialSettings, userEmail }: Props) {
  const router = useRouter()
  const [playBufferSeconds, setPlayBufferSeconds] = useState(
    String(initialSettings.playBufferSeconds)
  )
  const [networkMergeWindowMs, setNetworkMergeWindowMs] = useState(
    String(initialSettings.networkMergeWindowMs)
  )
  const [promptScreenshotLabel, setPromptScreenshotLabel] = useState(
    initialSettings.promptScreenshotLabel
  )
  const [dynamicBindingEnabled, setDynamicBindingEnabled] = useState(
    initialSettings.dynamicBindingEnabled
  )
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error' | ''
    message: string
  }>({ type: '', message: '' })

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    // Signal the auth-bridge content script so the extension popup logs out live.
    try {
      window.postMessage({ __wfSrc: '__wf_dashboard_auth__', type: 'CLEAR_TOKEN' }, window.location.origin)
    } catch (_) {}
    router.push('/login')
    router.refresh()
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFeedback({ type: '', message: '' })

    const parsedBuffer = Number.parseInt(playBufferSeconds, 10)
    if (!Number.isFinite(parsedBuffer) || parsedBuffer < 0 || parsedBuffer > 60) {
      setFeedback({
        type: 'error',
        message: 'DOM load buffer must be a whole number between 0 and 60.',
      })
      return
    }

    const parsedNetworkMergeWindow = Number.parseInt(networkMergeWindowMs, 10)
    if (
      !Number.isFinite(parsedNetworkMergeWindow) ||
      parsedNetworkMergeWindow < 100 ||
      parsedNetworkMergeWindow > 2000
    ) {
      setFeedback({
        type: 'error',
        message: 'Network merge window must be a whole number between 100 and 2000 ms.',
      })
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playBufferSeconds: parsedBuffer,
          promptScreenshotLabel,
          networkMergeWindowMs: parsedNetworkMergeWindow,
          dynamicBindingEnabled,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data?.error || `Server returned ${res.status}`)
      }

      setPlayBufferSeconds(String(data.settings.playBufferSeconds))
      setPromptScreenshotLabel(Boolean(data.settings.promptScreenshotLabel))
      setNetworkMergeWindowMs(String(data.settings.networkMergeWindowMs))
      setDynamicBindingEnabled(Boolean(data.settings.dynamicBindingEnabled))
      setFeedback({
        type: 'success',
        message: 'Settings saved. The extension will use them the next time the popup opens.',
      })
    } catch (error) {
      setFeedback({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Could not save settings.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-logo">
          <img src="/icon.svg" alt="Logo" className="sidebar-logo-icon-img" />
          <div>
            <div className="sidebar-logo-text">QA Dashboard</div>
            <div className="sidebar-logo-sub">Workflow Recorder</div>
          </div>
        </div>

        <Link href="/" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="10" />
          </svg>
          Workflows
        </Link>
        <Link href="/settings" className="nav-item active">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </Link>

        <div style={{ flex: 1 }} />

        <div style={{ padding: '12px 8px', borderTop: '1px solid var(--border)', marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
            Signed in as<br />
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>{userEmail}</span>
          </div>
          <button
            className="btn btn-danger"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={handleLogout}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign Out
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="page-header">
          <div className="page-title">Settings</div>
          <div className="page-subtitle">
            These extension preferences are stored per account in MongoDB.
          </div>
        </div>

        <div className="content">
          <form onSubmit={handleSubmit} className="card settings-card">
            <div className="settings-title-row">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-title-icon">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Extension Playback
            </div>
            <div className="settings-subtitle">
              Update the defaults used by the Chrome extension when this account is signed in.
            </div>

            <div className="settings-field-grid">
              <div className="settings-field">
                <label className="form-label settings-form-label" htmlFor="settings-play-buffer">
                  DOM Load Buffer (seconds)
                </label>
                <input
                  id="settings-play-buffer"
                  type="number"
                  min={0}
                  max={60}
                  className="form-input settings-form-input"
                  value={playBufferSeconds}
                  onChange={(event) => setPlayBufferSeconds(event.target.value)}
                />
                <div className="settings-field-hint">
                  Extra wait time before playback continues after page loads.
                </div>
              </div>

              <div className="settings-field">
                <label className="form-label settings-form-label" htmlFor="settings-network-merge-window">
                  Network Merge Window (ms)
                </label>
                <input
                  id="settings-network-merge-window"
                  type="number"
                  min={100}
                  max={2000}
                  className="form-input settings-form-input"
                  value={networkMergeWindowMs}
                  onChange={(event) => setNetworkMergeWindowMs(event.target.value)}
                />
                <div className="settings-field-hint">
                  Requests with the same URL and method inside this time window may be merged.
                </div>
              </div>
            </div>

            <label
              htmlFor="settings-prompt-label"
              className="settings-toggle-card"
            >
              <input
                id="settings-prompt-label"
                type="checkbox"
                checked={promptScreenshotLabel}
                onChange={(event) => setPromptScreenshotLabel(event.target.checked)}
                className="settings-toggle-checkbox"
              />
              <span className="settings-toggle-copy">
                <span className="settings-toggle-title">Prompt for screenshot labels</span>
                <span className="settings-toggle-desc">
                  When enabled, screenshot checkpoints ask for an optional label. When disabled, screenshot checkpoints are saved without labels.
                </span>
              </span>
            </label>

            <label
              htmlFor="settings-dynamic-binding-enabled"
              className="settings-toggle-card"
            >
              <input
                id="settings-dynamic-binding-enabled"
                type="checkbox"
                checked={dynamicBindingEnabled}
                onChange={(event) => setDynamicBindingEnabled(event.target.checked)}
                className="settings-toggle-checkbox"
              />
              <span className="settings-toggle-copy">
                <span className="settings-toggle-title">Enable dynamic bindings</span>
                <span className="settings-toggle-desc">
                  When enabled, dynamic input binding tools are shown in popup and workflow details, and playback uses dynamic values.
                </span>
              </span>
            </label>

            {feedback.message && (
              <div className={`settings-feedback ${feedback.type === 'error' ? 'error' : 'success'}`}>
                {feedback.message}
              </div>
            )}

            <div className="settings-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
                style={{ gap: 8 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => router.push('/')}
              >
                Back to Workflows
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  )
}
