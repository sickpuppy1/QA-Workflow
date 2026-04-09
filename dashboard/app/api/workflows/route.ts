import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import {
  createWorkflowRecord,
  listWorkflowSummariesForUser,
  normalizeWorkflowDynamicInputs,
} from '@/lib/data'

interface CheckpointInput {
  checkpointId?: string | null
  type?: unknown
  label?: string | null
  url?: string | null
  timestamp?: number | null
  screenshotIndex?: number | null
  logMessage?: string | null
  logLevel?: string | null
  logTimestamp?: number | string | null
  logUrl?: string | null
  logContextBefore?: unknown[]
  logContextAfter?: unknown[]
  networkUrl?: string | null
  networkMethod?: string | null
  networkStatus?: number | null
  networkStatusText?: string | null
  networkRequestHeaders?: unknown
  networkResponseHeaders?: unknown
  networkRequestBody?: unknown
  networkResponseBody?: unknown
}

interface CheckpointEvent {
  checkpointId?: string | null
  type?: unknown
  label?: string | null
  timestamp?: number | null
  url?: string | null
}

interface ScreenshotCheckpointEvent extends CheckpointEvent {
  type: 'checkpoint'
}

function isCheckpointType(type: unknown) {
  return type === 'checkpoint' || type === 'console_checkpoint' || type === 'network_checkpoint'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCheckpointInput(value: unknown): value is CheckpointInput {
  return isRecord(value)
}

function asCheckpointEvent(value: unknown): CheckpointEvent | null {
  return isRecord(value) ? (value as CheckpointEvent) : null
}

function isCheckpointEvent(value: CheckpointEvent | null): value is CheckpointEvent {
  return value !== null && isCheckpointType(value.type)
}

function isScreenshotCheckpointEvent(value: unknown): value is ScreenshotCheckpointEvent {
  return isRecord(value) && value.type === 'checkpoint'
}

function checkpointToEvent(checkpoint: CheckpointInput | null) {
  if (!checkpoint || !isCheckpointType(checkpoint.type)) return null
  return {
    checkpointId: checkpoint.checkpointId ?? null,
    type: checkpoint.type,
    label: checkpoint.label ?? null,
    url: checkpoint.url ?? null,
    timestamp: checkpoint.timestamp ?? Date.now(),
    screenshotIndex: checkpoint.screenshotIndex ?? null,
    logMessage: checkpoint.logMessage ?? null,
    logLevel: checkpoint.logLevel ?? null,
    logTimestamp: checkpoint.logTimestamp ?? null,
    logUrl: checkpoint.logUrl ?? null,
    logContextBefore: checkpoint.logContextBefore ?? [],
    logContextAfter: checkpoint.logContextAfter ?? [],
    networkUrl: checkpoint.networkUrl ?? null,
    networkMethod: checkpoint.networkMethod ?? null,
    networkStatus: checkpoint.networkStatus ?? null,
    networkStatusText: checkpoint.networkStatusText ?? null,
    networkRequestHeaders: checkpoint.networkRequestHeaders ?? null,
    networkResponseHeaders: checkpoint.networkResponseHeaders ?? null,
    networkRequestBody: checkpoint.networkRequestBody ?? null,
    networkResponseBody: checkpoint.networkResponseBody ?? null,
  }
}

function normalizeEvents(events: unknown[], checkpoints: CheckpointInput[]) {
  const eventList = Array.isArray(events) ? [...events] : []
  const explicitCheckpoints: CheckpointEvent[] = []
  if (Array.isArray(checkpoints)) {
    checkpoints.forEach((checkpoint) => {
      const mapped = checkpointToEvent(checkpoint)
      if (mapped) explicitCheckpoints.push(mapped)
    })
  }

  if (explicitCheckpoints.length === 0) return eventList

  const existingCheckpointKeys = new Set(
    eventList
      .map(asCheckpointEvent)
      .filter(isCheckpointEvent)
      .map((event) => event.checkpointId
        ? `checkpoint:${event.checkpointId}`
        : JSON.stringify([
            event.type ?? null,
            event.label ?? null,
            event.timestamp ?? null,
            event.url ?? null,
          ]))
  )

  explicitCheckpoints.forEach((checkpoint) => {
    const key = checkpoint.checkpointId
      ? `checkpoint:${checkpoint.checkpointId}`
      : JSON.stringify([
          checkpoint.type ?? null,
          checkpoint.label ?? null,
          checkpoint.timestamp ?? null,
          checkpoint.url ?? null,
        ])
    if (!existingCheckpointKeys.has(key)) {
      eventList.push(checkpoint)
    }
  })

  eventList.sort((left, right) => {
    const leftTimestamp = asCheckpointEvent(left)?.timestamp ?? 0
    const rightTimestamp = asCheckpointEvent(right)?.timestamp ?? 0
    return leftTimestamp - rightTimestamp
  })

  return eventList
}

// GET /api/workflows — list all workflows
export async function GET(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workflows = await listWorkflowSummariesForUser(session.userId)
  return NextResponse.json(workflows)
}

// POST /api/workflows — create workflow + recording screenshots
export async function POST(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    name?: string
    recordedAt?: string
    events?: unknown
    dynamicInputs?: unknown
    screenshots?: Record<string, unknown> | null
    checkpoints?: unknown
  }
  const { name, recordedAt, events, dynamicInputs, screenshots, checkpoints } = body
  const normalizedEvents = normalizeEvents(
    Array.isArray(events) ? events : [],
    Array.isArray(checkpoints) ? checkpoints.filter(isCheckpointInput) : []
  )
  const checkpointEvents = normalizedEvents.filter(isScreenshotCheckpointEvent)

  if (!name || !Array.isArray(events)) {
    return NextResponse.json({ error: 'name and events required' }, { status: 400 })
  }

  const screenshotData: Array<{
    index: number
    label: string | null
    url: string | null
    dataUrl: string
  }> = []

  if (screenshots && typeof screenshots === 'object') {
    Object.entries(screenshots).forEach(([idx, dataUrl]) => {
      const screenshotIndex = Number.parseInt(idx, 10)
      const checkpoint = checkpointEvents[screenshotIndex]
      screenshotData.push({
        index: screenshotIndex,
        label: checkpoint?.label ?? `Checkpoint ${screenshotIndex + 1}`,
        url: checkpoint?.url ?? null,
        dataUrl: typeof dataUrl === 'string' ? dataUrl : '',
      })
    })
  }

  const workflow = await createWorkflowRecord({
    userId: session.userId,
    name,
    recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
    events: normalizedEvents,
    dynamicInputs: normalizeWorkflowDynamicInputs(dynamicInputs),
    screenshots: screenshotData,
  })

  return NextResponse.json({
    id: workflow.id,
    checkpointCount: normalizedEvents
      .map(asCheckpointEvent)
      .filter(isCheckpointEvent)
      .length,
  }, { status: 201 })
}
