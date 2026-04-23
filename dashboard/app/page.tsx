import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import {
  countPlaybackCheckpointsForUser,
  countPlaybackRunsForUser,
  countWorkflowsForUser,
  listWorkflowSummariesForUser,
} from '@/lib/data'
import HomeClient from './HomeClient'

/** Server page: requires session, loads workflows and aggregate stats for `HomeClient`. */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await getSession()
  if (!session) redirect('/landing')

  const parsedParams = await searchParams
  const pageSize = 30
  const page = Math.max(1, parseInt(parsedParams.page || '1', 10))
  const skip = (page - 1) * pageSize

  const [workflows, totalWorkflows, totalRuns, totalCheckpoints] = await Promise.all([
    listWorkflowSummariesForUser(session.userId, skip, pageSize),
    countWorkflowsForUser(session.userId),
    countPlaybackRunsForUser(session.userId),
    countPlaybackCheckpointsForUser(session.userId),
  ])

  return (
    <HomeClient
      workflows={workflows}
      stats={{ workflows: totalWorkflows, runs: totalRuns, checkpoints: totalCheckpoints }}
      userEmail={session.email}
      currentPage={page}
      totalWorkflows={totalWorkflows}
      pageSize={pageSize}
    />
  )
}
