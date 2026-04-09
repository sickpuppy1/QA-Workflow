import { randomUUID } from 'crypto'
import { Db } from 'mongodb'
import { getMongoDb } from './mongodb'

interface UserDoc {
  _id: string
  email: string
  passwordHash: string
  createdAt: Date
}

interface UserSettingsDoc {
  _id: string
  userId: string
  playBufferSeconds: number
  promptScreenshotLabel: boolean
  networkMergeWindowMs: number
  dynamicBindingEnabled: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DynamicDateRangeVariable {
  kind: 'date_range'
  start: string
  end: string
  stepUnit: 'day' | 'week' | 'month'
  stepValue: number
  output: 'date' | 'datetime-local' | 'text'
}

export interface DynamicNumberSequenceVariable {
  kind: 'number_sequence'
  start: number
  step: number
  decimals: number | null
  min: number | null
  max: number | null
}

export type DynamicVariableDef = DynamicDateRangeVariable | DynamicNumberSequenceVariable

export interface DynamicBinding {
  eventIndex: number
  variableKey: string
  selector: string | null
  mode: 'replace'
}

export interface WorkflowDynamicInputs {
  version: 1
  variables: Record<string, DynamicVariableDef>
  bindings: DynamicBinding[]
}

interface WorkflowDoc {
  _id: string
  name: string
  recordedAt: Date
  events: unknown[]
  userId?: string | null
  dynamicInputs?: WorkflowDynamicInputs | null
}

interface RecordingScreenshotDoc {
  _id: string
  workflowId: string
  index: number
  label: string | null
  url: string | null
  dataUrl: string
  createdAt: Date
}

interface PlaybackRunDoc {
  _id: string
  workflowId: string
  playedAt: Date
  userId?: string | null
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
}

interface PlaybackCheckpointDoc {
  _id: string
  runId: string
  index: number
  label: string | null
  checkpointType: string | null
  dataUrl: string | null
  capturedData: string | null
  createdAt: Date
}

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  createdAt: string
}

export interface UserSettingsRecord {
  playBufferSeconds: number
  promptScreenshotLabel: boolean
  networkMergeWindowMs: number
  dynamicBindingEnabled: boolean
}

export interface WorkflowSummary {
  id: string
  name: string
  recordedAt: string
  _count: {
    screenshots: number
    runs: number
  }
}

export interface RecordingScreenshotRecord {
  id: string
  workflowId: string
  index: number
  label: string | null
  url: string | null
  dataUrl: string
  createdAt: string
}

export interface PlaybackRunSummary {
  id: string
  workflowId: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  _count: {
    checkpoints: number
  }
}

export interface WorkflowDetail {
  id: string
  name: string
  recordedAt: string
  events: unknown[]
  dynamicInputs: WorkflowDynamicInputs | null
  userId: string | null
  screenshots: RecordingScreenshotRecord[]
  runs: PlaybackRunSummary[]
}

export interface PlaybackCheckpointRecord {
  id: string
  runId: string
  index: number
  label: string | null
  checkpointType: string | null
  dataUrl: string | null
  capturedData: string | null
  createdAt: string
}

export interface RunDetail {
  id: string
  workflowId: string
  playedAt: string
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  checkpoints: PlaybackCheckpointRecord[]
  workflow: {
    id: string
    name: string
    recordedAt: string
    events: unknown[]
    dynamicInputs: WorkflowDynamicInputs | null
    userId: string | null
    screenshots: RecordingScreenshotRecord[]
  }
}

interface CreateWorkflowInput {
  userId: string
  name: string
  recordedAt: Date
  events: unknown[]
  dynamicInputs?: WorkflowDynamicInputs | null
  screenshots: Array<{
    index: number
    label: string | null
    url: string | null
    dataUrl: string
  }>
}

interface CreateRunInput {
  userId: string
  workflowId: string
  playedAt: Date
  status: string
  failedEventIndex: number | null
  failedEventType: string | null
  failedEventSelector: string | null
  checkpoints: Array<{
    index: number
    label: string | null
    checkpointType: string | null
    dataUrl: string | null
    capturedData: string | null
  }>
}

export const DEFAULT_USER_SETTINGS: UserSettingsRecord = {
  playBufferSeconds: 8,
  promptScreenshotLabel: false,
  networkMergeWindowMs: 500,
  dynamicBindingEnabled: false,
}

function iso(value: Date) {
  return value.toISOString()
}

function mapUser(doc: UserDoc): UserRecord {
  return {
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    createdAt: iso(doc.createdAt),
  }
}

function mapScreenshot(doc: RecordingScreenshotDoc): RecordingScreenshotRecord {
  return {
    id: doc._id,
    workflowId: doc.workflowId,
    index: doc.index,
    label: doc.label ?? null,
    url: doc.url ?? null,
    dataUrl: doc.dataUrl,
    createdAt: iso(doc.createdAt),
  }
}

function mapCheckpoint(doc: PlaybackCheckpointDoc): PlaybackCheckpointRecord {
  return {
    id: doc._id,
    runId: doc.runId,
    index: doc.index,
    label: doc.label ?? null,
    checkpointType: doc.checkpointType ?? null,
    dataUrl: doc.dataUrl ?? null,
    capturedData: doc.capturedData ?? null,
    createdAt: iso(doc.createdAt),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toFiniteNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function normalizeWorkflowDynamicInputs(value: unknown): WorkflowDynamicInputs | null {
  if (!isRecord(value)) return null

  const variablesInput = isRecord(value.variables) ? value.variables : {}
  const bindingsInput = Array.isArray(value.bindings) ? value.bindings : []
  const variables: Record<string, DynamicVariableDef> = {}

  Object.entries(variablesInput).forEach(([key, inputVar]) => {
    if (!key || !isRecord(inputVar)) return
    if (inputVar.kind === 'date_range') {
      variables[key] = {
        kind: 'date_range',
        start: typeof inputVar.start === 'string' ? inputVar.start : '',
        end: typeof inputVar.end === 'string' ? inputVar.end : '',
        stepUnit: inputVar.stepUnit === 'week' || inputVar.stepUnit === 'month' ? inputVar.stepUnit : 'day',
        stepValue: Math.max(1, Math.trunc(toFiniteNumber(inputVar.stepValue, 1, 1, 365))),
        output:
          inputVar.output === 'datetime-local' || inputVar.output === 'text'
            ? inputVar.output
            : 'date',
      }
    } else if (inputVar.kind === 'number_sequence') {
      variables[key] = {
        kind: 'number_sequence',
        start: toFiniteNumber(inputVar.start, 0, -1e12, 1e12),
        step: toFiniteNumber(inputVar.step, 1, -1e9, 1e9),
        decimals:
          inputVar.decimals == null
            ? null
            : Math.max(0, Math.min(8, Math.trunc(toFiniteNumber(inputVar.decimals, 0, 0, 8)))),
        min: inputVar.min == null ? null : toFiniteNumber(inputVar.min, -1e12, -1e12, 1e12),
        max: inputVar.max == null ? null : toFiniteNumber(inputVar.max, 1e12, -1e12, 1e12),
      }
    }
  })

  const bindings: DynamicBinding[] = bindingsInput
    .map((binding): DynamicBinding | null => {
      if (!isRecord(binding)) return null
      const variableKey = typeof binding.variableKey === 'string' ? binding.variableKey : ''
      const eventIndex = Math.max(0, Math.trunc(toFiniteNumber(binding.eventIndex, -1, 0, 1e6)))
      if (!variableKey || !variables[variableKey] || eventIndex < 0) return null
      return {
        eventIndex,
        variableKey,
        selector: typeof binding.selector === 'string' ? binding.selector : null,
        mode: 'replace',
      }
    })
    .filter((binding): binding is DynamicBinding => binding !== null)

  if (Object.keys(variables).length === 0 || bindings.length === 0) return null

  return {
    version: 1,
    variables,
    bindings,
  }
}

function normalizePlayBufferSeconds(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? DEFAULT_USER_SETTINGS.playBufferSeconds), 10)

  if (!Number.isFinite(parsed)) {
    return DEFAULT_USER_SETTINGS.playBufferSeconds
  }

  return Math.min(60, Math.max(0, Math.trunc(parsed)))
}

function normalizeNetworkMergeWindowMs(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? DEFAULT_USER_SETTINGS.networkMergeWindowMs), 10)

  if (!Number.isFinite(parsed)) {
    return DEFAULT_USER_SETTINGS.networkMergeWindowMs
  }

  return Math.min(2000, Math.max(100, Math.trunc(parsed)))
}

function mapUserSettings(doc: UserSettingsDoc | null | undefined): UserSettingsRecord {
  if (!doc) {
    return { ...DEFAULT_USER_SETTINGS }
  }

  return {
    playBufferSeconds: normalizePlayBufferSeconds(doc.playBufferSeconds),
    promptScreenshotLabel: Boolean(doc.promptScreenshotLabel),
    networkMergeWindowMs: normalizeNetworkMergeWindowMs(doc.networkMergeWindowMs),
    dynamicBindingEnabled: Boolean(doc.dynamicBindingEnabled),
  }
}

function mapRun(doc: PlaybackRunDoc, checkpointCount = 0): PlaybackRunSummary {
  return {
    id: doc._id,
    workflowId: doc.workflowId,
    playedAt: iso(doc.playedAt),
    status: doc.status,
    failedEventIndex: doc.failedEventIndex ?? null,
    failedEventType: doc.failedEventType ?? null,
    failedEventSelector: doc.failedEventSelector ?? null,
    _count: {
      checkpoints: checkpointCount,
    },
  }
}

async function getDb() {
  return getMongoDb()
}

async function getCollections(db?: Db) {
  const database = db ?? (await getDb())
  return {
    db: database,
    users: database.collection<UserDoc>('users'),
    userSettings: database.collection<UserSettingsDoc>('user_settings'),
    workflows: database.collection<WorkflowDoc>('workflows'),
    recordingScreenshots: database.collection<RecordingScreenshotDoc>('recording_screenshots'),
    playbackRuns: database.collection<PlaybackRunDoc>('playback_runs'),
    playbackCheckpoints: database.collection<PlaybackCheckpointDoc>('playback_checkpoints'),
  }
}

async function getCheckpointCountsByRunId(runIds: string[]) {
  if (runIds.length === 0) return new Map<string, number>()

  const { playbackCheckpoints } = await getCollections()
  const counts = await playbackCheckpoints.aggregate<{ _id: string; count: number }>([
    { $match: { runId: { $in: runIds } } },
    { $group: { _id: '$runId', count: { $sum: 1 } } },
  ]).toArray()

  return new Map(counts.map((entry) => [entry._id, entry.count]))
}

export async function findUserByEmail(email: string) {
  const { users } = await getCollections()
  const user = await users.findOne({ email })
  return user ? mapUser(user) : null
}

export async function createUserRecord(email: string, passwordHash: string) {
  const { users } = await getCollections()
  const existing = await users.findOne({ email })
  if (existing) {
    throw new Error('An account with this email already exists')
  }

  const user: UserDoc = {
    _id: randomUUID(),
    email,
    passwordHash,
    createdAt: new Date(),
  }

  await users.insertOne(user)
  return mapUser(user)
}

export async function getUserSettings(userId: string) {
  const { userSettings } = await getCollections()
  const settings = await userSettings.findOne({ userId })
  return mapUserSettings(settings)
}

export async function upsertUserSettings(
  userId: string,
  input: Partial<UserSettingsRecord>
) {
  const { userSettings } = await getCollections()
  const current = mapUserSettings(await userSettings.findOne({ userId }))
  const nextSettings: UserSettingsRecord = {
    playBufferSeconds:
      input.playBufferSeconds === undefined
        ? current.playBufferSeconds
        : normalizePlayBufferSeconds(input.playBufferSeconds),
    promptScreenshotLabel:
      input.promptScreenshotLabel === undefined
        ? current.promptScreenshotLabel
        : Boolean(input.promptScreenshotLabel),
    networkMergeWindowMs:
      input.networkMergeWindowMs === undefined
        ? current.networkMergeWindowMs
        : normalizeNetworkMergeWindowMs(input.networkMergeWindowMs),
    dynamicBindingEnabled:
      input.dynamicBindingEnabled === undefined
        ? current.dynamicBindingEnabled
        : Boolean(input.dynamicBindingEnabled),
  }
  const now = new Date()

  await userSettings.updateOne(
    { userId },
    {
      $set: {
        playBufferSeconds: nextSettings.playBufferSeconds,
        promptScreenshotLabel: nextSettings.promptScreenshotLabel,
        networkMergeWindowMs: nextSettings.networkMergeWindowMs,
        dynamicBindingEnabled: nextSettings.dynamicBindingEnabled,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: randomUUID(),
        userId,
        createdAt: now,
      },
    },
    { upsert: true }
  )

  return nextSettings
}

export async function listWorkflowSummaries() {
  const { workflows } = await getCollections()
  const docs = await workflows.aggregate<{
    _id: string
    name: string
    recordedAt: Date
    screenshotCount: number
    runCount: number
  }>([
    { $sort: { recordedAt: -1 } },
    {
      $lookup: {
        from: 'recording_screenshots',
        let: { workflowId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$workflowId', '$$workflowId'] } } },
          { $count: 'count' },
        ],
        as: 'screenshotCounts',
      },
    },
    {
      $lookup: {
        from: 'playback_runs',
        let: { workflowId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$workflowId', '$$workflowId'] } } },
          { $count: 'count' },
        ],
        as: 'runCounts',
      },
    },
    {
      $project: {
        _id: 1,
        name: 1,
        recordedAt: 1,
        screenshotCount: {
          $ifNull: [{ $arrayElemAt: ['$screenshotCounts.count', 0] }, 0],
        },
        runCount: {
          $ifNull: [{ $arrayElemAt: ['$runCounts.count', 0] }, 0],
        },
      },
    },
  ]).toArray()

  return docs.map<WorkflowSummary>((doc) => ({
    id: doc._id,
    name: doc.name,
    recordedAt: iso(doc.recordedAt),
    _count: {
      screenshots: doc.screenshotCount,
      runs: doc.runCount,
    },
  }))
}

export async function listWorkflowSummariesForUser(userId: string) {
  const { workflows } = await getCollections()
  const docs = await workflows.aggregate<{
    _id: string
    name: string
    recordedAt: Date
    screenshotCount: number
    runCount: number
  }>([
    { $match: { userId } },
    { $sort: { recordedAt: -1 } },
    {
      $lookup: {
        from: 'recording_screenshots',
        let: { workflowId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$workflowId', '$$workflowId'] } } },
          { $count: 'count' },
        ],
        as: 'screenshotCounts',
      },
    },
    {
      $lookup: {
        from: 'playback_runs',
        let: { workflowId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$workflowId', '$$workflowId'] } } },
          { $count: 'count' },
        ],
        as: 'runCounts',
      },
    },
    {
      $project: {
        _id: 1,
        name: 1,
        recordedAt: 1,
        screenshotCount: {
          $ifNull: [{ $arrayElemAt: ['$screenshotCounts.count', 0] }, 0],
        },
        runCount: {
          $ifNull: [{ $arrayElemAt: ['$runCounts.count', 0] }, 0],
        },
      },
    },
  ]).toArray()

  return docs.map<WorkflowSummary>((doc) => ({
    id: doc._id,
    name: doc.name,
    recordedAt: iso(doc.recordedAt),
    _count: {
      screenshots: doc.screenshotCount,
      runs: doc.runCount,
    },
  }))
}

export async function countWorkflows() {
  const { workflows } = await getCollections()
  return workflows.countDocuments()
}

export async function countPlaybackRuns() {
  const { playbackRuns } = await getCollections()
  return playbackRuns.countDocuments()
}

export async function countPlaybackRunsForUser(userId: string) {
  const { playbackRuns } = await getCollections()
  return playbackRuns.countDocuments({ userId })
}

export async function countPlaybackCheckpoints() {
  const { playbackCheckpoints } = await getCollections()
  return playbackCheckpoints.countDocuments()
}

export async function countPlaybackCheckpointsForUser(userId: string) {
  const { playbackRuns, playbackCheckpoints } = await getCollections()
  const runs = await playbackRuns.find(
    { userId },
    { projection: { _id: 1 } }
  ).toArray()

  if (runs.length === 0) return 0

  return playbackCheckpoints.countDocuments({
    runId: { $in: runs.map((run) => run._id) },
  })
}

export async function getWorkflowDetail(id: string) {
  const { workflows, recordingScreenshots, playbackRuns } = await getCollections()
  const workflow = await workflows.findOne({ _id: id })
  if (!workflow) return null

  const [screenshots, runs] = await Promise.all([
    recordingScreenshots.find({ workflowId: id }).sort({ index: 1 }).toArray(),
    playbackRuns.find({ workflowId: id }).sort({ playedAt: -1 }).toArray(),
  ])

  const checkpointCounts = await getCheckpointCountsByRunId(runs.map((run) => run._id))

  return {
    id: workflow._id,
    name: workflow.name,
    recordedAt: iso(workflow.recordedAt),
    events: Array.isArray(workflow.events) ? workflow.events : [],
    dynamicInputs: normalizeWorkflowDynamicInputs(workflow.dynamicInputs),
    userId: workflow.userId ?? null,
    screenshots: screenshots.map(mapScreenshot),
    runs: runs.map((run) => mapRun(run, checkpointCounts.get(run._id) ?? 0)),
  } satisfies WorkflowDetail
}

export async function getWorkflowDetailForUser(id: string, userId: string) {
  const { workflows, recordingScreenshots, playbackRuns } = await getCollections()
  const workflow = await workflows.findOne({ _id: id, userId })
  if (!workflow) return null

  const [screenshots, runs] = await Promise.all([
    recordingScreenshots.find({ workflowId: id }).sort({ index: 1 }).toArray(),
    playbackRuns.find({ workflowId: id, userId }).sort({ playedAt: -1 }).toArray(),
  ])

  const checkpointCounts = await getCheckpointCountsByRunId(runs.map((run) => run._id))

  return {
    id: workflow._id,
    name: workflow.name,
    recordedAt: iso(workflow.recordedAt),
    events: Array.isArray(workflow.events) ? workflow.events : [],
    dynamicInputs: normalizeWorkflowDynamicInputs(workflow.dynamicInputs),
    userId: workflow.userId ?? null,
    screenshots: screenshots.map(mapScreenshot),
    runs: runs.map((run) => mapRun(run, checkpointCounts.get(run._id) ?? 0)),
  } satisfies WorkflowDetail
}

export async function getRunDetail(runId: string) {
  const { workflows, recordingScreenshots, playbackRuns, playbackCheckpoints } = await getCollections()
  const run = await playbackRuns.findOne({ _id: runId })
  if (!run) return null

  const [workflow, checkpoints, screenshots] = await Promise.all([
    workflows.findOne({ _id: run.workflowId }),
    playbackCheckpoints.find({ runId }).sort({ index: 1 }).toArray(),
    recordingScreenshots.find({ workflowId: run.workflowId }).sort({ index: 1 }).toArray(),
  ])

  if (!workflow) return null

  return {
    id: run._id,
    workflowId: run.workflowId,
    playedAt: iso(run.playedAt),
    status: run.status,
    failedEventIndex: run.failedEventIndex ?? null,
    failedEventType: run.failedEventType ?? null,
    failedEventSelector: run.failedEventSelector ?? null,
    checkpoints: checkpoints.map(mapCheckpoint),
    workflow: {
      id: workflow._id,
      name: workflow.name,
      recordedAt: iso(workflow.recordedAt),
      events: Array.isArray(workflow.events) ? workflow.events : [],
      dynamicInputs: normalizeWorkflowDynamicInputs(workflow.dynamicInputs),
      userId: workflow.userId ?? null,
      screenshots: screenshots.map(mapScreenshot),
    },
  } satisfies RunDetail
}

export async function getRunDetailForUser(runId: string, userId: string) {
  const { workflows, recordingScreenshots, playbackRuns, playbackCheckpoints } = await getCollections()
  const run = await playbackRuns.findOne({ _id: runId, userId })
  if (!run) return null

  const [workflow, checkpoints, screenshots] = await Promise.all([
    workflows.findOne({ _id: run.workflowId, userId }),
    playbackCheckpoints.find({ runId }).sort({ index: 1 }).toArray(),
    recordingScreenshots.find({ workflowId: run.workflowId }).sort({ index: 1 }).toArray(),
  ])

  if (!workflow) return null

  return {
    id: run._id,
    workflowId: run.workflowId,
    playedAt: iso(run.playedAt),
    status: run.status,
    failedEventIndex: run.failedEventIndex ?? null,
    failedEventType: run.failedEventType ?? null,
    failedEventSelector: run.failedEventSelector ?? null,
    checkpoints: checkpoints.map(mapCheckpoint),
    workflow: {
      id: workflow._id,
      name: workflow.name,
      recordedAt: iso(workflow.recordedAt),
      events: Array.isArray(workflow.events) ? workflow.events : [],
      dynamicInputs: normalizeWorkflowDynamicInputs(workflow.dynamicInputs),
      userId: workflow.userId ?? null,
      screenshots: screenshots.map(mapScreenshot),
    },
  } satisfies RunDetail
}

export async function createWorkflowRecord(input: CreateWorkflowInput) {
  const { workflows, recordingScreenshots } = await getCollections()
  const workflowId = randomUUID()

  const workflow: WorkflowDoc = {
    _id: workflowId,
    name: input.name,
    recordedAt: input.recordedAt,
    events: Array.isArray(input.events) ? input.events : [],
    dynamicInputs: normalizeWorkflowDynamicInputs(input.dynamicInputs),
    userId: input.userId,
  }

  await workflows.insertOne(workflow)

  if (input.screenshots.length > 0) {
    const screenshots: RecordingScreenshotDoc[] = input.screenshots.map((screenshot) => ({
      _id: randomUUID(),
      workflowId,
      index: screenshot.index,
      label: screenshot.label ?? null,
      url: screenshot.url ?? null,
      dataUrl: screenshot.dataUrl,
      createdAt: new Date(),
    }))

    await recordingScreenshots.insertMany(screenshots)
  }

  return { id: workflowId }
}

export async function updateWorkflowDynamicInputsForUser(
  workflowId: string,
  userId: string,
  dynamicInputs: WorkflowDynamicInputs | null
) {
  const { workflows } = await getCollections()
  const normalized = normalizeWorkflowDynamicInputs(dynamicInputs)
  const result = await workflows.updateOne(
    { _id: workflowId, userId },
    {
      $set: {
        dynamicInputs: normalized,
      },
    }
  )
  return result.matchedCount > 0
}

export async function createRunRecord(input: CreateRunInput) {
  const { workflows, playbackRuns, playbackCheckpoints } = await getCollections()
  const workflow = await workflows.findOne({ _id: input.workflowId, userId: input.userId })
  if (!workflow) {
    throw new Error('Workflow not found')
  }

  const runId = randomUUID()
  const run: PlaybackRunDoc = {
    _id: runId,
    workflowId: input.workflowId,
    playedAt: input.playedAt,
    userId: input.userId,
    status: input.status,
    failedEventIndex: input.failedEventIndex ?? null,
    failedEventType: input.failedEventType ?? null,
    failedEventSelector: input.failedEventSelector ?? null,
  }

  await playbackRuns.insertOne(run)

  if (input.checkpoints.length > 0) {
    const checkpoints: PlaybackCheckpointDoc[] = input.checkpoints.map((checkpoint) => ({
      _id: randomUUID(),
      runId,
      index: checkpoint.index,
      label: checkpoint.label ?? null,
      checkpointType: checkpoint.checkpointType ?? null,
      dataUrl: checkpoint.dataUrl ?? null,
      capturedData: checkpoint.capturedData ?? null,
      createdAt: new Date(),
    }))

    await playbackCheckpoints.insertMany(checkpoints)
  }

  return {
    id: runId,
    status: run.status,
    failedEventIndex: run.failedEventIndex ?? null,
    failedEventType: run.failedEventType ?? null,
    failedEventSelector: run.failedEventSelector ?? null,
  }
}
