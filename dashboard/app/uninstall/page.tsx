'use client'

import type { Metadata } from 'next'
import { useState } from 'react'

const REASONS = [
  "It didn't work as expected",
  "I don't need it anymore",
  "It was too complicated to use",
  "It was missing features I needed",
  "Privacy or security concerns",
  "Other",
] as const

type Reason = typeof REASONS[number]

/**
 * /uninstall — Opened by Chrome when the extension is removed.
 *
 * The URL is registered in the service worker via chrome.runtime.setUninstallURL.
 * Collects lightweight feedback; submission is best-effort (logs to console if
 * no analytics endpoint is wired up).
 */
export default function UninstallPage() {
  const [selected, setSelected] = useState<Reason | ''>('')
  const [comment, setComment] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selected) return
    setSubmitting(true)

    // Best-effort POST — the endpoint is optional; failure is silently swallowed.
    try {
      await fetch('/api/uninstall-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: selected, comment: comment.trim() }),
      })
    } catch (_) {
      // Non-critical — always show success regardless of network failure.
    }

    setSubmitting(false)
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className="login-page" style={{ background: 'var(--bg)' }}>
        <div className="login-card" style={{ maxWidth: 460, textAlign: 'center' }}>
          {/* Thank-you icon */}
          <div style={{ margin: '0 auto 18px', width: 56, height: 56 }}>
            <svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="28" cy="28" r="28" fill="rgba(34,197,94,0.1)" />
              <path d="M18 28.5l7 7 13-13" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="login-title" style={{ marginBottom: 10 }}>Thanks for your feedback</div>
          <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Your response helps us improve Workflow Automator for everyone.
            If you ever change your mind, we&rsquo;ll be right here.
          </p>
          <a
            href="https://chromewebstore.google.com"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost"
            style={{ marginTop: 28, display: 'inline-flex', justifyContent: 'center', textDecoration: 'none' }}
          >
            Reinstall Extension
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page" style={{ background: 'var(--bg)', alignItems: 'flex-start', paddingTop: 64 }}>
      <div className="login-card" style={{ maxWidth: 520, width: '100%' }}>

        {/* Sad-face SVG icon — inline, no <img> */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
            <circle cx="28" cy="28" r="27" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" fill="#1a1a24"/>
            {/* eyes */}
            <circle cx="21" cy="23" r="2.5" fill="var(--text-muted)"/>
            <circle cx="35" cy="23" r="2.5" fill="var(--text-muted)"/>
            {/* sad mouth */}
            <path d="M20 36c2-4 14-4 16 0" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" fill="none"/>
          </svg>
        </div>

        <div className="login-title" style={{ marginBottom: 6 }}>Sorry to see you go</div>
        <p className="login-sub" style={{ textAlign: 'center', marginBottom: 28 }}>
          Help us understand what went wrong. It only takes 10 seconds.
        </p>

        <form onSubmit={handleSubmit}>
          {/* Reason selection */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {REASONS.map((reason) => {
              const isActive = selected === reason
              return (
                <label
                  key={reason}
                  id={`reason-${reason.replace(/\s+/g, '-').toLowerCase()}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '11px 14px',
                    background: isActive ? 'rgba(124,58,237,0.12)' : 'var(--bg3)',
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                >
                  <input
                    type="radio"
                    name="reason"
                    value={reason}
                    checked={isActive}
                    onChange={() => setSelected(reason)}
                    style={{ accentColor: 'var(--accent)', width: 16, height: 16, flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 14, color: isActive ? 'var(--text)' : 'var(--text-muted)' }}>
                    {reason}
                  </span>
                </label>
              )
            })}
          </div>

          {/* Optional comment */}
          <div className="form-group">
            <label className="form-label" htmlFor="uninstall-comment">
              Anything else you&rsquo;d like us to know? <span style={{ opacity: 0.5 }}>(optional)</span>
            </label>
            <textarea
              id="uninstall-comment"
              className="form-input"
              style={{ minHeight: 88, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Tell us more…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={600}
            />
          </div>

          {!selected && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              Please select a reason to continue.
            </p>
          )}

          <button
            id="uninstall-submit"
            type="submit"
            className="form-submit"
            disabled={!selected || submitting}
          >
            {submitting ? 'Sending…' : 'Send Feedback'}
          </button>
        </form>

        <div className="form-hint" style={{ marginTop: 20 }}>
          Changed your mind?{' '}
          <a
            href="https://chromewebstore.google.com"
            target="_blank"
            rel="noopener noreferrer"
            className="link-btn"
          >
            Reinstall Workflow Automator
          </a>
        </div>
      </div>
    </div>
  )
}
