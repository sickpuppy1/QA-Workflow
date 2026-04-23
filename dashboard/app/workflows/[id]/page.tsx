import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getUserSettings, getWorkflowDetailForUser, countPlaybackRunsForWorkflow } from '@/lib/data'
import WorkflowDetailClient from './WorkflowDetailClient'

/** Server page: loads one workflow with screenshots and runs, or redirects. */
export default async function WorkflowDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ runsPage?: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')

  const [{ id }, { runsPage }] = await Promise.all([params, searchParams])
  
  const pageSize = 10 // Use a smaller page size for runs as they are part of a larger page
  const page = Math.max(1, parseInt(runsPage || '1', 10))
  const skip = (page - 1) * pageSize

  const [workflow, settings, totalRuns] = await Promise.all([
    getWorkflowDetailForUser(id, session.userId, skip, pageSize),
    getUserSettings(session.userId),
    countPlaybackRunsForWorkflow(id, session.userId),
  ])

  if (!workflow) redirect('/')

  return (
    <WorkflowDetailClient
      workflow={workflow}
      dynamicBindingEnabled={settings.dynamicBindingEnabled}
      runsPage={page}
      totalRuns={totalRuns}
      runsPageSize={pageSize}
      userEmail={session.email}
    />
  )
}
