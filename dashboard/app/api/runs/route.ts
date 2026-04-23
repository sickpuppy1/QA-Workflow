import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import { createRunRecord } from '@/lib/data'
import {
  readJsonBodyWithLimit,
  RequestBodyLimitError,
  RequestBodyParseError,
} from '@/lib/request-body'

interface RunCheckpointInput {
  label?: string | null
  checkpointType?: string | null
  dataUrl?: string | null
  capturedData?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asRunCheckpointInput(value: unknown): RunCheckpointInput {
  return isRecord(value) ? (value as RunCheckpointInput) : {}
}

// POST /api/runs — create a playback run with its checkpoints
const MAX_BODY_BYTES = 10 * 1024 * 1024

export async function POST(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contentLength = req.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: 'Payload Too Large — maximum upload size is 10 MB' },
      { status: 413 },
    )
  }

  let body: {
    workflowId?: string
    playedAt?: string
    checkpoints?: Record<string, unknown> | null
    status?: string
    failedEventIndex?: number | null
    failedEventType?: string | null
    failedEventSelector?: string | null
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
  const {
    workflowId,
    playedAt,
    checkpoints,
    status,
    failedEventIndex,
    failedEventType,
    failedEventSelector,
  } = body

  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId required' }, { status: 400 })
  }

  let run
  try {
    run = await createRunRecord({
      userId: session.userId,
      workflowId,
      playedAt: playedAt ? new Date(playedAt) : new Date(),
      status: status ?? 'passed',
      failedEventIndex: failedEventIndex ?? null,
      failedEventType: failedEventType ?? null,
      failedEventSelector: failedEventSelector ?? null,
      checkpoints: checkpoints && typeof checkpoints === 'object'
        ? Object.entries(checkpoints).map(([idx, entry]) => {
            const checkpoint = asRunCheckpointInput(entry)
            const checkpointIndex = Number.parseInt(idx, 10)

            return {
              index: checkpointIndex,
              label: checkpoint.label ?? `Checkpoint ${checkpointIndex + 1}`,
              checkpointType: checkpoint.checkpointType ?? 'screenshot',
              dataUrl: checkpoint.dataUrl ?? null,
              capturedData: checkpoint.capturedData ?? null,
            }
          })
        : [],
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 })
  }

  return NextResponse.json({ id: run.id }, { status: 201 })
}
