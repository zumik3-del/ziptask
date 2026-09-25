import type { Database } from 'bun:sqlite'
import type { Task, TaskStatus, CommentType } from '../core/tasks'
import type { CommentRow } from '../core/types'
import { DEFAULT_MAX_ATTEMPTS } from '../defaults'

export class TaskRepo {
  private lastTsMs = 0

  constructor(private db: Database) {}

  private monotonicIso(): string {
    const now = Date.now()
    const t = now > this.lastTsMs ? now : this.lastTsMs + 1
    this.lastTsMs = t
    return new Date(t).toISOString()
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  getTaskRow(id: number): Task | null {
    return this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null
  }

  insertTask(t: {
    title: string; description: string | null; priority: string
    assignee: string | null; reporter: string; depends_on: string; now: string
    maxAttempts?: number
    epicId?: number; isEpic?: number
  }): number {
    const maxAttempts = t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const epicId = t.epicId ?? null
    const isEpic = t.isEpic ?? 0
    const result = this.db.run(
      `INSERT INTO tasks (title, description, status, priority, assignee, reporter, depends_on, attempts, max_attempts, created_at, updated_at, epic_id, is_epic)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [t.title, t.description, t.priority, t.assignee, t.reporter, t.depends_on, maxAttempts, t.now, t.now, epicId, isEpic]
    )
    return Number(result.lastInsertRowid)
  }

  deleteTask(id: number): void {
    this.db.run('DELETE FROM comments WHERE task_id = ?', [id])
    this.db.run('DELETE FROM audit_log WHERE task_id = ?', [id])
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }

  listTasks(f: {
    assignee?: string; status?: string; updatedSinceIso?: string; epicId?: number; limit: number
  }): { rows: Task[]; total: number } {
    const conditions: string[] = []
    const params: (string | number | null)[] = []
    if (f.assignee) { conditions.push('assignee = ?'); params.push(f.assignee) }
    if (f.status) { conditions.push('status = ?'); params.push(f.status) }
    if (f.updatedSinceIso !== undefined) {
      conditions.push('updated_at >= ?')
      params.push(f.updatedSinceIso)
    }
    if (f.epicId !== undefined) {
      conditions.push('epic_id = ?')
      params.push(f.epicId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.max(0, Math.floor(f.limit))
    const rows = this.db.query(
      `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(...params as any[]) as Task[]
    const total = (this.db.query(`SELECT COUNT(*) as cnt FROM tasks ${where}`).get(...params as any[]) as { cnt: number }).cnt
    return { rows, total }
  }

  queuedCandidates(limit: number, offset?: number): Task[] {
    const n = Math.max(0, Math.floor(limit))
    const o = Math.max(0, Math.floor(offset ?? 0))
    return this.db.query(
      `SELECT * FROM tasks WHERE status = 'queued' AND is_epic = 0
       ORDER BY CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 END, created_at ASC, id ASC
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
    const rows = this.db.query(`SELECT id, status FROM tasks WHERE id IN (${inClause})`).all(...ids as any[]) as Array<{ id: number; status: TaskStatus }>
    const map = new Map<number, TaskStatus>()
    for (const row of rows) map.set(row.id, row.status)
    return map
  }

  batchTasks(ids: number[]): Map<number, Task | null> {
    const map = new Map<number, Task | null>()
    if (ids.length === 0) return map
    const inClause = ids.map(() => '?').join(',')
    const rows = this.db.query(`SELECT * FROM tasks WHERE id IN (${inClause})`).all(...ids as any[]) as Task[]
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

  transitionStatus(id: number, expectedVersion: number, status: TaskStatus, now: string, completedAt: string | null, leaseUntilIso: string | null): number {
    const result = this.db.run(
      `UPDATE tasks SET status = ?, version = version + 1, updated_at = ?,
         completed_at = COALESCE(?, completed_at),
         lease_expires_at = CASE WHEN ? = 'in_progress' THEN ? ELSE NULL END,
         assignee = CASE WHEN ? = 'canceled' THEN NULL ELSE assignee END
       WHERE id = ? AND version = ?`,
      [status, now, completedAt, status, leaseUntilIso, status, id, expectedVersion]
    )
    return Number(result.changes)
  }

  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>> {
    return this.db.query(
      "SELECT id, version, attempts, max_attempts FROM tasks WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?"
    ).all(nowIso) as Array<{ id: number; version: number; attempts: number; max_attempts: number }>
  }

  reapSettle(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number {
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

  private _auditInsert(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void {
    this.db.run(
      'INSERT INTO audit_log (task_id, agent, action, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [taskId, agent, action, oldValue ?? null, newValue ?? null, this.monotonicIso()]
    )
  }

  auditAppend(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void {
    this._auditInsert(taskId, agent, action, oldValue, newValue)
  }

  timelineEntries(taskId: number, limit: number): Array<{ type: string; agent: string; text: string; created_at: string }> {
    const n = Math.max(0, Math.floor(limit))
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
      "SELECT COUNT(*) as cnt FROM tasks WHERE epic_id = ? AND status NOT IN ('done', 'failed', 'canceled')"
    ).get(epicId) as { cnt: number }
    return row.cnt
  }

  childStatusCounts(epicId: number): { total: number; open: number; done: number; failed: number; canceled: number } {
    const rows = this.db.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status NOT IN ('done', 'failed', 'canceled') THEN 1 ELSE 0 END) as open,
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
        this._auditInsert(id, agent, action, undefined, newValue)
      }
    })
    txn()
  }

  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string): void {
    this._auditInsert(taskId, agent, action, undefined, newValue)
  }
}
