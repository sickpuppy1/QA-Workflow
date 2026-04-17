'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

interface Checkpoint {
  id: string
  index: number
  label: string | null
  checkpointType: string | null
  dataUrl: string | null
  capturedData: string | null
}

interface RecordingScreenshot {
  id: string
  index: number
  label: string | null
  dataUrl: string
}

interface Run {
  id: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  checkpoints: Checkpoint[]
  workflow: {
    id: string
    name: string
    recordedAt: string
    events: any[]
    screenshots: RecordingScreenshot[]
  }
}

// ─── JSON diff helpers ────────────────────────────────────────────────────────

type DiffLine = {
  line: string
  status: 'match' | 'mismatch' | 'only-left' | 'only-right'
}

type InlinePart = { text: string; highlight: boolean }

/** Normalise any value to a pretty-printed JSON string (line array). */
function toLines(value: unknown): string[] {
  // treat null, undefined, and empty string identically — no lines
  if (value == null || value === '') return []
  let str: string
  if (typeof value === 'string') {
    try { str = JSON.stringify(JSON.parse(value), null, 2) } catch { str = value }
  } else {
    try { str = JSON.stringify(value, null, 2) } catch { str = String(value) }
  }
  // Drop a trailing empty line produced by trailing newlines
  const lines = str.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/** Produce a side-by-side diff of two value arrays. */
function buildDiff(left: unknown, right: unknown): { left: DiffLine[]; right: DiffLine[] } {
  const lLines = toLines(left)
  const rLines = toLines(right)
  const len = Math.max(lLines.length, rLines.length)

  const leftOut: DiffLine[] = []
  const rightOut: DiffLine[] = []

  for (let i = 0; i < len; i++) {
    const l = lLines[i]
    const r = rLines[i]

    if (l === undefined) {
      leftOut.push({ line: '', status: 'only-right' })
      rightOut.push({ line: r, status: 'only-right' })
    } else if (r === undefined) {
      leftOut.push({ line: l, status: 'only-left' })
      rightOut.push({ line: '', status: 'only-left' })
    } else if (l === r) {
      leftOut.push({ line: l, status: 'match' })
      rightOut.push({ line: r, status: 'match' })
    } else {
      leftOut.push({ line: l, status: 'mismatch' })
      rightOut.push({ line: r, status: 'mismatch' })
    }
  }

  return { left: leftOut, right: rightOut }
}

/**
 * Character-level inline diff using common-prefix / common-suffix trimming.
 * Only the "middle" changed segment is highlighted — not the whole line.
 */
function getInlineParts(left: string, right: string): { leftParts: InlinePart[]; rightParts: InlinePart[] } {
  let ps = 0
  while (ps < left.length && ps < right.length && left[ps] === right[ps]) ps++

  let ls = left.length - 1
  let rs = right.length - 1
  while (ls >= ps && rs >= ps && left[ls] === right[rs]) { ls--; rs-- }

  const prefix = left.slice(0, ps)
  const lMid   = left.slice(ps, ls + 1)
  const rMid   = right.slice(ps, rs + 1)
  const suffix  = left.slice(ls + 1) // equal suffix for both

  return {
    leftParts:  [{ text: prefix, highlight: false }, { text: lMid, highlight: lMid.length > 0 }, { text: suffix, highlight: false }],
    rightParts: [{ text: prefix, highlight: false }, { text: rMid, highlight: rMid.length > 0 }, { text: suffix, highlight: false }],
  }
}

function diffLineStyle(status: DiffLine['status']): React.CSSProperties {
  switch (status) {
    case 'mismatch':
      // Subtle row tint — the specific chars are highlighted separately
      return { background: 'rgba(234,179,8,0.06)', borderLeft: '3px solid #ca8a04' }
    case 'only-left':
      return { background: 'rgba(239,68,68,0.12)', borderLeft: '3px solid #ef4444' }
    case 'only-right':
      return { background: 'rgba(34,197,94,0.12)', borderLeft: '3px solid #22c55e' }
    default:
      return { borderLeft: '3px solid transparent' }
  }
}



// ─── Component ────────────────────────────────────────────────────────────────

/** Side-by-side recording vs playback comparison for one run, with checkpoint navigation. */
export default function ComparisonClient({ run, workflowId }: { run: Run; workflowId: string }) {
  const router = useRouter()
  const [activeIndex, setActiveIndex] = useState(0)
  const [isMounted, setIsMounted] = useState(false)
  const [jsonCompare, setJsonCompare] = useState(false)
  const [navWidth, setNavWidth] = useState(240)
  const isResizing = useRef(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // ── Sidebar resize drag ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isMounted) return
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const next = Math.min(400, Math.max(160, e.clientX))
      setNavWidth(next)
    }
    const onUp = () => { isResizing.current = false; document.body.style.cursor = '' }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [isMounted])

  useEffect(() => {
    if (!isMounted) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't navigate if user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === 'ArrowLeft') {
        setActiveIndex(prev => Math.max(0, prev - 1))
      } else if (e.key === 'ArrowRight') {
        setActiveIndex(prev => Math.min(run.checkpoints.length - 1, prev + 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isMounted, run.checkpoints.length])

  function fmtDate(iso: string) {
    if (!isMounted) {
      return new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
    }
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  // Derive recording-time checkpoint events in order (to match by position)
  const recordingCheckpointEvents: any[] = (run.workflow.events || []).filter(
    (e: any) => e.type === 'checkpoint' || e.type === 'console_checkpoint' || e.type === 'network_checkpoint'
  )

  let screenshotCpIdx = 0
  const pairs = run.checkpoints.map((cp, i) => {
    let recording: RecordingScreenshot | null = null
    const isScreenshot = cp.checkpointType !== 'console' && cp.checkpointType !== 'network'
    
    if (isScreenshot) {
      recording = run.workflow.screenshots.find(s => s.index === screenshotCpIdx) ?? null
      screenshotCpIdx++
    }

    return {
      checkpoint: cp,
      recording,
      // Matches the i-th checkpoint of playback run to the i-th parsed checkpoint event from recording run
      recordingEvent: recordingCheckpointEvents[i] ?? null,
    }
  })

  const active = pairs[activeIndex]
  const isFailed = run.status === 'failed'
  const isPassed = run.status === 'passed'

  // Parse capturedData JSON safely
  function parseCapturedData(cp: Checkpoint): any {
    if (!cp.capturedData) return null
    try { return JSON.parse(cp.capturedData) } catch { return null }
  }

  function cpTypeLabel(type: string | null) {
    if (type === 'console') return 'Console Log'
    if (type === 'network') return 'Network Request'
    return 'Screenshot'
  }

  function cpTypeBadgeStyle(type: string | null): React.CSSProperties {
    if (type === 'console') return { background: 'rgba(234,179,8,0.15)', color: '#ca8a04', border: '1px solid rgba(234,179,8,0.3)' }
    if (type === 'network') return { background: 'rgba(59,130,246,0.15)', color: '#3b82f6', border: '1px solid rgba(59,130,246,0.3)' }
    return { background: 'rgba(168,85,247,0.15)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.3)' }
  }

  function methodBadgeStyle(method: string | null): React.CSSProperties {
    const m = (method || '').toUpperCase()
    let bg = 'var(--bg3)', color = 'var(--text)', borderColor = 'var(--border)'

    if (m === 'GET') { bg = 'rgba(59,130,246,0.15)'; color = '#93c5fd'; borderColor = 'rgba(59,130,246,0.4)'; }
    else if (m === 'POST') { bg = 'rgba(20,184,166,0.15)'; color = '#5eead4'; borderColor = 'rgba(20,184,166,0.4)'; }
    else if (m === 'PUT' || m === 'PATCH') { bg = 'rgba(245,158,11,0.15)'; color = '#fcd34d'; borderColor = 'rgba(245,158,11,0.4)'; }
    else if (m === 'DELETE') { bg = 'rgba(239,68,68,0.15)'; color = '#fca5a5'; borderColor = 'rgba(239,68,68,0.4)'; }

    return {
      background: bg, color, border: `1px solid ${borderColor}`,
      fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace',
      fontSize: 11, padding: '4px 10px', textTransform: 'uppercase', letterSpacing: '0.05em',
      fontWeight: 700, borderRadius: '6px'
    }
  }

  function statusBadgeStyle(status: number | null | undefined): React.CSSProperties {
    const base: React.CSSProperties = { 
      fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace', 
      fontSize: 11, padding: '4px 10px', fontWeight: 600, borderRadius: '6px', letterSpacing: '0.05em' 
    }
    if (!status) return { ...base, background: 'var(--bg3)', color: 'var(--text-muted)', border: '1px solid var(--border)' }
    if (status >= 200 && status < 300) return { ...base, background: 'rgba(34,197,94,0.15)', color: '#86efac', border: '1px solid rgba(34,197,94,0.4)' }
    if (status >= 300 && status < 400) return { ...base, background: 'rgba(168,85,247,0.15)', color: '#d8b4fe', border: '1px solid rgba(168,85,247,0.4)' }
    if (status >= 400 && status < 500) return { ...base, background: 'rgba(234,179,8,0.15)', color: '#fde047', border: '1px solid rgba(234,179,8,0.4)' }
    return { ...base, background: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.4)' }
  }

  function monoBlock(content: string | null | undefined, placeholder = '—') {
    return (
      <div className="mono-block" style={{
        fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace', 
        fontSize: 12, background: '#13131a',
        border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0',
        minHeight: 48, maxHeight: 300, overflowY: 'auto', lineHeight: 1.6,
      }}>
        {content ?? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{placeholder}</span>}
      </div>
    )
  }

  function prettyValue(value: unknown): string | null {
    if (value == null) return null
    if (typeof value === 'string') {
      try {
        return JSON.stringify(JSON.parse(value), null, 2)
      } catch {
        return value
      }
    }
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  // ─── JSON Diff renderer ───────────────────────────────────────────────────

  /** Renders a single code line with inline char-level highlights for mismatch lines. */
  function renderInlineLine(
    dl: DiffLine,
    counterpartLine: string,
    side: 'left' | 'right',
    idx: number,
  ) {
    const lineNumStyle: React.CSSProperties = {
      display: 'inline-block', minWidth: 36, textAlign: 'right',
      paddingRight: 10, paddingLeft: 8, color: '#4b5563', userSelect: 'none', flexShrink: 0,
    }

    const rowStyle: React.CSSProperties = {
      display: 'flex', alignItems: 'flex-start',
      ...diffLineStyle(dl.status),
    }

    // For mismatch lines render inline char-level diff
    if (dl.status === 'mismatch') {
      const other = counterpartLine
      const { leftParts, rightParts } = getInlineParts(dl.line, other)
      const parts = side === 'left' ? leftParts : rightParts
      return (
        <div key={idx} style={rowStyle}>
          <span style={lineNumStyle}>{idx + 1}</span>
          <span style={{
            flex: 1, paddingRight: 10, paddingTop: 1, paddingBottom: 1,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0',
          }}>
            {parts.map((p, pi) =>
              p.highlight && p.text ? (
                <mark key={pi} style={{
                  background: 'rgba(234,179,8,0.35)',
                  color: '#fde047',
                  borderRadius: 3,
                  padding: '0 1px',
                  // @ts-ignore
                  textDecoration: side === 'left' ? 'none' : 'none',
                  boxShadow: '0 0 0 1px rgba(234,179,8,0.4)',
                }}>{p.text}</mark>
              ) : (
                <span key={pi}>{p.text}</span>
              )
            )}
          </span>
        </div>
      )
    }

    // For only-left / only-right / match: plain coloured line
    const color = dl.status === 'only-left' ? '#fca5a5'
                : dl.status === 'only-right' ? '#86efac'
                : '#e2e8f0'
    return (
      <div key={idx} style={rowStyle}>
        <span style={lineNumStyle}>{idx + 1}</span>
        <span style={{
          flex: 1, paddingRight: 10, paddingTop: 1, paddingBottom: 1,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', color,
        }}>{dl.line || ' '}</span>
      </div>
    )
  }

  function renderJsonDiffBlock(title: string, leftVal: unknown, rightVal: unknown) {
    const { left, right } = buildDiff(leftVal, rightVal)
    const hasDiffs = left.some(l => l.status !== 'match')
    const mismatchCount = left.filter(l => l.status !== 'match').length

    const panelStyle: React.CSSProperties = {
      fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, Courier, monospace',
      fontSize: 12, background: '#0d0d14',
      border: '1px solid var(--border)', borderRadius: 8,
      minHeight: 48, maxHeight: 320, overflowY: 'auto', lineHeight: 1.6,
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {title}
          </div>
          {hasDiffs ? (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: 'rgba(234,179,8,0.15)', color: '#fde047', border: '1px solid rgba(234,179,8,0.3)',
            }}>
              {mismatchCount} diff{mismatchCount !== 1 ? 's' : ''}
            </span>
          ) : (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: 'rgba(34,197,94,0.15)', color: '#86efac', border: '1px solid rgba(34,197,94,0.3)',
            }}>
              Identical
            </span>
          )}
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
          <span><span style={{ color: '#fde047', marginRight: 4 }}>●</span>Changed chars</span>
          <span><span style={{ color: '#fca5a5', marginRight: 4 }}>●</span>Only in Expected</span>
          <span><span style={{ color: '#86efac', marginRight: 4 }}>●</span>Only in Captured</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {/* Expected (left) */}
          <div style={panelStyle}>
            <div style={{
              padding: '6px 10px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)', letterSpacing: '0.05em',
            }}>EXPECTED</div>
            {left.length === 0
              ? <div style={{ padding: '10px 14px', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</div>
              : left.map((dl, idx) => renderInlineLine(dl, right[idx]?.line ?? '', 'left', idx))
            }
          </div>
          {/* Captured (right) */}
          <div style={panelStyle}>
            <div style={{
              padding: '6px 10px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)', letterSpacing: '0.05em',
            }}>CAPTURED</div>
            {right.length === 0
              ? <div style={{ padding: '10px 14px', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</div>
              : right.map((dl, idx) => renderInlineLine(dl, left[idx]?.line ?? '', 'right', idx))
            }
          </div>
        </div>
      </div>
    )
  }

  // ─── Original helpers ─────────────────────────────────────────────────────

  function renderLogContext(title: string, logs: any[] | null | undefined) {
    const lines = Array.isArray(logs) ? logs.filter(Boolean) : []
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
        {lines.length === 0
          ? monoBlock(null, 'No surrounding log')
          : monoBlock(lines.map((line) => {
              const level = (line?.level || 'log').toUpperCase()
              const message = line?.message || '—'
              return `[${level}] ${message}`
            }).join('\n'))}
      </div>
    )
  }

  function renderDetailBlock(title: string, value: unknown, placeholder: string) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
        {monoBlock(prettyValue(value), placeholder)}
      </div>
    )
  }

  // ─── JSON Compare toggle (iOS-style switch) ───────────────────────────────

  function renderJsonCompareToggle(canCompare: boolean) {
    const active = jsonCompare && canCompare
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4,
        opacity: canCompare ? 1 : 0.35,
        pointerEvents: canCompare ? 'auto' : 'none',
      }}
        title={canCompare ? 'Toggle inline JSON diff view' : 'Only available for Network / Console checkpoints'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Icon */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: active ? '#a5b4fc' : '#6b7280', transition: 'color 0.2s' }}>
            <rect x="1" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.4"/>
            <rect x="10" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M6.5 8h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M7.5 6.5L6 8l1.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M8.5 6.5L10 8l-1.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
            color: active ? '#c7d2fe' : '#6b7280',
            transition: 'color 0.2s',
            textTransform: 'uppercase',
            fontFamily: 'SFMono-Regular, Consolas, monospace',
          }}>JSON Diff</span>
          {/* Toggle pill */}
          <button
            id="json-compare-toggle"
            role="switch"
            aria-checked={active}
            onClick={() => canCompare && setJsonCompare(v => !v)}
            style={{
              position: 'relative', display: 'inline-flex', alignItems: 'center',
              width: 40, height: 22, borderRadius: 11,
              background: active
                ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                : 'rgba(255,255,255,0.07)',
              border: `1px solid ${active ? 'rgba(99,102,241,0.6)' : 'rgba(255,255,255,0.10)'}`,
              cursor: 'pointer', transition: 'all 0.22s cubic-bezier(.4,0,.2,1)',
              boxShadow: active ? '0 0 10px rgba(99,102,241,0.4)' : 'none',
              padding: 0,
              flexShrink: 0,
            }}
          >
            {/* Thumb */}
            <span style={{
              position: 'absolute',
              left: active ? 20 : 2,
              width: 16, height: 16, borderRadius: '50%',
              background: active ? '#fff' : '#6b7280',
              boxShadow: active ? '0 1px 4px rgba(0,0,0,0.4)' : 'none',
              transition: 'left 0.22s cubic-bezier(.4,0,.2,1), background 0.22s',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {active && (
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path d="M1.5 4l1.5 1.5L6.5 2.5" stroke="#6366f1" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </span>
          </button>
        </div>
        {/* Status line under toggle */}
        <span style={{
          fontSize: 10, color: active ? '#818cf8' : 'transparent',
          transition: 'color 0.2s', fontWeight: 600, letterSpacing: '0.04em',
          fontFamily: 'SFMono-Regular, Consolas, monospace',
        }}>char-level diff ON</span>
      </div>
    )
  }

  // ─── Main compare pane ────────────────────────────────────────────────────

  function renderComparePane() {
    if (!active) return null
    const { checkpoint: cp, recording, recordingEvent } = active
    const type = cp.checkpointType
    const captured = parseCapturedData(cp)

    if (type === 'console') {
      const expectedMsg: string = recordingEvent?.logMessage ?? null
      const capturedMsg: string | null = captured?.capturedMessage ?? null
      const matched: boolean = captured?.matched ?? false

      if (jsonCompare) {
        // Helper: map a context log array to a display string, returning null for empty/missing arrays
        const ctxStr = (arr: any[] | null | undefined): string | null => {
          if (!Array.isArray(arr) || arr.length === 0) return null
          return arr.map((l: any) => `[${(l?.level || 'log').toUpperCase()}] ${l?.message || '—'}`).join('\n')
        }
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {renderJsonDiffBlock('Log Message', expectedMsg, capturedMsg)}
            {renderJsonDiffBlock('Context Before', ctxStr(captured?.expectedContextBefore), ctxStr(captured?.capturedContextBefore))}
            {renderJsonDiffBlock('Context After',  ctxStr(captured?.expectedContextAfter),  ctxStr(captured?.capturedContextAfter))}
          </div>
        )
      }

      return (
        <div className="compare-grid">
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Expected Log (Recording)</span>
              <span className="badge" style={cpTypeBadgeStyle('console')}>Console</span>
            </div>
            <div style={{ padding: '16px' }}>
              {monoBlock(expectedMsg, 'No log message recorded')}
              <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
                {renderLogContext('One Log Before', captured?.expectedContextBefore)}
                {renderLogContext('One Log After', captured?.expectedContextAfter)}
              </div>
            </div>
            <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
          </div>
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Captured Log (Playback)</span>
              <span className="badge" style={matched ? { background: 'rgba(34,197,94,0.15)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' } : { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                {matched ? 'Matched' : 'Not Matched'}
              </span>
            </div>
            <div style={{ padding: '16px' }}>
              {monoBlock(capturedMsg, 'No matching log captured')}
              <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
                {renderLogContext('One Log Before', captured?.capturedContextBefore)}
                {renderLogContext('One Log After', captured?.capturedContextAfter)}
              </div>
            </div>
            <div className="compare-label">Played: {fmtDate(run.playedAt)}</div>
          </div>
        </div>
      )
    }

    if (type === 'network') {
      const expMethod: string = recordingEvent?.networkMethod ?? ''
      const expUrl: string = recordingEvent?.networkUrl ?? ''
      const expStatus: number = recordingEvent?.networkStatus ?? null
      const capMethod: string | null = captured?.capturedMethod ?? null
      const capUrl: string | null = captured?.capturedUrl ?? null
      const capStatus: number | null = captured?.capturedStatus ?? null
      const matched: boolean = captured?.matched ?? false

      if (jsonCompare) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {renderJsonDiffBlock('URL', expUrl || null, capUrl)}
            {renderJsonDiffBlock(
              'Request Headers',
              captured?.expectedRequestHeaders,
              captured?.requestHeaders,
            )}
            {renderJsonDiffBlock(
              'Request Payload',
              captured?.expectedRequestBody,
              captured?.requestBody,
            )}
            {renderJsonDiffBlock(
              'Response Headers',
              captured?.expectedResponseHeaders,
              captured?.responseHeaders,
            )}
            {renderJsonDiffBlock(
              'Response Payload',
              captured?.expectedResponseBody,
              captured?.responseBody,
            )}
          </div>
        )
      }

      return (
        <div className="compare-grid">
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Expected Request (Recording)</span>
              <span className="badge" style={cpTypeBadgeStyle('network')}>Network</span>
            </div>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={methodBadgeStyle(expMethod)}>{expMethod || '—'}</span>
                <span className="badge" style={statusBadgeStyle(expStatus)}>{expStatus ?? '—'}</span>
              </div>
              {monoBlock(expUrl || null, 'No URL recorded')}
              {renderDetailBlock('Request Headers', captured?.expectedRequestHeaders, 'No request headers recorded')}
              {renderDetailBlock('Request Payload', captured?.expectedRequestBody, 'No request payload recorded')}
              {renderDetailBlock('Response Headers', captured?.expectedResponseHeaders, 'No response headers recorded')}
              {renderDetailBlock('Response Payload', captured?.expectedResponseBody, 'No response payload recorded')}
            </div>
            <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
          </div>
          <div className="compare-panel">
            <div className="compare-panel-header">
              <span>Captured Request (Playback)</span>
              <span className="badge" style={matched ? { background: 'rgba(34,197,94,0.15)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.3)' } : { background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                {matched ? 'Matched' : 'Not Matched'}
              </span>
            </div>
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge" style={methodBadgeStyle(capMethod)}>{capMethod || '—'}</span>
                <span className="badge" style={statusBadgeStyle(capStatus ?? undefined)}>{capStatus ?? '—'}</span>
              </div>
              {monoBlock(capUrl, 'No matching request captured')}
              {renderDetailBlock('Request Headers', captured?.requestHeaders, 'No request headers captured')}
              {renderDetailBlock('Request Payload', captured?.requestBody, 'No request payload captured')}
              {renderDetailBlock('Response Headers', captured?.responseHeaders, 'No response headers captured')}
              {renderDetailBlock('Response Payload', captured?.responseBody, 'No response payload captured')}
            </div>
            <div className="compare-label">Played: {fmtDate(run.playedAt)}</div>
          </div>
        </div>
      )
    }

    // Default: screenshot comparison
    return (
      <div className="compare-grid">
        <div className="compare-panel">
          <div className="compare-panel-header">
            <span>Recording Baseline</span>
            <span className="badge badge-purple">{recording?.label || `CP ${activeIndex + 1}`}</span>
          </div>
          {recording ? (
            <img
              id={`baseline-img-${activeIndex}`}
              src={recording.dataUrl}
              alt="Recording baseline"
            />
          ) : (
            <div className="empty-state" style={{ padding: 40, background: 'var(--bg3)' }}>
              <div className="empty-icon" aria-hidden="true" />
              <div className="empty-title">No baseline screenshot</div>
              <div className="empty-desc">No recording screenshot found for this checkpoint index.</div>
            </div>
          )}
          <div className="compare-label">Recorded: {fmtDate(run.workflow.recordedAt)}</div>
        </div>
        <div className="compare-panel">
          <div className="compare-panel-header">
            <span>Playback Result</span>
            <span className="badge badge-green">{cp.label || `CP ${activeIndex + 1}`}</span>
          </div>
          {cp.dataUrl ? (
            <img
              id={`playback-img-${activeIndex}`}
              src={cp.dataUrl}
              alt="Playback result"
            />
          ) : (
            <div className="empty-state" style={{ padding: 40, background: 'var(--bg3)' }}>
              <div className="empty-icon" aria-hidden="true" />
              <div className="empty-title">No playback screenshot</div>
              <div className="empty-desc">No screenshot was captured for this checkpoint.</div>
            </div>
          )}
          <div className="compare-label">Played: {fmtDate(run.playedAt)}</div>
        </div>
      </div>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const activeType = active?.checkpoint.checkpointType ?? null
  const canCompare = activeType === 'network' || activeType === 'console'

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar" style={{ width: navWidth, minWidth: navWidth, maxWidth: navWidth, flexShrink: 0 }}>
        {/* Drag-resize handle on right edge */}
        <div
          onMouseDown={e => {
            e.preventDefault()
            isResizing.current = true
            document.body.style.cursor = 'col-resize'
          }}
          style={{
            position: 'absolute',
            right: 0, top: 0, bottom: 0,
            width: 6,
            cursor: 'col-resize',
            zIndex: 10,
            background: 'transparent',
            transition: 'background 0.15s',
          }}
          title="Drag to resize sidebar"
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,58,237,0.35)')}
          onMouseLeave={e => { if (!isResizing.current) e.currentTarget.style.background = 'transparent' }}
        />
        <div className="sidebar-logo">
          <img src="/icon.svg" alt="Logo" className="sidebar-logo-icon-img" />
          <div>
            <div className="sidebar-logo-text">Workflow Automator</div>
            <div className="sidebar-logo-sub">Workflow Studio</div>
          </div>
        </div>
        <Link href="/" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="nav-text">All Workflows</span>
        </Link>
        <Link href="/settings" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="nav-text">Settings</span>
        </Link>
        <div className="nav-item" onClick={() => router.push(`/workflows/${workflowId}`)} style={{ cursor: 'pointer' }}>
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
          <span className="nav-text">Workflow Detail</span>
        </div>
        <div className="nav-item active">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
          </svg>
          <span className="nav-text">Comparison</span>
        </div>

        <hr className="divider" />
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', padding: '0 8px', marginBottom: 8 }}>
          CHECKPOINTS
        </div>
        {pairs.map((pair, i) => {
          const cpColor = pair.checkpoint.checkpointType === 'console' ? 'var(--yellow)' :
                          pair.checkpoint.checkpointType === 'network' ? 'var(--blue)' : 'var(--accent-light)';
          
          return (
          <button
            key={i}
            id={`checkpoint-selector-${i}`}
            className={`nav-item ${i === activeIndex ? 'active' : ''}`}
            onClick={() => setActiveIndex(i)}
            title={pair.checkpoint.label || `CP ${i + 1}`}
            style={i === activeIndex ? { borderLeft: `3px solid ${cpColor}` } : { borderLeft: '3px solid transparent' }}
          >
            <span className="nav-icon" aria-hidden="true" style={{ color: cpColor, fontWeight: 'bold', fontSize: 11 }}>
              {pair.recording || pair.checkpoint.capturedData ? 'OK' : '!'}
            </span>
            <span className="nav-text">{pair.checkpoint.label || `CP ${i + 1}`}</span>
          </button>
        )})}</nav>

      <main className="main">
        <div className="page-header" style={{ position: 'relative' }}>
          <div className="breadcrumb" onClick={() => router.push(`/workflows/${workflowId}`)}>
            ← Back to {run.workflow.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="page-title">Checkpoint Comparison</div>
            {isPassed && <span className="badge badge-green">Passed</span>}
            {isFailed && <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Failed</span>}
            {run.status === 'aborted' && <span className="badge" style={{ background: 'var(--bg3)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>Aborted</span>}
          </div>
          <div className="page-subtitle">
            Playback on {fmtDate(run.playedAt)} · {run.checkpoints.length} checkpoints
          </div>
        </div>

        <div className="content">
          {isFailed && (
            <div style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 20,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}>
              <span style={{ fontSize: 18 }} aria-hidden="true">!</span>
              <div>
                <div style={{ fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>
                  Test Failed — Step {(run.failedEventIndex ?? 0) + 1}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  Event type: <strong style={{ color: 'var(--text)' }}>{run.failedEventType ?? 'unknown'}</strong>
                  {run.failedEventSelector && (
                    <> · Selector: <code style={{ fontSize: 12, background: 'var(--bg3)', padding: '1px 6px', borderRadius: 4 }}>{run.failedEventSelector.slice(0, 80)}</code></>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  The target element could not be found in the page. The workflow stopped at this step.
                </div>
              </div>
            </div>
          )}

          {pairs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true" />
              <div className="empty-title">No checkpoints in this run</div>
              <div className="empty-desc">This playback run did not capture any checkpoints.</div>
            </div>
          ) : active ? (
            <>
              {/* Checkpoint nav pills */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
                {pairs.map((pair, i) => (
                  <button
                    key={i}
                    id={`cp-pill-${i}`}
                    onClick={() => setActiveIndex(i)}
                    className="btn"
                    style={{
                      padding: '6px 14px', fontSize: 12,
                      background: i === activeIndex ? 'var(--accent)' : 'var(--bg3)',
                      color: i === activeIndex ? 'white' : 'var(--text-muted)',
                      border: `1px solid ${i === activeIndex ? 'var(--accent)' : 'var(--border)'}`,
                    }}
                  >
                    <span style={{ marginRight: 4 }}>{cpTypeLabel(pair.checkpoint.checkpointType)}</span>
                    {pair.checkpoint.label || `CP ${i + 1}`}
                  </button>
                ))}
              </div>

              {/* Checkpoint type badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span className="badge" style={cpTypeBadgeStyle(active.checkpoint.checkpointType)}>
                  {cpTypeLabel(active.checkpoint.checkpointType)}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {active.checkpoint.label || `Checkpoint ${activeIndex + 1}`}
                </span>
                {jsonCompare && canCompare && (
                  <span style={{
                    fontSize: 11, padding: '2px 10px', borderRadius: 20,
                    background: 'rgba(99,102,241,0.15)', color: '#a5b4fc',
                    border: '1px solid rgba(99,102,241,0.4)',
                    fontWeight: 600,
                  }}>
                    ⇄ JSON Diff Mode
                  </span>
                )}
              </div>

              {/* Type-aware comparison pane — with JSON Diff toggle above it, right-aligned */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 10 }}>
                {renderJsonCompareToggle(canCompare)}
              </div>
              {renderComparePane()}

              {/* Summary / nav bar */}
              <div className="card" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 20 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                    {active.checkpoint.label || `Checkpoint ${activeIndex + 1}`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {cpTypeLabel(active.checkpoint.checkpointType)} checkpoint
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    id="prev-cp-btn"
                    className="btn btn-ghost"
                    disabled={activeIndex === 0}
                    onClick={() => setActiveIndex(i => Math.max(0, i - 1))}
                  >
                    ← Prev
                  </button>
                  <button
                    id="next-cp-btn"
                    className="btn btn-ghost"
                    disabled={activeIndex === pairs.length - 1}
                    onClick={() => setActiveIndex(i => Math.min(pairs.length - 1, i + 1))}
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  )
}
