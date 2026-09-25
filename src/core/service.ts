import type { Task, TaskStatus } from './tasks'
import { isValidTransition, TERMINAL_STATUSES, nowIso, sanitizePipe, clampLimit, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH } from './tasks'
import type { TaskStore, TimelineRow, CommentRow, SvcResult } from './types'
import { parseDeps, checkCycles, depsSatisfied } from './deps'

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
    this.leaseTtlMin = opts?.leaseTtlMin ?? 15
    this.maxAttempts = opts?.maxAttempts ?? 3
    this.auditLog = opts?.auditLog ?? true
    this.reapCooldownSec = opts?.reapCooldownSec ?? 60
    this.autoClaimCeiling = opts?.autoClaimCeiling ?? 10000
    this.defaultPriority = opts?.defaultPriority ?? 'p2'
    this.defaultReporter = opts?.defaultReporter ?? 'system'
    this.listLimit = opts?.listLimit ?? 50
    this.timelineLimit = opts?.timelineLimit ?? 50
    this.queueLimit = opts?.queueLimit ?? 100
  }

  private _shouldReap(): boolean {
    return Date.now() - this.lastReapAt >= this.reapCooldownSec * 1000
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
      const changes = this.store.reapSettle(task.id, task.version, newStatus, newAttempts, now)
      if (changes === 1 && this.auditLog) this.store.auditAppend(task.id, 'system', 'lease_expired', 'in_progress', newStatus)
    }
    this.lastReapAt = Date.now()
  }

  createTask(a: {
    title: string; description?: string; priority?: string; assignee?: string
    depends_on?: number[]; reporter?: string; epic?: boolean; epic_id?: number
  }): SvcResult<{ id: number; status: 'queued' }> {
    if (!a.title.trim()) return { ok: false, error: 'INVALID: title required' }
    if (a.title.length > 200) return { ok: false, error: 'INVALID: title too long' }
    const deps = a.depends_on ?? []
    const reporter = a.reporter ?? this.defaultReporter
    const now = nowIso()

    // D5: epic cannot coexist with epic_id or depends_on
    if (a.epic && a.epic_id !== undefined) {
      return { ok: false, error: 'INVALID: epic cannot have a parent epic' }
    }
    if (a.epic && deps.length > 0) {
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
    if (a.epic_id !== undefined) {
      const target = this.store.getTaskRow(a.epic_id)
      if (!target) return { ok: false, error: 'NOT_FOUND' }
      if (TERMINAL_STATUSES.includes(target.status)) {
        return { ok: false, error: 'INVALID: cannot attach to a terminal task' }
      }
      if (target.epic_id !== null) {
        return { ok: false, error: 'INVALID: cannot attach to a sub-task (no nesting)' }
      }
    }

    const isEpic = a.epic ? 1 : 0
    const epicId = a.epic_id ?? null
    return this._atomic((): SvcResult<{ id: number; status: 'queued' }> => {
      const id = this.store.insertTask({
        title: a.title,
        description: a.description ?? null,
        priority: a.priority ?? this.defaultPriority,
        assignee: a.assignee ?? null,
        reporter,
        depends_on: JSON.stringify(deps),
        now,
        maxAttempts: this.maxAttempts,
        epicId: epicId ?? undefined,
        isEpic
      })
      if (checkCycles((depId) => this.store.depsOf(depId), id, deps)) {
        this.store.deleteTask(id)
        return { ok: false, error: 'CYCLE: dependency graph contains a cycle' }
      }
      if (this.auditLog) this.store.auditAppend(id, reporter, 'create', undefined, 'queued')

      // D2: auto-promote target epic and D6: mirror subtask_add (same transaction)
      if (epicId !== null) {
        this.store.promoteEpicWithMirror(epicId, reporter, 'subtask_add',
          `#${id} ${sanitizePipe(a.title)}`, now, this.auditLog)
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

  listTasks(a: { assignee?: string; status?: string; updated_since?: number; epic_id?: number; limit?: number; ids?: number[] }): { tasks: Task[]; total: number } | { items: Array<{ id: number; task: Task | null }>; total: number } {
    this._reapIfStale()
    if (a.ids !== undefined && a.ids.length > 0) {
      const batch = this.store.batchTasks(a.ids)
      return {
        items: a.ids.map(id => ({ id, task: batch.get(id) ?? null })),
        total: a.ids.length
      }
    }
    const { rows, total } = this.store.listTasks({
      assignee: a.assignee,
      status: a.status,
      updatedSinceIso: a.updated_since !== undefined ? new Date(a.updated_since).toISOString() : undefined,
      epicId: a.epic_id,
      limit: clampLimit(a.limit, this.listLimit)
    })
    return { tasks: rows, total }
  }

  private _readyCandidates(limit: number): Task[] {
    const ready: Task[] = []
    if (limit <= 0) return ready
    const BATCH = 100
    const depCache = new Map<number, number[]>()
    let offset = 0
    while (ready.length < limit && offset < this.autoClaimCeiling) {
      const page = this.store.queuedCandidates(BATCH, offset)
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
      offset += BATCH
    }
    return ready
  }

  claimTask(a: { agent: string; task_id?: number }): SvcResult<{ id: number; leaseTtlMin: number; task: Task }> {
    if (!a.agent.trim()) return { ok: false, error: 'INVALID: agent required' }
    if (a.agent.length > MAX_AGENT_LENGTH) return { ok: false, error: 'INVALID: agent too long' }
    this._doReap()
    let task: Task | null = null

    if (a.task_id) {
      task = this.store.getTaskRow(a.task_id)
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
    const leaseUntil = new Date(Date.now() + this.leaseTtlMin * 60_000).toISOString()
    const changes = this.store.markClaimed(task.id, task.version, a.agent, leaseUntil, now)
    const updated = this.store.getTaskRow(task.id)
    if (changes !== 1 || updated?.status !== 'in_progress') return { ok: false, error: 'CONFLICT: version mismatch' }
    if (this.auditLog) this.store.auditAppend(task.id, a.agent, 'claim', task.status, 'in_progress')
    return { ok: true, data: { id: task.id, leaseTtlMin: this.leaseTtlMin, task: updated } }
  }

  updateStatus(a: { id: number; agent: string; status: TaskStatus; version: number; comment?: string }): SvcResult<{ id: number; status: TaskStatus; version: number }> {
    if (!a.agent.trim()) return { ok: false, error: 'INVALID: agent required' }
    if (a.agent.length > MAX_AGENT_LENGTH) return { ok: false, error: 'INVALID: agent too long' }
    if (a.comment !== undefined && a.comment.length > MAX_CONTENT_LENGTH) return { ok: false, error: 'INVALID: content too long' }
    this._doReap()
    const task = this.store.getTaskRow(a.id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    if (task.version !== a.version) return { ok: false, error: `CONFLICT: expected version ${task.version}, got ${a.version}` }
    if (!isValidTransition(task.status, a.status)) return { ok: false, error: `INVALID: ${task.status} → ${a.status}` }

    // D3: epic terminal guard — reject done/failed while non-terminal children exist
    if (task.is_epic === 1 && TERMINAL_STATUSES.includes(a.status)) {
      const open = this.store.nonTerminalChildCount(a.id)
      if (open > 0) {
        return { ok: false, error: `CHILDREN: ${open} sub-tasks not terminal` }
      }
    }

    const now = nowIso()
    const completedAt = TERMINAL_STATUSES.includes(a.status) ? now : null
    const leaseUntil = a.status === 'in_progress' ? new Date(Date.now() + this.leaseTtlMin * 60_000).toISOString() : null
    // D6: mirror subtask_done/subtask_failed onto the parent epic
    const subtaskMirror = a.status === 'done' ? 'subtask_done' : a.status === 'failed' ? 'subtask_failed' : null

    return this._atomic((): SvcResult<{ id: number; status: TaskStatus; version: number }> => {
      const changes = this.store.transitionStatus(a.id, a.version, a.status, now, completedAt, leaseUntil)
      if (changes !== 1) return { ok: false, error: 'CONFLICT: concurrent modification' }
      const updated = this.store.getTaskRow(a.id)
      if (!updated) return { ok: false, error: 'CONFLICT: concurrent modification' }
      if (this.auditLog) this.store.auditAppend(a.id, a.agent, 'update_status', task.status, a.status)
      if (a.comment) {
        const type: 'comment' | 'resolution' = TERMINAL_STATUSES.includes(a.status) ? 'resolution' : 'comment'
        this.store.insertComment(a.id, a.agent, a.comment, type)
      }

      if (task.epic_id !== null && subtaskMirror !== null && this.auditLog) {
        const epicTask = this.store.getTaskRow(task.epic_id)
        if (epicTask) {
          this.store.appendEpicAuditMirror(task.epic_id, a.agent, subtaskMirror,
            `#${task.id} ${sanitizePipe(task.title)}`)
        }
      }

      return { ok: true, data: { id: a.id, status: a.status, version: updated.version } }
    })
  }

  listQueue(a: { limit?: number }): Task[] {
    this._reapIfStale()
    const limit = clampLimit(a.limit, this.queueLimit)
    return this._readyCandidates(limit)
  }

  addComment(a: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    this._reapIfStale()
    const task = this.store.getTaskRow(a.id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    if (!a.agent.trim()) return { ok: false, error: 'EMPTY: agent required' }
    if (!a.content.trim()) return { ok: false, error: 'EMPTY: content required' }
    if (a.agent.length > MAX_AGENT_LENGTH) return { ok: false, error: 'INVALID: agent too long' }
    if (a.content.length > MAX_CONTENT_LENGTH) return { ok: false, error: 'INVALID: content too long' }
    const comment_id = this.store.insertComment(a.id, a.agent, a.content)
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
