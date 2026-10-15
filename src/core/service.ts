import type { Task, TaskStatus, TaskPriority } from './tasks'
import { TERMINAL_STATUSES, nowIso, isoFromNow, sanitizePipe, clampLimit } from './tasks'
import type { ProjectListItem, ProjectRow, TaskStore, TimelineRow, CommentRow, SvcResult, SvcError, UpdateStatusData } from './types'
import { parseDeps, createsCycle, depsSatisfied } from './deps'
import { readyCandidates } from './candidates'
import { ok, fail } from './result'
import { LeaseReaper } from './reaper'
import { createTaskGuard, updateStatusGuard } from './guards'
import { requiredError, tooLongError, epicError, MAX_AGENT, MAX_CONTENT } from './validation'
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
  limit?: number; ids?: number[]; project?: string
}

type UpdateStatusArgs = {
  id: number; agent: string; status: TaskStatus; version?: number; comment?: string; renew?: boolean; reset_attempts?: boolean
}

type ListQueueArgs = { limit?: number; project?: string }
type ClaimTaskArgs = { agent: string; taskId?: number; leaseTtlMin?: number; project?: string }

export class TaskService {
  private readonly leaseTtlMin: number
  private readonly maxAttempts: number
  private readonly auditLog: boolean
  private readonly autoClaimCeiling: number
  private readonly defaultPriority: TaskPriority
  private readonly defaultReporter: string
  private readonly listLimit: number
  private readonly timelineLimit: number
  private readonly queueLimit: number
  private readonly scope: string | undefined
  private readonly reaper: LeaseReaper

  constructor(private store: TaskStore, opts?: {
    leaseTtlMin?: number; maxAttempts?: number; auditLog?: boolean; reapCooldownSec?: number; autoClaimCeiling?: number
    defaultPriority?: TaskPriority; defaultReporter?: string; listLimit?: number; timelineLimit?: number; queueLimit?: number
    scope?: string
  }) {
    this.leaseTtlMin = opts?.leaseTtlMin ?? DEFAULT_LEASE_TTL_MIN
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.auditLog = opts?.auditLog ?? DEFAULT_AUDIT_LOG
    this.autoClaimCeiling = opts?.autoClaimCeiling ?? DEFAULT_AUTO_CLAIM_CEILING
    this.defaultPriority = opts?.defaultPriority ?? DEFAULT_PRIORITY
    this.defaultReporter = opts?.defaultReporter ?? DEFAULT_REPORTER
    this.listLimit = opts?.listLimit ?? DEFAULT_LIST_LIMIT
    this.timelineLimit = opts?.timelineLimit ?? DEFAULT_TIMELINE_LIMIT
    this.queueLimit = opts?.queueLimit ?? DEFAULT_QUEUE_LIMIT
    this.scope = opts?.scope
    this.reaper = new LeaseReaper(store, opts?.reapCooldownSec ?? DEFAULT_REAP_COOLDOWN_SEC, this.auditLog)
  }

  private _leaseUntil(ttlMin: number = this.leaseTtlMin): string {
    return isoFromNow(ttlMin * MINUTE_MS)
  }

  private _agentError(agent: string): SvcError | null {
    return requiredError(agent, 'agent') ?? tooLongError(agent, MAX_AGENT, 'agent')
  }

  private _contentError(content: string): SvcError | null {
    return requiredError(content, 'content') ?? tooLongError(content, MAX_CONTENT, 'content')
  }

  private _epicError(task: Task, message: string): SvcError | null {
    return epicError(task, message)
  }

  private _atomic<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  // The single resolution point: every enumerating call funnels its `project` (or the test-only
  // `scope` fallback) through here, so a missing or unknown slug refuses identically everywhere.
  private _resolveProject(project?: string): SvcResult<ProjectRow> {
    return resolveProject(this.store, project ?? this.scope)
  }

  // Pure precondition set for create_task: title/actor lengths, the epic↔(epic_id|deps) conflicts,
  // the dep-on-epic rule, the epic_id target shape, and the project scope. Returns the first failure or null.
  private _createTaskGuard(args: CreateTaskArgs, project: ProjectRow): SvcError | null {
    return createTaskGuard({
      ...args,
      defaultReporter: this.defaultReporter,
      project: project.slug,
      projectArchived: project.archived_at !== null
    }, this.store)
  }

  createTask(args: CreateTaskArgs): SvcResult<{ id: number; status: 'queued' }> {
    const project = this._resolveProject(args.project)
    if (!project.ok) return fail(project.error)
    const guard = this._createTaskGuard(args, project.data)
    if (guard) return fail(guard)
    const deps = args.depends_on ?? []
    const reporter = args.reporter ?? this.defaultReporter
    const now = nowIso()
    const epicId = args.epic_id ?? null
    return this._atomic((): SvcResult<{ id: number; status: 'queued' }> => {
      const id = this.store.insertTask({
        title: args.title,
        description: args.description ?? null,
        priority: args.priority ?? this.defaultPriority,
        assignee: args.assignee ?? null,
        reporter,
        depends_on: JSON.stringify(deps),
        now,
        maxAttempts: this.maxAttempts,
        epicId: epicId ?? undefined,
        isEpic: args.epic,
        projectId: project.data.id
      })
      if (createsCycle((depId) => this.store.depsOf(depId), id, deps)) {
        this.store.deleteTask(id)
        return fail('CYCLE', 'dependency graph contains a cycle')
      }
      if (this.auditLog) this.store.auditAppend(id, reporter, 'create', undefined, 'queued')

      // D2: auto-promote target epic and D6: mirror subtask_add (same transaction)
      if (epicId !== null) {
        this.store.promoteEpicWithMirror(epicId, reporter, 'subtask_add',
          `#${id} ${sanitizePipe(args.title)}`, now, this.auditLog)
      }

      return ok({ id, status: 'queued' as const })
    })
  }

  getTaskView(id: number): SvcResult<{ task: Readonly<Task>; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number; canceled: number } }> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    const deps = parseDeps(task.depends_on)
    const depStatuses = this.store.statusesOf(deps)
    const blockedBy = deps.filter(d => {
      const s = depStatuses.get(d)
      return s === undefined || !TERMINAL_STATUSES.includes(s)
    })
    // D3: derived roll-up for epics
    if (task.is_epic) {
      const counts = this.store.childStatusCounts(id)
      if (counts.total > 0) {
        return ok({ task, blockedBy, subtasks: counts })
      }
    }
    return ok({ task, blockedBy })
  }

  listTasks(args: ListTasksArgs): SvcResult<{ tasks: ReadonlyArray<Readonly<Task>>; total: number } | { items: Array<{ id: number; task: Readonly<Task> | null }>; total: number }> {
    if (args.ids !== undefined && args.ids.length > 0) {
      this.reaper.reapIfStale()
      const batch = this.store.batchTasks(args.ids)
      return ok({
        items: args.ids.map(id => ({ id, task: batch.get(id) ?? null })),
        total: args.ids.length
      })
    }
    const project = this._resolveProject(args.project)
    if (!project.ok) return fail(project.error)
    this.reaper.reapIfStale()
    const { rows, total } = this.store.listTasks({
      assignee: args.assignee,
      status: args.status,
      updatedSinceIso: args.updated_since !== undefined ? new Date(args.updated_since).toISOString() : undefined,
      epicId: args.epic_id,
      limit: clampLimit(args.limit, this.listLimit),
      projectId: project.data.id
    })
    return ok({ tasks: rows, total })
  }

  claimTask(args: ClaimTaskArgs): SvcResult<{ id: number; leaseTtlMin: number; task: Readonly<Task> }> {
    const agentErr = this._agentError(args.agent)
    if (agentErr) return fail(agentErr)
    // Only the auto-pick branch enumerates, so only it resolves a scope; a by-id claim stays unscoped.
    let projectId: number | undefined
    if (args.taskId === undefined) {
      const project = this._resolveProject(args.project)
      if (!project.ok) return fail(project.error)
      projectId = project.data.id
    }
    this.reaper.reap()
    let task: Task | null = null

    if (args.taskId !== undefined) {
      task = this.store.getTaskRow(args.taskId)
      if (!task) return fail('NOT_FOUND')
      if (task.status !== 'queued' && task.status !== 'blocked') return fail('CONFLICT', `status=${task.status}`)
      const epicErr = this._epicError(task, `#${task.id} is an epic, not claimable`)
      if (epicErr) return fail(epicErr)
      const deps = parseDeps(task.depends_on)
      if (!depsSatisfied(this.store.statusesOf(deps), deps)) return fail('BLOCKED', 'dependencies not satisfied')
    } else if (projectId !== undefined) {
      task = readyCandidates(this.store, 1, this.autoClaimCeiling, projectId)[0] ?? null
    }

    if (!task) return fail('EMPTY', 'no claimable tasks')

    const now = nowIso()
    // a per-claim override lives only for this call: the instance default is never mutated
    const leaseTtlMin = args.leaseTtlMin ?? this.leaseTtlMin
    const leaseUntil = this._leaseUntil(leaseTtlMin)
    const changes = this.store.markClaimed(task.id, task.version, args.agent, leaseUntil, now)
    const updated = this.store.getTaskRow(task.id)
    if (changes !== 1 || !updated) return fail('CONFLICT', 'version mismatch')
    if (this.auditLog) this.store.auditAppend(task.id, args.agent, 'claim', task.status, 'in_progress')
    return ok({ id: task.id, leaseTtlMin, task: updated })
  }

  updateStatus(args: UpdateStatusArgs): SvcResult<UpdateStatusData> {
    const agentErr = this._agentError(args.agent)
    if (agentErr) return fail(agentErr)
    if (args.comment !== undefined) {
      const commentErr = this._contentError(args.comment)
      if (commentErr) return fail(commentErr)
    }
    // an audited escape hatch without a stated reason is what hides the next accidents
    const refund = args.reset_attempts === true
    if (refund && !args.comment?.trim()) return fail('INVALID', 'reset_attempts requires a comment')
    this.reaper.reap()
    const task = this.store.getTaskRow(args.id)
    if (!task) return fail('NOT_FOUND')
    const guard = this._updateStatusGuard(args, task, refund)
    if (guard) return fail(guard)
    return this._applyTransition(args, task, refund)
  }

  // All refusals that do not touch the row: version CAS, the lease self-edge/renew rules, the
  // transition table, claim-grade eligibility for a non-renewal in_progress, the epic refund ban
  // and the epic terminal close-guard. Returns the first failure or null.
  private _updateStatusGuard(args: UpdateStatusArgs, task: Task, refund: boolean): SvcError | null {
    return updateStatusGuard(args, task, refund, this.store)
  }

  private _applyTransition(args: UpdateStatusArgs, task: Task, refund: boolean): SvcResult<UpdateStatusData> {
    const renewal = task.status === 'in_progress' && args.status === 'in_progress' && args.renew === true
    const now = nowIso()
    const completedAt = TERMINAL_STATUSES.includes(args.status) ? now : null
    const leaseUntil = args.status === 'in_progress' ? this._leaseUntil() : null
    // D6: mirror subtask_done/subtask_failed onto the parent epic
    const subtaskMirror = args.status === 'done' ? 'subtask_done' : args.status === 'failed' ? 'subtask_failed' : null

    return this._atomic((): SvcResult<UpdateStatusData> => {
      // CAS on the version read in the guard when the caller omitted it, so an omitted version is not a
      // lost update: a write landing between the read and here still fails as CONFLICT.
      const expectedVersion = args.version ?? task.version
      const changes = this.store.transitionStatus(args.id, expectedVersion, args.status, now, completedAt, leaseUntil, args.agent, refund ? 1 : 0)
      if (changes !== 1) return fail('CONFLICT', 'concurrent modification')
      const updated = this.store.getTaskRow(args.id)
      if (!updated) return fail('CONFLICT', 'concurrent modification')
      if (this.auditLog) {
        // a pure renewal audits as lease_renewed: an update_status row would cut the in_progress
        // segment in statusDurations at every heartbeat
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

      // No existence guard needed: epic_id is never rewritten after insert, the self-FK plus
      // PRAGMA foreign_keys = ON rejects a child whose parent is missing, and the only deleteTask
      // call site (createTask cycle rollback) removes a just-inserted task by its own id — never a
      // parent some child still references.
      if (task.epic_id !== null && subtaskMirror !== null && this.auditLog) {
        this.store.appendEpicAuditMirror(task.epic_id, args.agent, subtaskMirror,
          `#${task.id} ${sanitizePipe(task.title)}`)
      }

      // attempts is echoed only on a refund: its absence is the in-band signal that the flag was
      // silently dropped by an older build (R1)
      return ok({ id: args.id, status: args.status, version: updated.version, ...(refund ? { attempts: updated.attempts } : {}) })
    })
  }

  listQueue(args: ListQueueArgs): SvcResult<ReadonlyArray<Readonly<Task>>> {
    const project = this._resolveProject(args.project)
    if (!project.ok) return fail(project.error)
    this.reaper.reapIfStale()
    const limit = clampLimit(args.limit, this.queueLimit)
    return ok(readyCandidates(this.store, limit, this.autoClaimCeiling, project.data.id))
  }

  createProject(args: { slug?: string; folder_path?: string }): SvcResult<{ slug: string }> {
    return createProject(this.store, args)
  }

  listProjects(): ReadonlyArray<ProjectListItem> {
    return this.store.listProjects()
  }

  updateProject(args: { project: string; slug?: string; folder_path?: string; archived?: boolean }): SvcResult<{ slug: string }> {
    return updateProject(this.store, args)
  }

  deleteProject(project: string): SvcResult<{ deleted: string }> {
    return deleteProject(this.store, project)
  }

  addComment(args: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(args.id)
    if (!task) return fail('NOT_FOUND')
    const validationErr =
      this._agentError(args.agent) ??
      this._contentError(args.content)
    if (validationErr) return fail(validationErr)
    const comment_id = this.store.insertComment(args.id, args.agent, args.content)
    return ok({ comment_id })
  }

  getTimeline(id: number, limit?: number): SvcResult<ReadonlyArray<Readonly<TimelineRow>>> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    const limitN = clampLimit(limit, this.timelineLimit)
    const rows = this.store.timelineEntries(id, limitN)
    return ok(rows)
  }

  listComments(id: number): SvcResult<ReadonlyArray<Readonly<CommentRow>>> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    return ok(this.store.commentsOf(id))
  }

  reapExpiredLeases(): void {
    this.reaper.reap()
  }
}
