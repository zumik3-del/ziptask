import type { Task, TaskStatus } from './tasks'
import { isValidTransition, TERMINAL_STATUSES, nowIso, sanitizePipe } from './tasks'


export interface TaskStore {
  getTaskRow(id: number): Task | null
   insertTask(t: { title: string; description: string | null; priority: string;
     assignee: string | null; reporter: string; depends_on: string; now: string; maxAttempts?: number
     epicId?: number; isEpic?: number }): number
  deleteTask(id: number): void
  listTasks(f: { assignee?: string; status?: string; updatedSinceIso?: string; epicId?: number; limit: number })
    : { rows: Task[]; total: number }
  queuedCandidates(limit?: number, offset?: number): Task[]
  depsOf(id: number): string | null
  statusOf(id: number): TaskStatus | null
  statusesOf(ids: number[]): Map<number, TaskStatus>
  batchTasks(ids: number[]): Map<number, Task | null>
  markClaimed(id: number, expectedVersion: number, agent: string, leaseUntil: string, now: string): number
  transitionStatus(id: number, expectedVersion: number, status: TaskStatus,
    now: string, completedAt: string | null): void
  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>>
  reapSettle(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number
  insertComment(taskId: number, agent: string, content: string, type?: 'comment' | 'resolution'): number
  auditAppend(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void
  timelineEntries(taskId: number, limit: number): TimelineRow[]
  doneCount(sinceIso: string): number
  taskSummaries(): Array<Pick<Task, 'id' | 'status' | 'created_at' | 'updated_at' | 'completed_at' | 'is_epic'>>
  auditTransitionsForTasks(): Array<{ task_id: number; new_value: string; created_at: string }>
  nonTerminalChildCount(epicId: number): number
  childStatusCounts(epicId: number): { total: number; open: number; done: number; failed: number }
  promoteEpicWithMirror(id: number, agent: string, action: string, newValue: string, now: string, auditLog: boolean): void
  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string, now: string): void
}

export type TimelineRow = { type: string; agent: string; text: string; created_at: string }

export type SvcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export class TaskService {
  private readonly leaseTtlMin: number
  private readonly maxAttempts: number
  private readonly auditLog: boolean
  private readonly reapCooldownSec: number
  private readonly autoClaimCeiling: number
  private lastReapAt = 0

  constructor(private store: TaskStore, opts?: { leaseTtlMin?: number; maxAttempts?: number; auditLog?: boolean; reapCooldownSec?: number; autoClaimCeiling?: number }) {
    this.leaseTtlMin = opts?.leaseTtlMin ?? 15
    this.maxAttempts = opts?.maxAttempts ?? 3
    this.auditLog = opts?.auditLog ?? true
    this.reapCooldownSec = opts?.reapCooldownSec ?? 60
    this.autoClaimCeiling = opts?.autoClaimCeiling ?? 10000
  }

  private _shouldReap(force = false): boolean {
    if (force) return true
    const nowMs = Date.now()
    return nowMs - this.lastReapAt >= this.reapCooldownSec * 1000
  }

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
    const deps = a.depends_on ?? []
    const reporter = a.reporter ?? 'system'
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
    const id = this.store.insertTask({
      title: a.title,
      description: a.description ?? null,
      priority: a.priority ?? 'p2',
      assignee: a.assignee ?? null,
      reporter,
      depends_on: JSON.stringify(deps),
      now,
      maxAttempts: this.maxAttempts,
      epicId: epicId ?? undefined,
      isEpic
    })
    if (checkCycles((id) => this.store.depsOf(id), id, deps)) {
      this.store.deleteTask(id)
      return { ok: false, error: 'CYCLE: dependency graph contains a cycle' }
    }
    if (this.auditLog) this.store.auditAppend(id, reporter, 'create', undefined, 'queued')
    if (a.description) this.store.insertComment(id, reporter, a.description)

    // D2: auto-promote target epic and D6: mirror subtask_add (atomic)
    if (epicId !== null) {
      this.store.promoteEpicWithMirror(epicId, reporter, 'subtask_add',
        `#${id} ${sanitizePipe(a.title)}`, now, this.auditLog)
    }

    return { ok: true, data: { id, status: 'queued' } }
  }

  getTaskView(id: number): SvcResult<{ task: Task; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number } }> {
    if (this._shouldReap()) this._doReap()
    const task = this.store.getTaskRow(id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    const deps = parseDeps(task.depends_on)
    const depStatuses = this.store.statusesOf(deps)
    const blockedBy = deps.filter(d => {
      const s = depStatuses.get(d)
      return s && !TERMINAL_STATUSES.includes(s)
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
    if (this._shouldReap()) this._doReap()
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
      limit: a.limit ?? 50
    })
    return { tasks: rows, total }
  }

  claimTask(a: { agent: string; task_id?: number }): SvcResult<{ id: number; leaseTtlMin: number; task: Task }> {
    this._doReap()
    let task: Task | null = null

    if (a.task_id) {
      task = this.store.getTaskRow(a.task_id)
      if (!task) return { ok: false, error: 'NOT_FOUND' }
      if (task.status !== 'queued' && task.status !== 'blocked') return { ok: false, error: `CONFLICT: status=${task.status}` }
      if (task.is_epic === 1) return { ok: false, error: `INVALID: #${task.id} is an epic, not claimable` }
      const deps = parseDeps(task.depends_on)
      if (!depsSatisfied((id) => this.store.statusOf(id), deps)) return { ok: false, error: 'BLOCKED: dependencies not satisfied' }
    } else {
      const BATCH = 100
      const depCache = new Map<number, number[]>()
      let offset = 0
      while (offset < this.autoClaimCeiling) {
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
          const deps = depCache.get(row.id)!
          const satisfied = deps.every(d => {
            const s = depStatuses.get(d)
            return s && TERMINAL_STATUSES.includes(s)
          })
          if (satisfied) { task = row; break }
        }
        if (task) break
        offset += BATCH
      }
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
    this.store.transitionStatus(a.id, a.version, a.status, now, completedAt)
    const updated = this.store.getTaskRow(a.id)
    if (!updated || updated.version !== task.version + 1) return { ok: false, error: 'CONFLICT: concurrent modification' }
    if (this.auditLog) this.store.auditAppend(a.id, a.agent, 'update_status', task.status, a.status)
    if (a.comment) {
      const type: 'comment' | 'resolution' = TERMINAL_STATUSES.includes(a.status) ? 'resolution' : 'comment'
      this.store.insertComment(a.id, a.agent, a.comment, type)
    }

    // D6: mirror subtask_done/subtask_failed onto the parent epic
    if (task.epic_id !== null && TERMINAL_STATUSES.includes(a.status) && this.auditLog) {
      const epicTask = this.store.getTaskRow(task.epic_id)
      if (epicTask) {
        this.store.appendEpicAuditMirror(task.epic_id, a.agent,
          a.status === 'done' ? 'subtask_done' : 'subtask_failed',
          `#${task.id} ${sanitizePipe(task.title)}`, now)
      }
    }

    return { ok: true, data: { id: a.id, status: a.status, version: updated.version } }
  }

  listQueue(a: { limit?: number }): Task[] {
    if (this._shouldReap()) this._doReap()
    const limit = Math.floor(a.limit ?? 100)
    const rows = this.store.queuedCandidates(limit)
    const allDeps = new Set<number>()
    for (const row of rows) {
      for (const dep of parseDeps(row.depends_on)) allDeps.add(dep)
    }
    const depStatuses = this.store.statusesOf(Array.from(allDeps))
    return rows.filter(row => {
      const deps = parseDeps(row.depends_on)
      return deps.every(d => {
        const s = depStatuses.get(d)
        return s && TERMINAL_STATUSES.includes(s)
      })
    })
  }

  addComment(a: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    if (this._shouldReap()) this._doReap()
    const task = this.store.getTaskRow(a.id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    if (!a.agent.trim()) return { ok: false, error: 'EMPTY: agent required' }
    if (!a.content.trim()) return { ok: false, error: 'EMPTY: content required' }
    const comment_id = this.store.insertComment(a.id, a.agent, a.content)
    return { ok: true, data: { comment_id } }
  }

  getTimeline(id: number, limit?: number): SvcResult<TimelineRow[]> {
    if (this._shouldReap()) this._doReap()
    const task = this.store.getTaskRow(id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    const limitN = limit !== undefined ? Math.floor(limit) : 50
    const rows = this.store.timelineEntries(id, limitN)
    return { ok: true, data: rows }
  }

  reapExpiredLeases(): void {
    this._doReap()
  }
}

export function parseDeps(raw: string): number[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (Array.isArray(parsed)) return parsed.filter((x): x is number => typeof x === 'number')
  return []
}

export function checkCycles(depsOf: (id: number) => string | null, taskId: number, dependsOn: number[]): boolean {
  if (dependsOn.length === 0) return false
  const visited = new Set<number>()
  const stack = [...dependsOn]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === taskId) return true
    if (visited.has(current)) continue
    visited.add(current)

    const raw = depsOf(current)
    if (!raw) continue
    const deps = parseDeps(raw)
    for (const dep of deps) {
      if (!visited.has(dep)) stack.push(dep)
    }
  }
  return false
}

export function depsSatisfied(statusOf: (id: number) => TaskStatus | null, dependsOn: number[]): boolean {
  if (dependsOn.length === 0) return true
  for (const depId of dependsOn) {
    const status = statusOf(depId)
    if (!status || !TERMINAL_STATUSES.includes(status)) return false
  }
  return true
}
