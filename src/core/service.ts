import type { Task, TaskStatus, TaskPriority, Clock } from './tasks'
import { TERMINAL_STATUSES, nowIso, monotonicNowMs, sanitizePipe, clampLimit, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH, asClock } from './tasks'
import type { CommentRow, ProjectListItem, ProjectRow, ProjectStore, Store, TimelineRow, SvcResult, SvcError, UpdateStatusData } from './types'
import { parseDeps, createsCycle, blockingDeps } from './deps'
import { readyCandidates } from './candidates'
import { ok, fail } from './result'
import { LeaseReaper } from './reaper'
import { createTaskGuard, updateStatusGuard, claimEligibilityError } from './guards'
import { requiredError, tooLongError } from './validation'
import { resolveProject, createProject, updateProject, deleteProject } from './projects'
import {
  MINUTE_MS, DEFAULT_LEASE_TTL_MIN, DEFAULT_MAX_ATTEMPTS,
  DEFAULT_AUDIT_LOG, DEFAULT_REAP_COOLDOWN_SEC, DEFAULT_AUTO_CLAIM_CEILING, DEFAULT_PRIORITY,
  DEFAULT_REPORTER, DEFAULT_LIST_LIMIT, DEFAULT_TIMELINE_LIMIT, DEFAULT_QUEUE_LIMIT
} from '../defaults'

type CreateTaskArgs = {
  title: string; description?: string; priority?: TaskPriority; assignee?: string
  depends_on?: number[]; reporter?: string; epic?: boolean; epic_id?: number; project?: string
}

type ListTasksArgs = {
  assignee?: string; status?: TaskStatus; updated_since?: number; epic_id?: number
  limit?: number; project?: string
}

type UpdateStatusArgs = {
  id: number; agent: string; status: TaskStatus; version?: number; comment?: string; renew?: boolean; reset_attempts?: boolean
}

type ListQueueArgs = { limit?: number; project?: string }
type ClaimTaskArgs = { agent: string; taskId?: number; leaseTtlMin?: number; project?: string }

export type TaskServiceOptions = {
  leaseTtlMin?: number; maxAttempts?: number; auditLog?: boolean; reapCooldownSec?: number; autoClaimCeiling?: number
  defaultPriority?: TaskPriority; defaultReporter?: string; listLimit?: number; timelineLimit?: number; queueLimit?: number
  scope?: string
  clock?: unknown
}

type ResolvedOptions = Required<Omit<TaskServiceOptions, 'scope' | 'clock'>> & Pick<TaskServiceOptions, 'scope'>

function resolveOptions(opts: TaskServiceOptions): ResolvedOptions {
  return {
    leaseTtlMin: opts.leaseTtlMin ?? DEFAULT_LEASE_TTL_MIN,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    auditLog: opts.auditLog ?? DEFAULT_AUDIT_LOG,
    reapCooldownSec: opts.reapCooldownSec ?? DEFAULT_REAP_COOLDOWN_SEC,
    autoClaimCeiling: opts.autoClaimCeiling ?? DEFAULT_AUTO_CLAIM_CEILING,
    defaultPriority: opts.defaultPriority ?? DEFAULT_PRIORITY,
    defaultReporter: opts.defaultReporter ?? DEFAULT_REPORTER,
    listLimit: opts.listLimit ?? DEFAULT_LIST_LIMIT,
    timelineLimit: opts.timelineLimit ?? DEFAULT_TIMELINE_LIMIT,
    queueLimit: opts.queueLimit ?? DEFAULT_QUEUE_LIMIT,
    scope: opts.scope
  }
}

function agentError(agent: string): SvcError | null {
  return requiredError(agent, 'agent') ?? tooLongError(agent, MAX_AGENT_LENGTH, 'agent')
}

function contentError(content: string): SvcError | null {
  return requiredError(content, 'content') ?? tooLongError(content, MAX_CONTENT_LENGTH, 'content')
}

export class ProjectService {
  constructor(private readonly store: ProjectStore, private readonly scope?: string) {}

  resolve(project?: string): SvcResult<ProjectRow> {
    return resolveProject(this.store, project ?? this.scope)
  }

  create(args: { slug?: string; folder_path?: string }): SvcResult<{ slug: string }> {
    return createProject(this.store, args)
  }

  list(): ReadonlyArray<ProjectListItem> {
    return this.store.listProjects()
  }

  update(args: { project: string; slug?: string; folder_path?: string; archived?: boolean }): SvcResult<{ slug: string }> {
    return updateProject(this.store, args)
  }

  delete(project: string): SvcResult<{ deleted: string }> {
    return deleteProject(this.store, project)
  }
}

export class TaskLifecycleService {
  private readonly opts: ResolvedOptions
  private readonly clock: Clock | null
  private readonly reaper: LeaseReaper
  readonly projects: ProjectService

  constructor(private store: Store, opts: TaskServiceOptions = {}, reaper?: LeaseReaper, projects?: ProjectService) {
    this.opts = resolveOptions(opts)
    this.clock = asClock(opts.clock)
    this.reaper = reaper ?? new LeaseReaper(store, this.opts.reapCooldownSec, this.opts.auditLog, this.clock)
    this.projects = projects ?? new ProjectService(store, this.opts.scope)
  }

  private _nowMs(): number {
    return this.clock ? this.clock.nowMs() : monotonicNowMs()
  }

  private _nowIso(): string {
    return this.clock ? this.clock.nowIso() : nowIso()
  }

  private _isoFromNow(offsetMs: number): string {
    return new Date(this._nowMs() + offsetMs).toISOString()
  }

  private _leaseUntil(ttlMin: number = this.opts.leaseTtlMin): string {
    return this._isoFromNow(ttlMin * MINUTE_MS)
  }

  private _createTaskGuard(args: CreateTaskArgs, project: ProjectRow): SvcError | null {
    return createTaskGuard({
      ...args,
      defaultReporter: this.opts.defaultReporter,
      project: project.slug,
      projectArchived: project.archived_at !== null
    }, this.store)
  }

  createTask(args: CreateTaskArgs): SvcResult<{ id: number; status: 'queued' }> {
    const project = this.projects.resolve(args.project)
    if (!project.ok) return fail(project.error)
    const guard = this._createTaskGuard(args, project.data)
    if (guard) return fail(guard)
    const deps = args.depends_on ?? []
    const reporter = args.reporter ?? this.opts.defaultReporter
    const now = this._nowIso()
    const epicId = args.epic_id ?? null
    return this.store.transaction((): SvcResult<{ id: number; status: 'queued' }> => {
      const id = this.store.insertTask({
        title: args.title,
        description: args.description ?? null,
        priority: args.priority ?? this.opts.defaultPriority,
        assignee: args.assignee ?? null,
        reporter,
        depends_on: JSON.stringify(deps),
        now,
        maxAttempts: this.opts.maxAttempts,
        epicId: epicId ?? undefined,
        isEpic: args.epic,
        projectId: project.data.id
      })
      if (createsCycle((depId) => this.store.depsOf(depId), id, deps)) {
        this.store.deleteTask(id)
        return fail('CYCLE', 'dependency graph contains a cycle')
      }
      if (this.opts.auditLog) this.store.auditAppend(id, reporter, 'create', undefined, 'queued')

      if (epicId !== null) {
        this.store.promoteEpicWithMirror(epicId, reporter, 'subtask_add',
          `#${id} ${sanitizePipe(args.title)}`, now, this.opts.auditLog)
      }

      return ok({ id, status: 'queued' as const })
    })
  }

  claimTask(args: ClaimTaskArgs): SvcResult<{ id: number; leaseTtlMin: number; task: Readonly<Task> }> {
    const agentErr = agentError(args.agent)
    if (agentErr) return fail(agentErr)
    let projectId: number | undefined
    if (args.taskId === undefined) {
      const project = this.projects.resolve(args.project)
      if (!project.ok) return fail(project.error)
      projectId = project.data.id
    }
    this.reaper.reap()
    let task: Task | null = null

    if (args.taskId !== undefined) {
      task = this.store.getTaskRow(args.taskId)
      if (!task) return fail('NOT_FOUND')
      if (task.status !== 'queued' && task.status !== 'blocked') return fail('CONFLICT', `status=${task.status}`)
      const claimErr = claimEligibilityError(task, this.store)
      if (claimErr) return fail(claimErr)
    } else if (projectId !== undefined) {
      task = readyCandidates(this.store, 1, this.opts.autoClaimCeiling, projectId)[0] ?? null
    }

    if (!task) return fail('EMPTY', 'no claimable tasks')
    const claimedTask = task

    const now = this._nowIso()
    const leaseTtlMin = args.leaseTtlMin ?? this.opts.leaseTtlMin
    const leaseUntil = this._leaseUntil(leaseTtlMin)
    return this.store.transaction((): SvcResult<{ id: number; leaseTtlMin: number; task: Readonly<Task> }> => {
      const changes = this.store.markClaimed(claimedTask.id, claimedTask.version, args.agent, leaseUntil, now)
      const updated = this.store.getTaskRow(claimedTask.id)
      if (changes !== 1 || !updated) return fail('CONFLICT', 'version mismatch')
      if (this.opts.auditLog) this.store.auditAppend(claimedTask.id, args.agent, 'claim', claimedTask.status, 'in_progress')
      return ok({ id: claimedTask.id, leaseTtlMin, task: updated })
    })
  }

  updateStatus(args: UpdateStatusArgs): SvcResult<UpdateStatusData> {
    const agentErr = agentError(args.agent)
    if (agentErr) return fail(agentErr)
    if (args.comment !== undefined) {
      const commentErr = contentError(args.comment)
      if (commentErr) return fail(commentErr)
    }
    const refund = args.reset_attempts === true
    if (refund && !args.comment?.trim()) return fail('INVALID', 'reset_attempts requires a comment')
    this.reaper.reap()
    const task = this.store.getTaskRow(args.id)
    if (!task) return fail('NOT_FOUND')
    const guard = updateStatusGuard(args, task, refund, this.store)
    if (guard) return fail(guard)
    return this._applyTransition(args, task, refund)
  }

  private _applyTransition(args: UpdateStatusArgs, task: Task, refund: boolean): SvcResult<UpdateStatusData> {
    const renewal = task.status === 'in_progress' && args.status === 'in_progress' && args.renew === true
    const now = this._nowIso()
    const completedAt = TERMINAL_STATUSES.includes(args.status) ? now : null
    const leaseUntil = args.status === 'in_progress' ? this._leaseUntil() : null
    const subtaskMirror = args.status === 'done' ? 'subtask_done' : args.status === 'failed' ? 'subtask_failed' : null

    return this.store.transaction((): SvcResult<UpdateStatusData> => {
      const expectedVersion = args.version ?? task.version
      const changes = this.store.transitionStatus(args.id, expectedVersion, args.status, now, completedAt, leaseUntil, args.agent, refund ? 1 : 0)
      if (changes !== 1) return fail('CONFLICT', 'concurrent modification')
      const updated = this.store.getTaskRow(args.id)
      if (!updated) return fail('CONFLICT', 'concurrent modification')
      if (this.opts.auditLog) {
        if (renewal) {
          this.store.auditAppend(args.id, args.agent, 'lease_renewed', task.lease_expires_at ?? undefined, updated.lease_expires_at ?? undefined)
        } else {
          this.store.auditAppend(args.id, args.agent, 'update_status', task.status, args.status)
        }
        if (refund) this.store.auditAppend(args.id, args.agent, 'attempts_reset', String(task.attempts), '0')
      }
      if (args.comment) {
        const type: 'comment' | 'resolution' = TERMINAL_STATUSES.includes(args.status) ? 'resolution' : 'comment'
        this.store.insertComment(args.id, args.agent, args.comment, type)
      }

      if (task.epic_id !== null && subtaskMirror !== null && this.opts.auditLog) {
        this.store.appendEpicAuditMirror(task.epic_id, args.agent, subtaskMirror,
          `#${task.id} ${sanitizePipe(task.title)}`)
      }

      return ok({ id: args.id, status: args.status, version: updated.version, ...(refund ? { attempts: updated.attempts } : {}) })
    })
  }

  reapExpiredLeases(): void {
    this.reaper.reap()
  }
}

export class TaskQueryService {
  private readonly opts: ResolvedOptions
  private readonly clock: Clock | null
  private readonly reaper: LeaseReaper
  readonly projects: ProjectService

  constructor(private store: Store, opts: TaskServiceOptions = {}, reaper?: LeaseReaper, projects?: ProjectService) {
    this.opts = resolveOptions(opts)
    this.clock = asClock(opts.clock)
    this.reaper = reaper ?? new LeaseReaper(store, this.opts.reapCooldownSec, this.opts.auditLog, this.clock)
    this.projects = projects ?? new ProjectService(store, this.opts.scope)
  }

  getTaskView(id: number): SvcResult<{ task: Readonly<Task>; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number; canceled: number } }> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    const deps = parseDeps(task.depends_on)
    const depStatuses = this.store.statusesOf(deps)
    const blockedBy = blockingDeps(depStatuses, deps)
    if (task.is_epic) {
      const counts = this.store.childStatusCounts(id)
      if (counts.total > 0) {
        return ok({ task, blockedBy, subtasks: counts })
      }
    }
    return ok({ task, blockedBy })
  }

  listTasks(args: ListTasksArgs): SvcResult<{ tasks: ReadonlyArray<Readonly<Task>>; total: number }> {
    const project = this.projects.resolve(args.project)
    if (!project.ok) return fail(project.error)
    if (args.updated_since !== undefined) {
      if (!Number.isFinite(args.updated_since)) return fail('INVALID', 'invalid updated_since')
      const updatedSinceDate = new Date(args.updated_since)
      if (Number.isNaN(updatedSinceDate.getTime())) return fail('INVALID', 'invalid updated_since')
    }
    this.reaper.reapIfStale()
    const updatedSinceIso = args.updated_since !== undefined ? new Date(args.updated_since).toISOString() : undefined
    const { rows, total } = this.store.listTasks({
      assignee: args.assignee,
      status: args.status,
      updatedSinceIso,
      epicId: args.epic_id,
      limit: clampLimit(args.limit, this.opts.listLimit),
      projectId: project.data.id
    })
    return ok({ tasks: rows, total })
  }

  getTasksByIds(ids: number[]): SvcResult<{ items: Array<{ id: number; task: Readonly<Task> | null }>; total: number }> {
    this.reaper.reapIfStale()
    const batch = this.store.batchTasks(ids)
    return ok({
      items: ids.map(id => ({ id, task: batch.get(id) ?? null })),
      total: ids.length
    })
  }

  listQueue(args: ListQueueArgs): SvcResult<ReadonlyArray<Readonly<Task>>> {
    const project = this.projects.resolve(args.project)
    if (!project.ok) return fail(project.error)
    this.reaper.reapIfStale()
    const limit = clampLimit(args.limit, this.opts.queueLimit)
    return ok(readyCandidates(this.store, limit, this.opts.autoClaimCeiling, project.data.id))
  }

  addComment(args: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(args.id)
    if (!task) return fail('NOT_FOUND')
    const validationErr =
      agentError(args.agent) ??
      contentError(args.content)
    if (validationErr) return fail(validationErr)
    const comment_id = this.store.insertComment(args.id, args.agent, args.content)
    return ok({ comment_id })
  }

  getTimeline(id: number, limit?: number): SvcResult<ReadonlyArray<Readonly<TimelineRow>>> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    const limitN = clampLimit(limit, this.opts.timelineLimit)
    const rows = this.store.timelineEntries(id, limitN)
    return ok(rows)
  }

  listComments(id: number): SvcResult<ReadonlyArray<Readonly<CommentRow>>> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    return ok(this.store.commentsOf(id))
  }
}

export class TaskService {
  protected readonly store: Store
  private readonly opts: ResolvedOptions
  private readonly clock: Clock | null
  private readonly reaper: LeaseReaper
  readonly projects: ProjectService
  readonly lifecycle: TaskLifecycleService
  readonly query: TaskQueryService

  constructor(store: Store, opts: TaskServiceOptions = {}) {
    this.store = store
    this.opts = resolveOptions(opts)
    this.clock = asClock(opts.clock)
    this.reaper = new LeaseReaper(store, this.opts.reapCooldownSec, this.opts.auditLog, this.clock)
    this.projects = new ProjectService(store, this.opts.scope)
    this.lifecycle = new TaskLifecycleService(store, opts, this.reaper, this.projects)
    this.query = new TaskQueryService(store, opts, this.reaper, this.projects)
  }

  createTask(args: CreateTaskArgs): SvcResult<{ id: number; status: 'queued' }> {
    return this.lifecycle.createTask(args)
  }

  getTaskView(id: number): SvcResult<{ task: Readonly<Task>; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number; canceled: number } }> {
    return this.query.getTaskView(id)
  }

  listTasks(args: ListTasksArgs): SvcResult<{ tasks: ReadonlyArray<Readonly<Task>>; total: number }> {
    return this.query.listTasks(args)
  }

  getTasksByIds(ids: number[]): SvcResult<{ items: Array<{ id: number; task: Readonly<Task> | null }>; total: number }> {
    return this.query.getTasksByIds(ids)
  }

  claimTask(args: ClaimTaskArgs): SvcResult<{ id: number; leaseTtlMin: number; task: Readonly<Task> }> {
    return this.lifecycle.claimTask(args)
  }

  updateStatus(args: UpdateStatusArgs): SvcResult<UpdateStatusData> {
    return this.lifecycle.updateStatus(args)
  }

  listQueue(args: ListQueueArgs): SvcResult<ReadonlyArray<Readonly<Task>>> {
    return this.query.listQueue(args)
  }

  addComment(args: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    return this.query.addComment(args)
  }

  getTimeline(id: number, limit?: number): SvcResult<ReadonlyArray<Readonly<TimelineRow>>> {
    return this.query.getTimeline(id, limit)
  }

  listComments(id: number): SvcResult<ReadonlyArray<Readonly<CommentRow>>> {
    return this.query.listComments(id)
  }

  reapExpiredLeases(): void {
    this.lifecycle.reapExpiredLeases()
  }
}

export { TaskLifecycleService as TaskLifecycle }
export { TaskLifecycleService as LifecycleService }
export { TaskQueryService as TaskQuery }
export { TaskQueryService as QueryService }
