import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import { upsertUserSettings, getUserSettings } from '@/lib/data'

function parsePlayBufferSeconds(value: unknown) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)

  if (!Number.isFinite(parsed)) {
    throw new Error('DOM load buffer must be a whole number between 0 and 60.')
  }

  return Math.min(60, Math.max(0, Math.trunc(parsed)))
}

function parseNetworkMergeWindowMs(value: unknown) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)

  if (!Number.isFinite(parsed)) {
    throw new Error('Network merge window must be a whole number between 100 and 2000 ms.')
  }

  return Math.min(2000, Math.max(100, Math.trunc(parsed)))
}

export async function GET(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const settings = await getUserSettings(session.userId)
  return NextResponse.json({ settings })
}

export async function PUT(req: NextRequest) {
  const session = await getRequestSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  try {
    const settings = await upsertUserSettings(session.userId, {
      playBufferSeconds:
        body.playBufferSeconds === undefined
          ? undefined
          : parsePlayBufferSeconds(body.playBufferSeconds),
      promptScreenshotLabel:
        body.promptScreenshotLabel === undefined
          ? undefined
          : Boolean(body.promptScreenshotLabel),
      networkMergeWindowMs:
        body.networkMergeWindowMs === undefined
          ? undefined
          : parseNetworkMergeWindowMs(body.networkMergeWindowMs),
      dynamicBindingEnabled:
        body.dynamicBindingEnabled === undefined
          ? undefined
          : Boolean(body.dynamicBindingEnabled),
    })

    return NextResponse.json({ settings })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not save settings.',
      },
      { status: 400 }
    )
  }
}
