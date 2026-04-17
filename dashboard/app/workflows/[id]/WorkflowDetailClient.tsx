'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'

// ─── Event type helpers ───────────────────────────────────────────────────────

type CheckpointEvent =
  | { type: 'checkpoint';         label: string; screenshotIndex: number; url: string; timestamp: number }
  | { type: 'console_checkpoint'; label: string; logMessage: string;      url: string; timestamp: number }
  | { type: 'network_checkpoint'; label: string; networkUrl: string; networkMethod: string; networkStatus: number; url: string; timestamp: number }

function isCheckpointEvent(e: any): e is CheckpointEvent {
  return e?.type === 'checkpoint' || e?.type === 'console_checkpoint' || e?.type === 'network_checkpoint'
}

interface Screenshot {
  id: string
  index: number
  label: string | null
  dataUrl: string
  url: string | null
}

interface Run {
  id: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  _count: { checkpoints: number }
}

interface Workflow {
  id: string
  name: string
  recordedAt: string
  events: any[]
  dynamicInputs?: DynamicInputs | null
  screenshots: Screenshot[]
  runs: Run[]
}

type DynamicDateRangeVariable = {
  kind: 'date_range'
  start: string
  end: string
  stepUnit: 'day' | 'week' | 'month'
  stepValue: number
  output: 'date' | 'datetime-local' | 'text'
}

type DynamicNumberSequenceVariable = {
  kind: 'number_sequence'
  start: number
  step: number
  decimals: number | null
  min: number | null
  max: number | null
}

type DynamicVariable = DynamicDateRangeVariable | DynamicNumberSequenceVariable

type DynamicBinding = {
  eventIndex: number
  variableKey: string
  selector: string | null
  mode: 'replace'
}

type DynamicInputs = {
  version: 1
  variables: Record<string, DynamicVariable>
  bindings: DynamicBinding[]
}

type DynamicSuggestion = {
  eventIndex: number
  selector: string | null
  kind: 'date_range' | 'number_sequence'
  inputType: string
  sourceType: 'click' | 'input' | 'change'
  rawValue: string
  numericValue?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeDynamicInputs(input: unknown): DynamicInputs {
  if (!isRecord(input)) {
    return { version: 1, variables: {}, bindings: [] }
  }
  const rawVariables = isRecord(input.variables) ? input.variables : {}
  const rawBindings = Array.isArray(input.bindings) ? input.bindings : []
  const variables: Record<string, DynamicVariable> = {}

  Object.entries(rawVariables).forEach(([key, variable]) => {
    if (!key || !isRecord(variable)) return
    if (variable.kind === 'date_range') {
      variables[key] = {
        kind: 'date_range',
        start: typeof variable.start === 'string' ? variable.start : '',
        end: typeof variable.end === 'string' ? variable.end : '',
        stepUnit: variable.stepUnit === 'week' || variable.stepUnit === 'month' ? variable.stepUnit : 'day',
        stepValue: Math.max(1, Math.trunc(clampNumber(variable.stepValue, 1, 365, 1))),
        output: variable.output === 'datetime-local' || variable.output === 'text' ? variable.output : 'date',
      }
    } else if (variable.kind === 'number_sequence') {
      variables[key] = {
        kind: 'number_sequence',
        start: clampNumber(variable.start, -1e12, 1e12, 0),
        step: clampNumber(variable.step, -1e9, 1e9, 1),
        decimals:
          variable.decimals == null
            ? null
            : Math.max(0, Math.min(8, Math.trunc(clampNumber(variable.decimals, 0, 8, 0)))),
        min: variable.min == null ? null : clampNumber(variable.min, -1e12, 1e12, -1e12),
        max: variable.max == null ? null : clampNumber(variable.max, -1e12, 1e12, 1e12),
      }
    }
  })

  const bindings = rawBindings
    .map((binding): DynamicBinding | null => {
      if (!isRecord(binding)) return null
      const variableKey = typeof binding.variableKey === 'string' ? binding.variableKey : ''
      const eventIndex = Math.max(0, Math.trunc(clampNumber(binding.eventIndex, 0, 1e6, -1)))
      if (!variableKey || eventIndex < 0 || !variables[variableKey]) return null
      return {
        eventIndex,
        variableKey,
        selector: typeof binding.selector === 'string' ? binding.selector : null,
        mode: 'replace',
      }
    })
    .filter((binding): binding is DynamicBinding => binding !== null)

  return {
    version: 1,
    variables,
    bindings,
  }
}

function detectDynamicSuggestions(events: any[]): DynamicSuggestion[] {
  if (!Array.isArray(events)) return []
  const out: DynamicSuggestion[] = []
  const datePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/

  events.forEach((event, eventIndex) => {
    if (!event) return
    const selector = typeof event.selector === 'string' ? event.selector : null
    const inputType = String(event.inputType || '').toLowerCase()
    const tagName = String(event.tagName || '').toLowerCase()

    if (event.type === 'click') {
      const hintText = `${selector || ''} ${event.placeholder || ''} ${event.label || ''}`.toLowerCase()
      const looksDateField =
        (tagName === 'input' || tagName === 'textarea') &&
        /date|selecteddate|range/.test(hintText) &&
        !/daterangepicker|calendar|applybtn|cancelbtn/.test(hintText)
      if (looksDateField) {
        const now = new Date()
        const year = now.getFullYear()
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const day = String(now.getDate()).padStart(2, '0')
        out.push({
          eventIndex,
          selector,
          kind: 'date_range',
          inputType: 'date-range-click',
          sourceType: 'click',
          rawValue: `${year}-${month}-${day}`,
        })
      }
      return
    }

    if (event.type !== 'input' && event.type !== 'change') return
    const rawValue = event.value
    if (typeof rawValue === 'boolean' || rawValue == null) return
    const valueText = String(rawValue).trim()
    if (!valueText) return

    const looksDate =
      inputType === 'date' ||
      inputType === 'datetime-local' ||
      datePattern.test(valueText)
    if (looksDate) {
      out.push({
        eventIndex,
        selector,
        kind: 'date_range',
        inputType,
        sourceType: event.type,
        rawValue: valueText,
      })
      return
    }

    const numeric = Number.parseFloat(valueText)
    const looksNumber =
      inputType === 'number' ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(valueText) ||
      Number.isFinite(numeric)
    if (looksNumber && Number.isFinite(numeric)) {
      out.push({
        eventIndex,
        selector,
        kind: 'number_sequence',
        inputType,
        sourceType: event.type,
        rawValue: valueText,
        numericValue: numeric,
      })
    }
  })

  return out
}

/** Single-workflow studio view: checkpoints, runs, and screenshot lightbox. */
export default function WorkflowDetailClient({
  workflow,
  dynamicBindingEnabled,
}: {
  workflow: Workflow
  dynamicBindingEnabled: boolean
}) {
  const router = useRouter()
  const [selectedImg, setSelectedImg] = useState<Screenshot | null>(null)
  const [dynamicDraft, setDynamicDraft] = useState<DynamicInputs>(() =>
    normalizeDynamicInputs(workflow.dynamicInputs)
  )
  const [dynamicSaveState, setDynamicSaveState] = useState<{ kind: 'idle' | 'saving' | 'success' | 'error'; message: string }>({
    kind: 'idle',
    message: '',
  })

  useEffect(() => {
    setDynamicDraft(normalizeDynamicInputs(workflow.dynamicInputs))
    setDynamicSaveState({ kind: 'idle', message: '' })
  }, [workflow.id, workflow.dynamicInputs])

  const dynamicSuggestions = useMemo(
    () => detectDynamicSuggestions(workflow.events || []),
    [workflow.events]
  )
  const boundEventIndexes = useMemo(
    () => new Set(dynamicDraft.bindings.map((binding) => binding.eventIndex)),
    [dynamicDraft.bindings]
  )

  function cloneDraft(prev: DynamicInputs): DynamicInputs {
    return {
      version: 1,
      variables: { ...prev.variables },
      bindings: prev.bindings.map((binding) => ({ ...binding })),
    }
  }

  function uniqueVariableKey(prefix: string, draft: DynamicInputs) {
    let idx = 1
    let key = `${prefix}_${idx}`
    while (draft.variables[key]) {
      idx += 1
      key = `${prefix}_${idx}`
    }
    return key
  }

  function toDateInputValue(source: string) {
    const parsed = new Date(source)
    if (Number.isNaN(parsed.getTime())) return ''
    const y = parsed.getFullYear()
    const m = String(parsed.getMonth() + 1).padStart(2, '0')
    const d = String(parsed.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  function addDaysIso(source: string, days: number) {
    const parsed = new Date(source)
    if (Number.isNaN(parsed.getTime())) return source
    parsed.setDate(parsed.getDate() + days)
    return toDateInputValue(parsed.toISOString())
  }

  function bindSuggestion(suggestion: DynamicSuggestion) {
    setDynamicDraft((prev) => {
      const next = cloneDraft(prev)
      const prefix = suggestion.kind === 'date_range' ? 'date_var' : 'num_var'
      const variableKey = uniqueVariableKey(prefix, next)
      if (suggestion.kind === 'date_range') {
        const normalizedDate = toDateInputValue(suggestion.rawValue) || toDateInputValue(new Date().toISOString())
        const rangeStyleOutput = suggestion.sourceType === 'click' || suggestion.inputType === 'date-range-click'
        next.variables[variableKey] = {
          kind: 'date_range',
          start: normalizedDate,
          end: addDaysIso(normalizedDate, 6),
          stepUnit: 'day',
          stepValue: 1,
          output: rangeStyleOutput
            ? 'text'
            : suggestion.inputType === 'datetime-local'
              ? 'datetime-local'
              : 'date',
        }
      } else {
        next.variables[variableKey] = {
          kind: 'number_sequence',
          start: Number.isFinite(suggestion.numericValue) ? suggestion.numericValue! : 0,
          step: 1,
          decimals: 0,
          min: null,
          max: null,
        }
      }

      const existingIdx = next.bindings.findIndex((binding) => binding.eventIndex === suggestion.eventIndex)
      const binding = {
        eventIndex: suggestion.eventIndex,
        variableKey,
        selector: suggestion.selector,
        mode: 'replace' as const,
      }
      if (existingIdx >= 0) next.bindings[existingIdx] = binding
      else next.bindings.push(binding)
      return next
    })
  }

  function removeVariable(variableKey: string) {
    setDynamicDraft((prev) => {
      const next = cloneDraft(prev)
      delete next.variables[variableKey]
      next.bindings = next.bindings.filter((binding) => binding.variableKey !== variableKey)
      return next
    })
  }

  function removeBindingAt(index: number) {
    setDynamicDraft((prev) => {
      const next = cloneDraft(prev)
      next.bindings.splice(index, 1)
      return next
    })
  }

  function variableUsageCount(variableKey: string) {
    return dynamicDraft.bindings.filter((binding) => binding.variableKey === variableKey).length
  }

  function numberSequencePreview(variable: DynamicNumberSequenceVariable) {
    const values = [0, 1, 2].map((idx) => {
      const raw = variable.start + variable.step * idx
      if (typeof variable.decimals === 'number') {
        return raw.toFixed(variable.decimals)
      }
      return String(raw)
    })
    return values.join(' -> ')
  }

  function stepBindingHint(binding: DynamicBinding) {
    const event = Array.isArray(workflow.events) ? workflow.events[binding.eventIndex] : null
    if (!event) return 'No target event details available.'
    const eventType = typeof event.type === 'string' ? event.type : 'event'
    const selector =
      typeof binding.selector === 'string' && binding.selector.trim()
        ? binding.selector
        : typeof event.selector === 'string'
          ? event.selector
          : ''
    if (selector) return `${eventType} -> ${selector}`
    return `${eventType} -> target selector unavailable`
  }

  async function saveDynamicInputs() {
    setDynamicSaveState({ kind: 'saving', message: 'Saving dynamic input config…' })
    try {
      const response = await fetch(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dynamicInputs: dynamicDraft }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || `Request failed with ${response.status}`)
      }
      const nextWorkflow = payload?.workflow
      if (nextWorkflow?.dynamicInputs) {
        setDynamicDraft(normalizeDynamicInputs(nextWorkflow.dynamicInputs))
      }
      setDynamicSaveState({ kind: 'success', message: 'Dynamic input config saved.' })
    } catch (error) {
      setDynamicSaveState({
        kind: 'error',
        message: (error as Error).message || 'Failed to save dynamic input config.',
      })
    }
  }

  /** Formats timestamps for headers and run rows (en-US). */
  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  const eventCount = Array.isArray(workflow.events) ? workflow.events.length : 0
  const passedRuns = workflow.runs.filter(r => r.status === 'passed').length
  const failedRuns = workflow.runs.filter(r => r.status === 'failed').length

  // All three checkpoint types extracted from the events JSON
  const checkpointEvents = Array.isArray(workflow.events)
    ? (workflow.events as any[]).filter(isCheckpointEvent)
    : []

  /** Downloads the workflow data as a prettified JSON file. */
  function handleExportJson() {
    const data = JSON.stringify(workflow, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflow.name.replace(/\s+/g, '-').toLowerCase() || 'workflow'}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Map screenshot-checkpoint events to their captured thumbnail (screenshots are keyed by
  // sequential index among screenshot-only checkpoints, not the overall event index).
  let ssIdx = 0
  const screenshotByEventIndex = new Map<number, Screenshot>()
  if (Array.isArray(workflow.events)) {
    (workflow.events as any[]).forEach((ev, evIdx) => {
      if (ev?.type === 'checkpoint') {
        const ss = workflow.screenshots.find(s => s.index === ssIdx)
        if (ss) screenshotByEventIndex.set(evIdx, ss)
        ssIdx++
      }
    })
  }

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className="sidebar">
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
          All Workflows
        </Link>
        <Link href="/settings" className="nav-item">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </Link>
        <div className="nav-item active">
          <svg className="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
          Detail View
        </div>
      </nav>

      <main className="main">
        <div className="page-header">
          {/* Breadcrumb */}
          <div className="breadcrumb" onClick={() => router.push('/')}>
            ← Back to all workflows
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div className="page-title">{workflow.name}</div>
            <button
              onClick={handleExportJson}
              className="btn btn-primary"
              style={{ padding: '8px 16px', fontSize: 13, gap: 8 }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Export JSON
            </button>
          </div>
          <div className="page-subtitle">Recorded {fmtDate(workflow.recordedAt)} · {eventCount} events</div>
        </div>

        <div className="content">
          {/* Stats */}
          <div className="stats-row" style={{ marginBottom: 28 }}>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--accent-light)' }}>{workflow.screenshots.length}</div>
              <div className="stat-label">Recording Checkpoints</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--green)' }}>{passedRuns}</div>
              <div className="stat-label">Passed Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: failedRuns > 0 ? 'var(--red, #ef4444)' : 'var(--text-muted)' }}>{failedRuns}</div>
              <div className="stat-label">Failed Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val" style={{ color: 'var(--blue)' }}>{eventCount}</div>
              <div className="stat-label">Recorded Events</div>
            </div>
          </div>

          {dynamicBindingEnabled && (
            <>
              <div className="section-title" style={{ marginBottom: 12 }}>Dynamic Inputs</div>
              <div
                style={{
                  background: 'var(--bg2, #111)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 28,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {dynamicDraft.bindings.length} binding{dynamicDraft.bindings.length === 1 ? '' : 's'} · {Object.keys(dynamicDraft.variables).length} variable{Object.keys(dynamicDraft.variables).length === 1 ? '' : 's'}
              </div>
              <button
                onClick={saveDynamicInputs}
                disabled={dynamicSaveState.kind === 'saving'}
                className="btn btn-primary"
                style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }}
              >
                {dynamicSaveState.kind === 'saving' ? 'Saving…' : 'Save Dynamic Inputs'}
              </button>
            </div>

            {dynamicSaveState.kind !== 'idle' && (
              <div
                style={{
                  fontSize: 11,
                  color: dynamicSaveState.kind === 'error' ? 'var(--red, #ef4444)' : dynamicSaveState.kind === 'success' ? 'var(--green, #22c55e)' : 'var(--text-muted)',
                }}
              >
                {dynamicSaveState.message}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Suggestions
              </div>
              {dynamicSuggestions.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No date/number input events detected.
                </div>
              ) : (
                dynamicSuggestions.slice(0, 8).map((suggestion) => (
                  <div
                    key={`${suggestion.eventIndex}-${suggestion.kind}`}
                    className="dynamic-suggestion-card"
                  >
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span className="dynamic-step-chip">Step #{suggestion.eventIndex + 1}</span>
                        <span className={`dynamic-kind-chip ${suggestion.kind === 'date_range' ? 'date' : 'number'}`}>
                          {suggestion.kind === 'date_range' ? 'Date range' : 'Number sequence'}
                        </span>
                      </div>
                      <div className="dynamic-selector-line" title={suggestion.selector || 'No selector'}>
                        {(suggestion.selector || 'No selector').slice(0, 160)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {boundEventIndexes.has(suggestion.eventIndex) && (
                        <span className="dynamic-bound-chip">Bound</span>
                      )}
                      <button
                        className="btn btn-secondary"
                        style={{ width: 'auto', padding: '6px 12px', fontSize: 11 }}
                        onClick={() => bindSuggestion(suggestion)}
                      >
                        {boundEventIndexes.has(suggestion.eventIndex) ? 'Rebind' : 'Bind'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {Object.entries(dynamicDraft.variables).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Variables
                </div>
                {Object.entries(dynamicDraft.variables).map(([variableKey, variable]) => (
                  <div
                    key={variableKey}
                    className="dynamic-variable-card"
                  >
                    <div className="dynamic-variable-head">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <code style={{ color: 'var(--accent-light, #8b5cf6)', fontSize: 12 }}>{variableKey}</code>
                        <span className={`dynamic-kind-chip ${variable.kind === 'date_range' ? 'date' : 'number'}`}>
                          {variable.kind === 'date_range' ? 'Date Range Engine' : 'Number Generator'}
                        </span>
                        <span className="dynamic-bound-chip">
                          Used in {variableUsageCount(variableKey)} step{variableUsageCount(variableKey) === 1 ? '' : 's'}
                        </span>
                      </div>
                      <button className="btn btn-secondary" style={{ width: 'auto', padding: '3px 9px', fontSize: 11 }} onClick={() => removeVariable(variableKey)}>Remove</button>
                    </div>

                    <div className="dynamic-variable-subline">
                      {variable.kind === 'date_range'
                        ? 'Controls a rolling date window. Pick where it starts, where it ends, and how quickly it advances each run.'
                        : 'Creates a predictable number pattern. Set the first value, the increment per run, and optional safety limits.'}
                    </div>

                    {variable.kind === 'date_range' ? (
                      <div className="dynamic-variable-grid">
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Start Date</span>
                          <input
                            className="input"
                            type="date"
                            value={variable.start}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'date_range') target.start = e.target.value
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">First date injected into the target step.</span>
                        </label>
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">End Date</span>
                          <input
                            className="input"
                            type="date"
                            value={variable.end}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'date_range') target.end = e.target.value
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">Upper boundary for the rolling window.</span>
                        </label>
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Step Unit</span>
                          <select
                            className="input"
                            value={variable.stepUnit}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'date_range') target.stepUnit = e.target.value as DynamicDateRangeVariable['stepUnit']
                              return next
                            })}
                          >
                            <option value="day">day</option>
                            <option value="week">week</option>
                            <option value="month">month</option>
                          </select>
                          <span className="dynamic-field-hint">Time unit advanced every run.</span>
                        </label>
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Step Size</span>
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={365}
                            value={variable.stepValue}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'date_range') {
                                target.stepValue = Math.max(1, Number.parseInt(e.target.value, 10) || 1)
                              }
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">How much to move the date forward each run.</span>
                        </label>
                      </div>
                    ) : (
                      <div className="dynamic-variable-grid">
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Start Value</span>
                          <input
                            className="input"
                            type="number"
                            value={variable.start}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'number_sequence') target.start = Number.parseFloat(e.target.value) || 0
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">Value used on the first execution.</span>
                        </label>
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Step Delta</span>
                          <input
                            className="input"
                            type="number"
                            value={variable.step}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'number_sequence') target.step = Number.parseFloat(e.target.value) || 1
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">Amount added after each run.</span>
                        </label>
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Minimum Limit</span>
                          <input
                            className="input"
                            type="number"
                            placeholder="Optional floor"
                            value={variable.min ?? ''}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'number_sequence') target.min = e.target.value === '' ? null : Number.parseFloat(e.target.value)
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">Prevents generated values going below this.</span>
                        </label>
                        <label className="dynamic-field">
                          <span className="dynamic-field-label">Maximum Limit</span>
                          <input
                            className="input"
                            type="number"
                            placeholder="Optional ceiling"
                            value={variable.max ?? ''}
                            onChange={(e) => setDynamicDraft((prev) => {
                              const next = cloneDraft(prev)
                              const target = next.variables[variableKey]
                              if (target?.kind === 'number_sequence') target.max = e.target.value === '' ? null : Number.parseFloat(e.target.value)
                              return next
                            })}
                          />
                          <span className="dynamic-field-hint">Prevents generated values going above this.</span>
                        </label>
                        <div className="dynamic-preview-line" style={{ gridColumn: '1 / -1' }}>
                          Preview: {numberSequencePreview(variable)}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {dynamicDraft.bindings.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Bindings
                </div>
                {dynamicDraft.bindings.map((binding, idx) => (
                  <div key={`${binding.eventIndex}-${idx}`} className="dynamic-binding-row">
                    <span className="dynamic-step-chip">Step #{binding.eventIndex + 1}</span>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <select
                        className="input"
                        value={binding.variableKey}
                        onChange={(e) => setDynamicDraft((prev) => {
                          const next = cloneDraft(prev)
                          next.bindings[idx] = { ...next.bindings[idx], variableKey: e.target.value }
                          return next
                        })}
                      >
                        {Object.keys(dynamicDraft.variables).map((variableKey) => (
                          <option key={variableKey} value={variableKey}>{variableKey}</option>
                        ))}
                      </select>
                      <div className="dynamic-binding-hint" title={stepBindingHint(binding)}>
                        {stepBindingHint(binding)}
                      </div>
                    </div>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '3px 9px', fontSize: 11 }} onClick={() => removeBindingAt(idx)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
              </div>
            </>
          )}

          {/* Recording screenshots */}
          <div className="section-title">Recording Checkpoints</div>
          {workflow.screenshots.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.2 }}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              <div className="empty-title">No checkpoints yet</div>
              <div className="empty-desc">Take screenshot checkpoints while recording to see them here.</div>
            </div>
          ) : (
            <div className="screenshot-strip">
              {workflow.screenshots.map(s => (
                <div
                  key={s.id}
                  id={`recording-screenshot-${s.index}`}
                  className="screenshot-thumb"
                  onClick={() => setSelectedImg(s)}
                >
                  <img src={s.dataUrl} alt={s.label || `Checkpoint ${s.index + 1}`} />
                  <div className="screenshot-thumb-label">{s.label || `Checkpoint ${s.index + 1}`}</div>
                </div>
              ))}
            </div>
          )}

          <hr className="divider" />

          {/* Checkpoint timeline */}
          <div className="section-title" style={{ marginBottom: 14 }}>Checkpoint Timeline</div>
          {checkpointEvents.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 20px', marginBottom: 24 }}>
              <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.2 }}>
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <div className="empty-title">No checkpoints recorded</div>
              <div className="empty-desc">Add screenshot, console, or network checkpoints while recording to see them here.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {checkpointEvents.map((cp, i) => {
                const isScreenshot = cp.type === 'checkpoint'
                const isConsole    = cp.type === 'console_checkpoint'
                const isNetwork    = cp.type === 'network_checkpoint'

                const accentColor = isScreenshot ? 'var(--blue, #3b82f6)'
                  : isConsole    ? '#7c3aed'
                  : '#0891b2'

                const typeLabel = isScreenshot ? 'Screenshot' : isConsole ? 'Console' : 'Network'

                // Find the thumbnail for screenshot checkpoints
                let thumb: Screenshot | undefined
                if (isScreenshot) {
                  // Re-derive per rendered list order
                  let screenshotCpIdx = 0
                  for (let j = 0; j <= i; j++) {
                    if (checkpointEvents[j].type === 'checkpoint') {
                      if (j === i) {
                        thumb = workflow.screenshots.find(s => s.index === screenshotCpIdx)
                      }
                      screenshotCpIdx++
                    }
                  }
                }

                return (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 14,
                      background: 'var(--bg2, #111)', border: '1px solid var(--border)',
                      borderLeft: `3px solid ${accentColor}`,
                      borderRadius: 8, padding: '12px 16px',
                    }}
                  >
                    {/* Index badge */}
                    <div style={{
                      minWidth: 28, height: 28, borderRadius: '50%',
                      background: accentColor, color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700, flexShrink: 0,
                    }}>
                      {i + 1}
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '0.6px', color: accentColor,
                        }}>{typeLabel}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cp.label}
                        </span>
                      </div>

                      {isConsole && (
                        <div style={{
                          fontFamily: 'monospace', fontSize: 11,
                          background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)',
                          borderRadius: 4, padding: '4px 8px', color: '#a78bfa',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {(cp as any).logMessage?.slice(0, 120) ?? ''}
                        </div>
                      )}

                      {isNetwork && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{
                            fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                            background: 'rgba(8,145,178,0.15)', color: '#22d3ee',
                            border: '1px solid rgba(8,145,178,0.3)',
                            borderRadius: 3, padding: '2px 6px',
                          }}>
                            {(cp as any).networkMethod}
                          </span>
                          <span style={{
                            fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320,
                          }}>
                            {(cp as any).networkUrl?.replace(/^https?:\/\/[^/]+/, '') ?? (cp as any).networkUrl}
                          </span>
                          {(cp as any).networkStatus != null && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, borderRadius: 3, padding: '2px 6px',
                              background: (cp as any).networkStatus >= 200 && (cp as any).networkStatus < 300
                                ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)',
                              color: (cp as any).networkStatus >= 200 && (cp as any).networkStatus < 300
                                ? '#4ade80' : '#f87171',
                              border: `1px solid ${(cp as any).networkStatus >= 200 && (cp as any).networkStatus < 300
                                ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}`,
                            }}>
                              {(cp as any).networkStatus}
                            </span>
                          )}
                        </div>
                      )}

                      {isScreenshot && thumb && (
                        <img
                          src={thumb.dataUrl}
                          alt={cp.label}
                          onClick={() => setSelectedImg(thumb!)}
                          style={{
                            marginTop: 8, height: 72, borderRadius: 6,
                            border: '1px solid var(--border)', cursor: 'pointer',
                            objectFit: 'cover', display: 'block',
                          }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <hr className="divider" />

          {/* Playback runs */}
          <div className="section-title" style={{ marginBottom: 14 }}>Playback Runs</div>
          {workflow.runs.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px 20px' }}>
              <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.2 }}>
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <div className="empty-title">No playback runs yet</div>
              <div className="empty-desc">Play back this workflow in the extension to capture checkpoint screenshots for comparison.</div>
            </div>
          ) : (
            <div className="run-list">
              {workflow.runs.map(run => {
                const isPassed = run.status === 'passed'
                const isFailed = run.status === 'failed'
                const isAborted = run.status === 'aborted'
                return (
                  <div
                    key={run.id}
                    id={`run-item-${run.id}`}
                    className="run-item"
                    onClick={() => router.push(`/workflows/${workflow.id}/runs/${run.id}`)}
                    style={{ borderLeft: `3px solid ${isFailed ? 'var(--red, #ef4444)' : isPassed ? 'var(--green)' : 'var(--border)'}` }}
                  >
                    <div className="run-item-left">
                      <div className="run-item-date">Played {fmtDate(run.playedAt)}</div>
                      <div className="run-item-count">{run._count.checkpoints} checkpoints captured</div>
                      {isFailed && run.failedEventType && (
                        <div style={{ fontSize: 11, color: 'var(--red, #ef4444)', marginTop: 4 }}>
                          Failed at step {(run.failedEventIndex ?? 0) + 1}: {run.failedEventType}
                          {run.failedEventSelector ? ` — ${run.failedEventSelector.slice(0, 50)}` : ''}
                        </div>
                      )}
                      {isAborted && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          Stopped manually
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                      {isPassed && <span className="badge badge-green">Passed</span>}
                      {isFailed && <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>Failed</span>}
                      {isAborted && <span className="badge" style={{ background: 'var(--bg3)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>Aborted</span>}
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>View →</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>

      {/* Lightbox */}
      {selectedImg && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 999, cursor: 'pointer',
          }}
          onClick={() => setSelectedImg(null)}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
            <img src={selectedImg.dataUrl} alt={selectedImg.label || ''} style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12 }} />
            <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'rgba(0,0,0,0.7)', padding: '6px 12px', borderRadius: 8, fontSize: 13, color: '#fff' }}>
              {selectedImg.label || `Checkpoint ${selectedImg.index + 1}`} {selectedImg.url ? `· ${new URL(selectedImg.url).pathname}` : ''}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
