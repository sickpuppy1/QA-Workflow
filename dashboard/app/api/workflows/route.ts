import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import {
  createWorkflowRecord,
  listWorkflowSummariesForUser,
  normalizeWorkflowDynamicInputs,
} from '@/lib/data'
import {
  readJsonBodyWithLimit,
  RequestBodyLimitError,
  RequestBodyParseError,
} from '@/lib/request-body'

// ---------------------------------------------------------------------------
// Route-segment config
// ---------------------------------------------------------------------------
// Enforce a strict 10 MB body-size limit on this route.  Next.js rejects any
// request whose Content-Length (or actual streamed size) exceeds this value
// and returns a 413 before `req.json()` is ever called, preventing the
// unbounded-JSON-parsing OOM/DoS described in:
//   https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#bodyszelimit
export const maxDuration = 30  // seconds — keeps lambda warm-start budget sane
export const dynamic = 'force-dynamic'

// The body-size cap.  10 MB is generous for real workflow uploads (events +
// a handful of base64 screenshots) while rejecting astronomical payloads
// crafted to exhaust Node.js heap.
export const fetchCache = 'force-no-store'

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
const MAX_BODY_BYTES = 10 * 1024 * 1024 // 10 MB

export async function POST(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Defence-in-depth: reject oversized bodies before JSON parsing begins.
  // The route-segment `config.api.bodyParser.sizeLimit` handles the common
  // case; this guard catches streaming clients that omit Content-Length or
  // whose actual body exceeds the declared size.
  const contentLength = req.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: 'Payload Too Large — maximum upload size is 10 MB' },
      { status: 413 },
    )
  }

  let body: {
    name?: string
    recordedAt?: string
    events?: unknown
    dynamicInputs?: unknown
    screenshots?: Record<string, unknown> | null
    checkpoints?: unknown
  }
  try {
    body = await readJsonBodyWithLimit<typeof body>(req, MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyLimitError) {
      return NextResponse.json(
        { error: 'Payload Too Large — maximum upload size is 10 MB' },
        { status: 413 },
      )
    }
    if (error instanceof RequestBodyParseError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
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
