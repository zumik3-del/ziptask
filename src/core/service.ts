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
  promoteEpic(id: number, now: string): void
  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string, now: string): void
}

export type TimelineRow = { type: string; agent: string; text: string; created_at: string }

export type SvcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export class TaskService {
  private readonly leaseTtlMin: number
  private readonly maxAttempts: number

  constructor(private store: TaskStore, opts?: { leaseTtlMin?: number; maxAttempts?: number }) {
    this.leaseTtlMin = opts?.leaseTtlMin ?? 15
    this.maxAttempts = opts?.maxAttempts ?? 3
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
      const epicIds = this.store.batchTasks(deps).values()
      for (const t of epicIds) {
        if (t && t.is_epic === 1) {
          return { ok: false, error: `INVALID: dependencies on epic tasks not allowed (${deps.find(d => this.store.getTaskRow(d)?.is_epic === 1)})` }
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
    this.store.auditAppend(id, reporter, 'create', undefined, 'queued')
    if (a.description) this.store.insertComment(id, reporter, a.description)

    // D2: auto-promote target epic and D6: mirror subtask_add
    if (epicId !== null) {
      this.store.promoteEpic(epicId, now)
      const targetTask = this.store.getTaskRow(epicId)
      if (targetTask) {
        this.store.appendEpicAuditMirror(epicId, reporter, 'subtask_add',
          `#${id} ${sanitizePipe(a.title)}`, now)
      }
    }

    return { ok: true, data: { id, status: 'queued' } }
  }

  getTaskView(id: number): SvcResult<{ task: Task; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number } }> {
    this.reapExpiredLeases()
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

  listTasks(a: { assignee?: string; status?: string; updated_since?: number; epic_id?: number; limit?: number }): { tasks: Task[]; total: number } {
    this.reapExpiredLeases()
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
    this.reapExpiredLeases()
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
      let offset = 0
      while (offset < 10000) {
        const page = this.store.queuedCandidates(BATCH, offset)
        if (page.length === 0) break
        const allDeps = new Set<number>()
        for (const row of page) {
          for (const dep of parseDeps(row.depends_on)) allDeps.add(dep)
        }
        const depStatuses = this.store.statusesOf(Array.from(allDeps))
        for (const row of page) {
          const deps = parseDeps(row.depends_on)
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
    this.store.auditAppend(task.id, a.agent, 'claim', task.status, 'in_progress')
    return { ok: true, data: { id: task.id, leaseTtlMin: this.leaseTtlMin, task: updated } }
  }

  updateStatus(a: { id: number; agent: string; status: TaskStatus; version: number; comment?: string }): SvcResult<{ id: number; status: TaskStatus; version: number }> {
    this.reapExpiredLeases()
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
    this.store.auditAppend(a.id, a.agent, 'update_status', task.status, a.status)
    if (a.comment) {
      const type: 'comment' | 'resolution' = TERMINAL_STATUSES.includes(a.status) ? 'resolution' : 'comment'
      this.store.insertComment(a.id, a.agent, a.comment, type)
    }

    // D6: mirror subtask_done/subtask_failed onto the parent epic
    if (task.epic_id !== null && TERMINAL_STATUSES.includes(a.status)) {
      const epicTask = this.store.getTaskRow(task.epic_id)
      if (epicTask) {
        this.store.appendEpicAuditMirror(task.epic_id, a.agent,
          a.status === 'done' ? 'subtask_done' : 'subtask_failed',
          `#${task.id} ${sanitizePipe(task.title)}`, now)
      }
    }

    return { ok: true, data: { id: a.id, status: a.status, version: updated.version } }
  }

  batchStatuses(ids: number[]): Array<{ id: number; task: Task | null }> {
    this.reapExpiredLeases()
    const batch = this.store.batchTasks(ids)
    return ids.map(id => ({ id, task: batch.get(id) ?? null }))
  }

  listQueue(a: { limit?: number }): Task[] {
    this.reapExpiredLeases()
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
    this.reapExpiredLeases()
    const task = this.store.getTaskRow(a.id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    if (!a.agent.trim()) return { ok: false, error: 'EMPTY: agent required' }
    if (!a.content.trim()) return { ok: false, error: 'EMPTY: content required' }
    const comment_id = this.store.insertComment(a.id, a.agent, a.content)
    return { ok: true, data: { comment_id } }
  }

  getTimeline(id: number, limit?: number): SvcResult<TimelineRow[]> {
    this.reapExpiredLeases()
    const task = this.store.getTaskRow(id)
    if (!task) return { ok: false, error: 'NOT_FOUND' }
    const limitN = limit !== undefined ? Math.floor(limit) : 50
    const rows = this.store.timelineEntries(id, limitN)
    return { ok: true, data: rows }
  }

  private addMinutes(statusTime: Record<string, number>, status: string, segStart: string, segEnd: string, since: string, now: string): void {
    const start = segStart > since ? segStart : since
    const end = segEnd < now ? segEnd : now
    if (end > start) {
      statusTime[status] = (statusTime[status] ?? 0) + (new Date(end).getTime() - new Date(start).getTime()) / 60000
    }
  }

  metrics(period?: number | 'all'): SvcResult<{ doneCount: number; statusTime: Record<string, number>;
    bottleneck: { status: string; minutes: number } | null }> {
    this.reapExpiredLeases()
    const now = nowIso()
    if (period === 0) return { ok: false, error: 'INVALID: period=0 is not valid; use a positive number of hours or "all"' }
    const periodHours = period === 'all' ? 0 : (period ?? 24)
    const since = periodHours === 0 ? '0001-01-01T00:00:00.000Z' : new Date(Date.now() - periodHours * 3600_000).toISOString()

    const done_count = this.store.doneCount(since)
    const allTasks = this.store.taskSummaries()
    // D7: exclude epics from metrics
    const tasks = allTasks.filter(t => t.is_epic === 0)
    const allTransitions = this.store.auditTransitionsForTasks()

    const transitionsByTask = new Map<number, Array<{ new_value: string; created_at: string }>>()
    for (const t of allTransitions) {
      let arr = transitionsByTask.get(t.task_id)
      if (!arr) { arr = []; transitionsByTask.set(t.task_id, arr) }
      arr.push({ new_value: t.new_value, created_at: t.created_at })
    }

    const statusTime: Record<string, number> = {}

    for (const task of tasks) {
      const transitions = transitionsByTask.get(task.id) ?? []

      let currentStatus = 'queued'
      let currentTime = task.created_at

      for (const t of transitions) {
        if (t.created_at < currentTime) continue
        this.addMinutes(statusTime, currentStatus, currentTime, t.created_at, since, now)
        currentStatus = t.new_value
        currentTime = t.created_at
      }

      const endTime = task.completed_at || now
      this.addMinutes(statusTime, currentStatus, currentTime, endTime, since, now)
    }

    let bottleneck: { status: string; minutes: number } | null = null
    for (const [status, mins] of Object.entries(statusTime)) {
      if (!bottleneck || mins > bottleneck.minutes) {
        bottleneck = { status, minutes: mins }
      }
    }

    return { ok: true, data: { doneCount: done_count, statusTime, bottleneck } }
  }

  reapExpiredLeases(): void {
    const now = nowIso()
    const expired = this.store.expiredLeases(now)
    for (const task of expired) {
      const newAttempts = task.attempts + 1
      const newStatus: TaskStatus = newAttempts > task.max_attempts ? 'failed' : 'queued'
      const changes = this.store.reapSettle(task.id, task.version, newStatus, newAttempts, now)
      if (changes === 1) this.store.auditAppend(task.id, 'system', 'lease_expired', 'in_progress', newStatus)
    }
  }
}

export function parseDeps(raw: string): number[] {
  const parsed = JSON.parse(raw) as unknown
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
