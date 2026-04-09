import { NextRequest, NextResponse } from 'next/server'
import { getRequestSession } from '@/lib/auth'
import {
  getWorkflowDetailForUser,
  normalizeWorkflowDynamicInputs,
  updateWorkflowDynamicInputsForUser,
} from '@/lib/data'

// GET /api/workflows/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const workflow = await getWorkflowDetailForUser(id, session.userId)
  if (!workflow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(workflow)
}

// PATCH /api/workflows/[id] — update dynamic inputs
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getRequestSession(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json() as {
    dynamicInputs?: unknown
  }

  const updated = await updateWorkflowDynamicInputsForUser(
    id,
    session.userId,
    normalizeWorkflowDynamicInputs(body.dynamicInputs)
  )

  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const workflow = await getWorkflowDetailForUser(id, session.userId)
  return NextResponse.json({
    ok: true,
    workflow,
  })
}
