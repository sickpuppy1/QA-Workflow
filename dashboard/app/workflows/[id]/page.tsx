import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { getUserSettings, getWorkflowDetailForUser } from '@/lib/data'
import WorkflowDetailClient from './WorkflowDetailClient'

/** Server page: loads one workflow with screenshots and runs, or redirects. */
export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await getSession()
  if (!session) redirect('/login')

  const { id } = await params
  const [workflow, settings] = await Promise.all([
    getWorkflowDetailForUser(id, session.userId),
    getUserSettings(session.userId),
  ])

  if (!workflow) redirect('/')

  return (
    <WorkflowDetailClient
      workflow={workflow}
      dynamicBindingEnabled={settings.dynamicBindingEnabled}
    />
  )
}
