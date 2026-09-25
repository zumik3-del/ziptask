import type { Task, TaskStatus } from './tasks'
import { isValidTransition, TERMINAL_STATUSES, nowIso, sanitizePipe, clampLimit, MAX_TITLE_LENGTH, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH } from './tasks'
import type { TaskStore, TimelineRow, CommentRow, SvcResult } from './types'
import { parseDeps, createsCycle, depsSatisfied } from './deps'
import {
  SECOND_MS, MINUTE_MS, CANDIDATES_PAGE_SIZE, DEFAULT_LEASE_TTL_MIN, DEFAULT_MAX_ATTEMPTS,
  DEFAULT_AUDIT_LOG, DEFAULT_REAP_COOLDOWN_SEC, DEFAULT_AUTO_CLAIM_CEILING, DEFAULT_PRIORITY,
  DEFAULT_REPORTER, DEFAULT_LIST_LIMIT, DEFAULT_TIMELINE_LIMIT, DEFAULT_QUEUE_LIMIT
} from '../defaults'

export class TaskService {
  private readonly leaseTtlMin: number
  private readonly maxAttempts: number
  private readonly auditLog: boolean
  private readonly reapCooldownSec: number
  private readonly autoClaimCeiling: number
  private readonly defaultPriority: string
  private readonly defaultReporter: string
  private readonly listLimit: number
  private readonly timelineLimit: number
  private readonly queueLimit: number
  private lastReapAt = 0

  constructor(private store: TaskStore, opts?: {
    leaseTtlMin?: number; maxAttempts?: number; auditLog?: boolean; reapCooldownSec?: number; autoClaimCeiling?: number
    defaultPriority?: string; defaultReporter?: string; listLimit?: number; timelineLimit?: number; queueLimit?: number
  }) {
    this.leaseTtlMin = opts?.leaseTtlMin ?? DEFAULT_LEASE_TTL_MIN
    this.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.auditLog = opts?.auditLog ?? DEFAULT_AUDIT_LOG
    this.reapCooldownSec = opts?.reapCooldownSec ?? DEFAULT_REAP_COOLDOWN_SEC
    this.autoClaimCeiling = opts?.autoClaimCeiling ?? DEFAULT_AUTO_CLAIM_CEILING
    this.defaultPriority = opts?.defaultPriority ?? DEFAULT_PRIORITY
    this.defaultReporter = opts?.defaultReporter ?? DEFAULT_REPORTER
    this.listLimit = opts?.listLimit ?? DEFAULT_LIST_LIMIT
    this.timelineLimit = opts?.timelineLimit ?? DEFAULT_TIMELINE_LIMIT
    this.queueLimit = opts?.queueLimit ?? DEFAULT_QUEUE_LIMIT
  }

  private _shouldReap(): boolean {
    return Date.now() - this.lastReapAt >= this.reapCooldownSec * SECOND_MS
  }

  private _leaseUntil(): string {
    return new Date(Date.now() + this.leaseTtlMin * MINUTE_MS).toISOString()
  }

  private _requiredError(value: string, field: string): string | null {
    return value.trim() ? null : `INVALID: ${field} required`
  }

  private _tooLongError(value: string, max: number, field: string): string | null {
    return value.length > max ? `INVALID: ${field} too long` : null
  }

  private _contentError(content: string): string | null {
    return this._requiredError(content, 'content') ?? this._tooLongError(content, MAX_CONTENT_LENGTH, 'content')
  }

  private _atomic<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  private _reapIfStale(): void {
    if (this._shouldReap()) this._doReap()
  }

  // claimTask, updateStatus and reapExpiredLeases deliberately bypass the cooldown via _doReap().

  private _doReap(): void {
    const now = nowIso()
    const expired = this.store.expiredLeases(now)
    for (const task of expired) {
      const newAttempts = task.attempts + 1
      const newStatus: TaskStatus = newAttempts > task.max_attempts ? 'failed' : 'queued'
      const changes = this.store.reapTransition(task.id, task.version, newStatus, newAttempts, now)
      if (changes === 1 && this.auditLog) this.store.auditAppend(task.id, 'system', 'lease_expired', 'in_progress', newStatus)
    }
    this.lastReapAt = Date.now()
  }

  createTask(args: {
    title: string; description?: string; priority?: string; assignee?: string
    depends_on?: number[]; reporter?: string; epic?: boolean; epic_id?: number
  }): SvcResult<{ id: number; status: 'queued' }> {
    if (!args.title.trim()) return { ok: false, error: 'INVALID: title required' }
    if (args.title.length > MAX_TITLE_LENGTH) return { ok: false, error: 'INVALID: title too long' }
    const deps = args.depends_on ?? []
    const reporter = args.reporter ?? this.defaultReporter
    const reporterErr = this._tooLongError(reporter, MAX_AGENT_LENGTH, 'reporter')
    if (reporterErr) return { ok: false, error: reporterErr }
    if (args.assignee !== undefined) {
      const assigneeErr = this._tooLongError(args.assignee, MAX_AGENT_LENGTH, 'assignee')
      if (assigneeErr) return { ok: false, error: assigneeErr }
    }
    const now = nowIso()

    // D5: epic cannot coexist with epic_id or depends_on
    if (args.epic && args.epic_id !== undefined) {
      return { ok: false, error: 'INVALID: epic cannot have a parent epic' }
    }
    if (args.epic && deps.length > 0) {
      return { ok: false, error: 'INVALID: epic cannot have depends_on' }
    }
    // D5: rejects depends_on pointing at an epic
    if (deps.length > 0) {
      const batch = this.store.batchTasks(deps)
      for (const [d, t] of batch) {
        if (t && t.is_epic === 1) {
          return { ok: false, error: `INVALID: dependencies on epic tasks not allowed (#${d})` }
        }
      }
    }
    // D5: epic_id target must exist, be non-terminal, and have epic_id IS NULL
    if (args.epic_id !== undefined) {
      const target = this.store.getTaskRow(args.epic_id)
      if (!target) return { ok: false, error: 'NOT_FOUND' }
      if (TERMINAL_STATUSES.includes(target.status)) {
        return { ok: false, error: 'INVALID: cannot attach to a terminal task' }
      }
      if (target.epic_id !== null) {
        return { ok: false, error: 'INVALID: cannot attach to a sub-task (no nesting)' }
      }
    }

    const isEpic = args.epic ? 1 : 0
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
        isEpic
      })
      if (createsCycle((depId) => this.store.depsOf(depId), id, deps)) {
        this.store.deleteTask(id)
        return { ok: false, error: 'CYCLE: dependency graph contains a cycle' }
      }
      if (this.auditLog) this.store.auditAppend(id, reporter, 'create', undefined, 'queued')

      // D2: auto-promote target epic and D6: mirror subtask_add (same transaction)
      if (epicId !== null) {
        this.store.promoteEpicWithMirror(epicId, reporter, 'subtask_add',
          `#${id} ${sanitizePipe(args.title)}`, now, this.auditLog)
      }

      return { ok: true, data: { id, status: 'queued' } }
    })
  }

  getTaskView(id: number): SvcResult<{ task: Task; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number; canceled: number } }> {
    this._reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    const deps = parseDeps(task.depends_on)
    const depStatuses = this.store.statusesOf(deps)
    const blockedBy = deps.filter(d => {
      const s = depStatuses.get(d)
      return s === undefined || !TERMINAL_STATUSES.includes(s)
    })
    // D3: derived roll-up for epics
    if (task.is_epic === 1) {
      const counts = this.store.childStatusCounts(id)
      if (counts.total > 0) {
        return { ok: true, data: { task, blockedBy, subtasks: counts } }
      }
    }
    return { ok: true, data: { task, blockedBy } }
  }

  listTasks(args: { assignee?: string; status?: string; updated_since?: number; epic_id?: number; limit?: number; ids?: number[] }): { tasks: Task[]; total: number } | { items: Array<{ id: number; task: Task | null }>; total: number } {
    this._reapIfStale()
    if (args.ids !== undefined && args.ids.length > 0) {
      const batch = this.store.batchTasks(args.ids)
      return {
        items: args.ids.map(id => ({ id, task: batch.get(id) ?? null })),
        total: args.ids.length
      }
    }
    const { rows, total } = this.store.listTasks({
      assignee: args.assignee,
      status: args.status,
      updatedSinceIso: args.updated_since !== undefined ? new Date(args.updated_since).toISOString() : undefined,
      epicId: args.epic_id,
      limit: clampLimit(args.limit, this.listLimit)
    })
    return { tasks: rows, total }
  }

  private _readyCandidates(limit: number): Task[] {
    const ready: Task[] = []
    if (limit <= 0) return ready
    const depCache = new Map<number, number[]>()
    let offset = 0
    while (ready.length < limit && offset < this.autoClaimCeiling) {
      const page = this.store.queuedCandidates(CANDIDATES_PAGE_SIZE, offset)
      if (page.length === 0) break
      const allDeps = new Set<number>()
      for (const row of page) {
        let deps = depCache.get(row.id)
        if (deps === undefined) { deps = parseDeps(row.depends_on); depCache.set(row.id, deps) }
        for (const dep of deps) allDeps.add(dep)
      }
      const depStatuses = this.store.statusesOf(Array.from(allDeps))
      for (const row of page) {
        if (ready.length >= limit) break
        if (depsSatisfied(depStatuses, depCache.get(row.id)!)) ready.push(row)
      }
      offset += CANDIDATES_PAGE_SIZE
    }
    return ready
  }

  claimTask(args: { agent: string; task_id?: number }): SvcResult<{ id: number; leaseTtlMin: number; task: Task }> {
    const agentErr = this._requiredError(args.agent, 'agent') ?? this._tooLongError(args.agent, MAX_AGENT_LENGTH, 'agent')
    if (agentErr) return { ok: false, error: agentErr }
    this._doReap()
    let task: Task | null = null

    if (args.task_id) {
      task = this.store.getTaskRow(args.task_id)
      if (!task) return { ok: false, error: 'NOT_FOUND' }
      if (task.status !== 'queued' && task.status !== 'blocked') return { ok: false, error: `CONFLICT: status=${task.status}` }
      if (task.is_epic === 1) return { ok: false, error: `INVALID: #${task.id} is an epic, not claimable` }
      const deps = parseDeps(task.depends_on)
      if (!depsSatisfied(this.store.statusesOf(deps), deps)) return { ok: false, error: 'BLOCKED: dependencies not satisfied' }
    } else {
      task = this._readyCandidates(1)[0] ?? null
    }

    if (!task) return { ok: false, error: 'EMPTY: no claimable tasks' }

    const now = nowIso()
    const leaseUntil = this._leaseUntil()
    const changes = this.store.markClaimed(task.id, task.version, args.agent, leaseUntil, now)
    const updated = this.store.getTaskRow(task.id)
    if (changes !== 1 || updated?.status !== 'in_progress') return { ok: false, error: 'CONFLICT: version mismatch' }
    if (this.auditLog) this.store.auditAppend(task.id, args.agent, 'claim', task.status, 'in_progress')
    return { ok: true, data: { id: task.id, leaseTtlMin: this.leaseTtlMin, task: updated } }
  }

  updateStatus(args: { id: number; agent: string; status: TaskStatus; version: number; comment?: string }): SvcResult<{ id: number; status: TaskStatus; version: number }> {
    const agentErr = this._requiredError(args.agent, 'agent') ?? this._tooLongError(args.agent, MAX_AGENT_LENGTH, 'agent')
    if (agentErr) return { ok: false, error: agentErr }
    if (args.comment !== undefined) {
      const commentErr = this._contentError(args.comment)
      if (commentErr) return { ok: false, error: commentErr }
    }
    this._doReap()
    const task = this.store.getTaskRow(args.id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    if (task.version !== args.version) return { ok: false, error: `CONFLICT: expected version ${task.version}, got ${args.version}` }
    if (!isValidTransition(task.status, args.status)) return { ok: false, error: `INVALID: ${task.status} → ${args.status}` }

    // D3: epic terminal guard — reject done/failed while non-terminal children exist
    if (task.is_epic === 1 && TERMINAL_STATUSES.includes(args.status)) {
      const open = this.store.nonTerminalChildCount(args.id)
      if (open > 0) {
        return { ok: false, error: `CHILDREN: ${open} sub-tasks not terminal` }
      }
    }

    const now = nowIso()
    const completedAt = TERMINAL_STATUSES.includes(args.status) ? now : null
    const leaseUntil = args.status === 'in_progress' ? this._leaseUntil() : null
    // D6: mirror subtask_done/subtask_failed onto the parent epic
    const subtaskMirror = args.status === 'done' ? 'subtask_done' : args.status === 'failed' ? 'subtask_failed' : null

    return this._atomic((): SvcResult<{ id: number; status: TaskStatus; version: number }> => {
      const changes = this.store.transitionStatus(args.id, args.version, args.status, now, completedAt, leaseUntil)
      if (changes !== 1) return { ok: false, error: 'CONFLICT: concurrent modification' }
      const updated = this.store.getTaskRow(args.id)
      if (!updated) return { ok: false, error: 'CONFLICT: concurrent modification' }
      if (this.auditLog) this.store.auditAppend(args.id, args.agent, 'update_status', task.status, args.status)
      if (args.comment) {
        const type: 'comment' | 'resolution' = TERMINAL_STATUSES.includes(args.status) ? 'resolution' : 'comment'
        this.store.insertComment(args.id, args.agent, args.comment, type)
      }

      if (task.epic_id !== null && subtaskMirror !== null && this.auditLog) {
        const epicTask = this.store.getTaskRow(task.epic_id)
        if (epicTask) {
          this.store.appendEpicAuditMirror(task.epic_id, args.agent, subtaskMirror,
            `#${task.id} ${sanitizePipe(task.title)}`)
        }
      }

      return { ok: true, data: { id: args.id, status: args.status, version: updated.version } }
    })
  }

  listQueue(args: { limit?: number }): Task[] {
    this._reapIfStale()
    const limit = clampLimit(args.limit, this.queueLimit)
    return this._readyCandidates(limit)
  }

  addComment(args: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    this._reapIfStale()
    const task = this.store.getTaskRow(args.id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    const validationErr =
      this._requiredError(args.agent, 'agent') ??
      this._tooLongError(args.agent, MAX_AGENT_LENGTH, 'agent') ??
      this._contentError(args.content)
    if (validationErr) return { ok: false, error: validationErr }
    const comment_id = this.store.insertComment(args.id, args.agent, args.content)
    return { ok: true, data: { comment_id } }
  }

  getTimeline(id: number, limit?: number): SvcResult<TimelineRow[]> {
    this._reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    const limitN = clampLimit(limit, this.timelineLimit)
    const rows = this.store.timelineEntries(id, limitN)
    return { ok: true, data: rows }
  }

  listComments(id: number): SvcResult<CommentRow[]> {
    this._reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    return { ok: true, data: this.store.commentsOf(id) }
  }

  reapExpiredLeases(): void {
    this._doReap()
  }
}
