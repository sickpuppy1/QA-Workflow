'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'

interface Workflow {
  id: string
  name: string
  recordedAt: string
  _count: { screenshots: number; runs: number }
}

interface Props {
  workflows: Workflow[]
  stats: { workflows: number; runs: number; checkpoints: number }
  userEmail: string
}

/** Logged-in home: workflow list, stats, and sidebar navigation. */
export default function HomeClient({ workflows, stats, userEmail }: Props) {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [exportingIds, setExportingIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    setMounted(true)
  }, [])

  /** Ends the session via the logout API and sends the user to `/login`. */
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    // Signal the auth-bridge content script so the extension popup logs out live.
    try {
      window.postMessage({ __wfSrc: '__wf_dashboard_auth__', type: 'CLEAR_TOKEN' }, window.location.origin)
    } catch (_) {}
    router.push('/login')
  }

  /** Formats an ISO timestamp for list cards using the en-US locale. */
  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  /** Fetches full workflow data and downloads as JSON (debounced). */
  async function handleExportWorkflow(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation() // Prevent card click navigation
    if (exportingIds.has(id)) return // Debounce duplicate clicks

    setExportingIds(prev => new Set(prev).add(id))
    try {
      const res = await fetch(`/api/workflows/${id}`)
      if (!res.ok) throw new Error('Failed to fetch workflow')
      const workflow = await res.json()
      
      const data = JSON.stringify(workflow, null, 2)
      const blob = new Blob([data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name.replace(/\s+/g, '-').toLowerCase() || 'workflow'}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error(err)
      alert('Could not export workflow data.')
    } finally {
      setExportingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <img src="/icon.svg" alt="Logo" className="sidebar-logo-icon-img" />
          <div>
            <div className="sidebar-logo-text">Workflow Automator</div>
            <div className="sidebar-logo-sub">Workflow Recorder</div>
          </div>
        </div>

        <Link href="/" className="nav-item active">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="10" />
          </svg>
          Workflows
        </Link>
        <Link href="/settings" className="nav-item">
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
          <button id="logout-btn" className="btn btn-danger" style={{ width: '100%', justifyContent: 'center' }} onClick={handleLogout}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign Out
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="page-header">
          <div className="page-title">Workflows</div>
          <div className="page-subtitle">All recorded workflows — click to view screenshots and playback comparisons</div>
        </div>

        <div className="content">
          {/* Stats */}
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--accent-light)' }}>{stats.workflows}</div>
              <div className="stat-label">Recorded Workflows</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--green)' }}>{stats.runs}</div>
              <div className="stat-label">Playback Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--blue)' }}>{stats.checkpoints}</div>
              <div className="stat-label">Checkpoint Images</div>
            </div>
          </div>

          {/* Workflow list */}
          {workflows.length === 0 ? (
            <div className="empty-state">
              <svg className="empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16, opacity: 0.2 }}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <div className="empty-title">No workflows yet</div>
              <div className="empty-desc">
                Record a workflow in the Chrome extension and it will appear here automatically.
              </div>
            </div>
          ) : (
            <div className="card-grid">
              {workflows.map(w => (
                <div
                  key={w.id}
                  id={`workflow-card-${w.id}`}
                  className="workflow-card"
                  onClick={() => router.push(`/workflows/${w.id}`)}
                >
                  <div className="workflow-card-title">{w.name}</div>
                  <div className="workflow-card-meta">
                    <span className="badge badge-purple">{w._count.screenshots} checkpoints</span>
                    <span className="badge badge-green">{w._count.runs} runs</span>
                  </div>
                  <div className="workflow-card-date" suppressHydrationWarning>
                    {mounted ? `Recorded ${fmtDate(w.recordedAt)}` : 'Loading date...'}
                  </div>
                  
                  {/* Quick Export Button */}
                  {mounted && (
                    <button
                      className="btn btn-icon-only"
                      onClick={(e) => handleExportWorkflow(e, w.id, w.name)}
                      title="Export JSON"
                      disabled={exportingIds.has(w.id)}
                      style={{
                        position: 'absolute',
                        bottom: 12,
                        right: 12,
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid var(--border)',
                        color: exportingIds.has(w.id) ? 'var(--accent)' : 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        cursor: exportingIds.has(w.id) ? 'not-allowed' : 'pointer',
                        padding: 0
                      }}
                      onMouseEnter={(e) => {
                        if (exportingIds.has(w.id)) return
                        e.currentTarget.style.background = 'rgba(124,58,237,0.1)'
                        e.currentTarget.style.color = 'var(--accent-light)'
                        e.currentTarget.style.borderColor = 'var(--accent)'
                        e.currentTarget.style.transform = 'scale(1.05)'
                      }}
                      onMouseLeave={(e) => {
                        if (exportingIds.has(w.id)) return
                        e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                        e.currentTarget.style.color = 'var(--text-muted)'
                        e.currentTarget.style.borderColor = 'var(--border)'
                        e.currentTarget.style.transform = 'scale(1)'
                      }}
                    >
                      <svg 
                        width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ animation: exportingIds.has(w.id) ? 'spin 1s linear infinite' : 'none' }}
                      >
                        {exportingIds.has(w.id) ? (
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        ) : (
                          <>
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </>
                        )}
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
