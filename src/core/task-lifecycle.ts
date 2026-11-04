import { createHash } from 'node:crypto'
import type { Task, TaskStatus, TaskPriority, CreatedTaskStatus, Clock } from './tasks'
import { TERMINAL_STATUSES, nowIso, monotonicNowMs, sanitizePipe, MAX_LEASE_TTL_MIN, LEASE_TTL_TOO_LARGE_MESSAGE, normalizePriority, PRIORITY_INVALID_MESSAGE, codePointLength } from './tasks'
import type { LifecycleStore, ProjectRow, SvcResult, SvcError, UpdateStatusData, UpdateTaskData } from './types'
import { createsCycle, collapseDeps } from './deps'
import { readyCandidates } from './candidates'
import { ok, fail } from './result'
import { LeaseReaper } from './reaper'
import { createTaskGuard, updateStatusGuard, updateTaskGuard, editableWindowError, claimEligibilityError, epicNotClaimableError, epicTargetChangedError, epicPromotionRaceError } from './guards'
import { agentError, commentError } from './validation'
import { MINUTE_MS } from '../defaults'
import type { ProjectService } from './project-service'
import type { ResolvedOptions } from './service'

// `priority` is the value as the caller wrote it, so it stays `unknown` here.
export type CreateTaskArgs = {
  title: string; description?: string; priority?: unknown; assignee?: string
  depends_on?: number[]; reporter?: string; epic?: boolean; epic_id?: number; project?: string
}

export type ClaimTaskArgs = { agent: string; taskId?: number; leaseTtlMin?: number; project?: string }

export type UpdateStatusArgs = {
  id: number; agent: string; status: TaskStatus; version?: number; comment?: string; renew?: boolean; reset_attempts?: boolean
}

export type UpdateTaskArgs = {
  id: number; agent: string; version?: number
  title?: string; description?: string | null; priority?: unknown; depends_on?: number[]; comment?: string
}

export class TaskLifecycleService {
  private readonly opts: ResolvedOptions
  private readonly clock: Clock | null
  private readonly reaper: LeaseReaper
  readonly projects: ProjectService

  constructor(private store: LifecycleStore, opts: ResolvedOptions, projects: ProjectService, reaper?: LeaseReaper) {
    this.opts = opts
    this.clock = opts.clock
    this.reaper = reaper ?? new LeaseReaper(store, this.opts.reapCooldownSec, this.opts.auditLog, this.clock)
    this.projects = projects
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

  createTask(args: CreateTaskArgs): SvcResult<{ id: number; status: CreatedTaskStatus }> {
    const project = this.projects.resolve(args.project)
    if (!project.ok) return fail(project.error)
    const dependsOn = Array.isArray(args.depends_on) ? collapseDeps(args.depends_on) : args.depends_on
    const guard = this._createTaskGuard({ ...args, depends_on: dependsOn }, project.data)
    if (guard) return fail(guard)
    const priority = normalizePriority(args.priority === undefined ? this.opts.defaultPriority : args.priority)
    if (priority === null) return fail({ code: 'INVALID', message: PRIORITY_INVALID_MESSAGE })
    const deps = dependsOn ?? []
    const reporter = args.reporter ?? this.opts.defaultReporter
    const now = this._nowIso()
    const epicId = args.epic_id ?? null
    return this.store.transaction((): SvcResult<{ id: number; status: CreatedTaskStatus }> => {
      const created = this.store.insertTask({
        title: args.title,
        description: args.description ?? null,
        priority,
        reporter,
        depends_on: JSON.stringify(deps),
        now,
        maxAttempts: this.opts.maxAttempts,
        epicId: epicId ?? undefined,
        isEpic: args.epic,
        projectId: project.data.id
      })
      const id = created.id
      if (createsCycle((depId) => this.store.depsOf(depId), id, deps)) {
        this.store.deleteTask(id)
        return fail('CYCLE', 'dependency graph contains a cycle')
      }
      if (this.opts.auditLog) this.store.auditAppend(id, reporter, 'create', undefined, created.status)

      if (epicId !== null) {
        const target = this.store.getTaskRow(epicId)
        const changed = epicTargetChangedError(target, epicId, project.data.slug)
        if (changed) {
          this.store.deleteTask(id)
          return fail(changed)
        }
        const promoted = this.store.promoteEpicWithMirror(epicId, reporter, 'subtask_add',
          `#${id} ${sanitizePipe(args.title)}`, now, this.opts.auditLog)
        if (promoted === 0) {
          const after = this.store.getTaskRow(epicId)
          if (!after?.is_epic) {
            this.store.deleteTask(id)
            return fail(epicPromotionRaceError(epicId))
          }
        }
      }

      return ok({ id, status: created.status })
    })
  }

  claimTask(args: ClaimTaskArgs): SvcResult<{ id: number; leaseTtlMin: number; task: Readonly<Task> }> {
    const agentErr = agentError(args.agent)
    if (agentErr) return fail(agentErr)
    const leaseTtlMin = args.leaseTtlMin ?? this.opts.leaseTtlMin
    if (leaseTtlMin > MAX_LEASE_TTL_MIN) return fail('INVALID', LEASE_TTL_TOO_LARGE_MESSAGE)
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
      const epicErr = epicNotClaimableError(task)
      if (epicErr) return fail(epicErr)
      if (task.status !== 'queued' && task.status !== 'blocked') return fail('CONFLICT', `status=${task.status}`)
      const claimErr = claimEligibilityError(task, this.store)
      if (claimErr) return fail(claimErr)
    } else if (projectId !== undefined) {
      task = readyCandidates(this.store, 1, this.opts.autoClaimCeiling, projectId)[0] ?? null
    }

    if (!task) return fail('EMPTY', 'no claimable tasks')
    const claimedTask = task

    const now = this._nowIso()
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
      const commentErr = commentError(args.comment)
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

  private _digestDescription(value: string | null): string {
    // Prefix length of the sha256 hex digest stored in the audit trail.
    const DIGEST_PREFIX_LENGTH = 16
    const hash = createHash('sha256').update(value ?? '', 'utf8').digest('hex').slice(0, DIGEST_PREFIX_LENGTH)
    return `sha256:${hash}:${codePointLength(value ?? '')}`
  }

  updateTask(args: UpdateTaskArgs): SvcResult<UpdateTaskData> {
    const agentErr = agentError(args.agent)
    if (agentErr) return fail(agentErr)
    if (args.comment !== undefined) {
      const commentErr = commentError(args.comment)
      if (commentErr) return fail(commentErr)
    }
    const task = this.store.getTaskRow(args.id)
    if (!task) return fail('NOT_FOUND')
    const dependsOn = Array.isArray(args.depends_on) ? collapseDeps(args.depends_on) : args.depends_on
    const guard = updateTaskGuard({ ...args, depends_on: dependsOn }, task, this.store)
    if (guard) return fail(guard)

    const changed: ('title' | 'description' | 'priority' | 'depends_on')[] = []
    const patch: { title?: string; description?: string | null; priority?: TaskPriority; dependsOn?: string } = {}
    let newPriority: TaskPriority | undefined
    if (args.title !== undefined && args.title !== task.title) {
      changed.push('title')
      patch.title = args.title
    }
    if (args.description !== undefined && args.description !== task.description) {
      changed.push('description')
      patch.description = args.description
    }
    if (args.priority !== undefined) {
      const np = normalizePriority(args.priority)
      if (np !== null && np !== task.priority) {
        changed.push('priority')
        patch.priority = np
        newPriority = np
      }
    }
    if (dependsOn !== undefined) {
      const newDeps = JSON.stringify(dependsOn)
      if (newDeps !== task.depends_on) {
        changed.push('depends_on')
        patch.dependsOn = newDeps
      }
    }
    const order = ['title', 'description', 'priority', 'depends_on']
    changed.sort((a, b) => order.indexOf(a) - order.indexOf(b))

    if (changed.length === 0) {
      return ok({ id: args.id, version: task.version, changed: [] })
    }

    const now = this._nowIso()
    return this.store.transaction((): SvcResult<UpdateTaskData> => {
      if (changed.includes('depends_on') && dependsOn !== undefined) {
        if (createsCycle((depId) => this.store.depsOf(depId), args.id, dependsOn)) {
          return fail('CYCLE', 'dependency graph contains a cycle')
        }
      }
      const expectedVersion = args.version ?? task.version
      const changes = this.store.updateTaskFields(args.id, expectedVersion, patch, now)
      if (changes !== 1) {
        const updated = this.store.getTaskRow(args.id)
        if (!updated || editableWindowError(updated)) {
          return fail('CONFLICT', `task #${args.id} changed state during the update`)
        }
        return fail('CONFLICT', 'concurrent modification')
      }
      const updated = this.store.getTaskRow(args.id)
      if (!updated) return fail('CONFLICT', 'concurrent modification')
      if (this.opts.auditLog) {
        for (const field of changed) {
          if (field === 'title') {
            this.store.auditAppend(args.id, args.agent, 'update_task:title', task.title, args.title)
          } else if (field === 'priority') {
            this.store.auditAppend(args.id, args.agent, 'update_task:priority', task.priority, newPriority)
          } else if (field === 'depends_on') {
            this.store.auditAppend(args.id, args.agent, 'update_task:depends_on', task.depends_on, JSON.stringify(dependsOn))
          } else if (field === 'description') {
            this.store.auditAppend(args.id, args.agent, 'update_task:description', this._digestDescription(task.description), this._digestDescription(args.description ?? null))
          }
        }
      }
      if (args.comment) {
        this.store.insertComment(args.id, args.agent, args.comment, 'comment')
      }
      return ok({ id: args.id, version: updated.version, changed })
    })
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
        this.store.auditAppend(task.epic_id, args.agent, subtaskMirror, undefined, `#${task.id} ${sanitizePipe(task.title)}`)
      }

      return ok({ id: args.id, status: args.status, version: updated.version, ...(refund ? { attempts: updated.attempts } : {}) })
    })
  }

  reapExpiredLeases(): void {
    this.reaper.reap()
  }
}
