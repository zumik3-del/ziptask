import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { Task, TaskStatus, CommentType } from '../core/tasks'
import type { CommentRow, TaskStore } from '../core/types'
import { DEFAULT_MAX_ATTEMPTS, TERMINAL_STATUSES_SQL, TASK_PRIORITIES } from '../defaults'

type SqlParam = string | number | null

const PRIORITY_ORDER_SQL = `CASE priority ${TASK_PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(' ')} END`

// bun:sqlite's spread bindings need a typed array; keep the single cast here.
function bindParams(params: SqlParam[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[]
}

function clampNonNegativeInt(value: number): number {
  return Math.max(0, Math.floor(value))
}

export class TaskRepo implements TaskStore {
  private lastTimestampMs = 0

  constructor(private db: Database) {}

  private monotonicIso(): string {
    const now = Date.now()
    const t = now > this.lastTimestampMs ? now : this.lastTimestampMs + 1
    this.lastTimestampMs = t
    return new Date(t).toISOString()
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  getTaskRow(id: number): Task | null {
    return this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null
  }

  insertTask(task: {
    title: string; description: string | null; priority: string
    assignee: string | null; reporter: string; depends_on: string; now: string
    maxAttempts?: number
    epicId?: number; isEpic?: number
  }): number {
    const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const epicId = task.epicId ?? null
    const epicFlag = task.isEpic ?? 0
    const result = this.db.run(
      `INSERT INTO tasks (title, description, status, priority, assignee, reporter, depends_on, attempts, max_attempts, created_at, updated_at, epic_id, is_epic)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [task.title, task.description, task.priority, task.assignee, task.reporter, task.depends_on, maxAttempts, task.now, task.now, epicId, epicFlag]
    )
    return Number(result.lastInsertRowid)
  }

  deleteTask(id: number): void {
    // comments and audit_log carry ON DELETE CASCADE (schema v4), so the single delete
    // removes the task and every child row in one statement.
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }

  listTasks(filters: {
    assignee?: string; status?: string; updatedSinceIso?: string; epicId?: number; limit: number
  }): { rows: Task[]; total: number } {
    const conditions: string[] = []
    const params: (string | number | null)[] = []
    if (filters.assignee) { conditions.push('assignee = ?'); params.push(filters.assignee) }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status) }
    if (filters.updatedSinceIso !== undefined) {
      conditions.push('updated_at >= ?')
      params.push(filters.updatedSinceIso)
    }
    if (filters.epicId !== undefined) {
      conditions.push('epic_id = ?')
      params.push(filters.epicId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = clampNonNegativeInt(filters.limit)
    const rows = this.db.query(
      `SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`
    ).all(...bindParams(params)) as Task[]
    const total = (this.db.query(`SELECT COUNT(*) as cnt FROM tasks ${where}`).get(...bindParams(params)) as { cnt: number }).cnt
    return { rows, total }
  }

  queuedCandidates(limit: number, offset?: number): Task[] {
    const n = clampNonNegativeInt(limit)
    const o = clampNonNegativeInt(offset ?? 0)
    return this.db.query(
      `SELECT * FROM tasks WHERE status = 'queued' AND is_epic = 0
       ORDER BY ${PRIORITY_ORDER_SQL}, created_at ASC, id ASC
       LIMIT ${n} OFFSET ${o}`
    ).all() as Task[]
  }

  depsOf(id: number): string | null {
    const row = this.db.query('SELECT depends_on FROM tasks WHERE id = ?').get(id) as { depends_on: string } | null
    return row?.depends_on ?? null
  }

  statusesOf(ids: number[]): Map<number, TaskStatus> {
    if (ids.length === 0) return new Map()
    const inClause = ids.map(() => '?').join(',')
    const rows = this.db.query(`SELECT id, status FROM tasks WHERE id IN (${inClause})`).all(...bindParams(ids)) as Array<{ id: number; status: TaskStatus }>
    const map = new Map<number, TaskStatus>()
    for (const row of rows) map.set(row.id, row.status)
    return map
  }

  batchTasks(ids: number[]): Map<number, Task | null> {
    const map = new Map<number, Task | null>()
    if (ids.length === 0) return map
    const inClause = ids.map(() => '?').join(',')
    const rows = this.db.query(`SELECT * FROM tasks WHERE id IN (${inClause})`).all(...bindParams(ids)) as Task[]
    for (const row of rows) map.set(row.id, row)
    return map
  }

  markClaimed(id: number, expectedVersion: number, agent: string, leaseUntil: string, now: string): number {
    const result = this.db.run(
      "UPDATE tasks SET status = 'in_progress', assignee = ?, lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      [agent, leaseUntil, now, id, expectedVersion]
    )
    return Number(result.changes)
  }

  transitionStatus(id: number, expectedVersion: number, status: TaskStatus, now: string, completedAt: string | null, leaseUntilIso: string | null, holder: string | null = null, resetAttempts: 0 | 1 = 0): number {
    // Assemble the SET list from the target status so each column's rule is one readable
    // branch instead of a chain of `CASE WHEN ? = ...` over the same bound parameter.
    const assignments = [
      'status = ?',
      'version = version + 1',
      'updated_at = ?',
      'completed_at = COALESCE(?, completed_at)'
    ]
    const params: SqlParam[] = [status, now, completedAt]
    if (status === 'in_progress') {
      assignments.push('lease_expires_at = ?', 'assignee = ?')
      params.push(leaseUntilIso, holder)
    } else {
      assignments.push('lease_expires_at = NULL')
      if (status === 'canceled') assignments.push('assignee = NULL')
    }
    if (resetAttempts === 1) assignments.push('attempts = 0')
    params.push(id, expectedVersion)
    const result = this.db.run(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND version = ?`,
      bindParams(params)
    )
    return Number(result.changes)
  }

  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>> {
    return this.db.query(
      "SELECT id, version, attempts, max_attempts FROM tasks WHERE status = 'in_progress' AND is_epic = 0 AND lease_expires_at IS NOT NULL AND lease_expires_at < ?"
    ).all(nowIso) as Array<{ id: number; version: number; attempts: number; max_attempts: number }>
  }

  reapTransition(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number {
    const result = this.db.run(
      'UPDATE tasks SET status = ?, lease_expires_at = NULL, assignee = CASE WHEN ? = \'queued\' THEN NULL ELSE assignee END, attempts = ?, version = version + 1, updated_at = ?, completed_at = CASE WHEN ? = ? THEN ? ELSE completed_at END WHERE id = ? AND status = \'in_progress\' AND version = ?',
      [status, status, attempts, now, status, 'failed', now, id, expectedVersion]
    )
    return Number(result.changes)
  }

  insertComment(taskId: number, agent: string, content: string, type: CommentType = 'comment'): number {
    const result = this.db.run(
      'INSERT INTO comments (task_id, agent, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
      [taskId, agent, content, type, this.monotonicIso()]
    )
    return Number(result.lastInsertRowid)
  }

  auditAppend(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void {
    this.db.run(
      'INSERT INTO audit_log (task_id, agent, action, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [taskId, agent, action, oldValue ?? null, newValue ?? null, this.monotonicIso()]
    )
  }

  timelineEntries(taskId: number, limit: number): Array<{ type: string; agent: string; text: string; created_at: string }> {
    const n = clampNonNegativeInt(limit)
    const sql = `SELECT 'action' as type, agent, action || ': ' || COALESCE(old_value, 'null') || '->' || COALESCE(new_value, 'null') as text, created_at, rowid
      FROM audit_log WHERE task_id = ?
      UNION ALL
      SELECT 'comment', agent, content, created_at, rowid
      FROM comments WHERE task_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ${n}`
    return this.db.query(sql).all(taskId, taskId) as Array<{ type: string; agent: string; text: string; created_at: string }>
  }

  commentsOf(taskId: number): CommentRow[] {
    return this.db.query(
      'SELECT id, agent, content, type, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC, id ASC'
    ).all(taskId) as CommentRow[]
  }

  nonTerminalChildCount(epicId: number): number {
    const row = this.db.query(
      `SELECT COUNT(*) as cnt FROM tasks WHERE epic_id = ? AND status NOT IN ${TERMINAL_STATUSES_SQL}`
    ).get(epicId) as { cnt: number }
    return row.cnt
  }

  childStatusCounts(epicId: number): { total: number; open: number; done: number; failed: number; canceled: number } {
    const rows = this.db.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status NOT IN ${TERMINAL_STATUSES_SQL} THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) as canceled
       FROM tasks WHERE epic_id = ?`
    ).get(epicId) as { total: number; open: number; done: number; failed: number; canceled: number } | null
    return rows ?? { total: 0, open: 0, done: 0, failed: 0, canceled: 0 }
  }

  promoteEpicWithMirror(id: number, agent: string, action: string, newValue: string, now: string, auditLog: boolean): void {
    const txn = this.db.transaction(() => {
      this.db.run("UPDATE tasks SET is_epic = 1, updated_at = ? WHERE id = ? AND is_epic = 0", [now, id])
      if (auditLog) {
        this.auditAppend(id, agent, action, undefined, newValue)
      }
    })
    txn()
  }

  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string): void {
    this.auditAppend(taskId, agent, action, undefined, newValue)
  }
}
