import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { Task, TaskStatus, TaskPriority, CommentType, Clock } from '../core/tasks'
import { asClock, clampLimit, nowIso, TERMINAL_STATUSES } from '../core/tasks'
import type { AuditStore, CommentRow, CommentStore, LeaseStore, ProjectListItem, ProjectRow, ProjectStore, TaskStore } from '../core/types'
import { DEFAULT_MAX_ATTEMPTS } from '../defaults'
import { PRIORITY_ORDER_SQL, TASK_SELECT, TERMINAL_STATUSES_SQL } from './sql'

type SqlParam = string | number | null

// bun:sqlite's spread bindings need a typed array; keep the single cast here.
function bindParams(params: SqlParam[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[]
}

type TaskRow = Omit<Task, 'is_epic'> & { is_epic: number; project_id: number | null }

// SQL keeps is_epic as 0/1; the domain type carries it as a boolean.
function toTask(row: TaskRow): Task {
  const { project_id: _internal, ...rest } = row
  return { ...rest, project: rest.project ?? null, is_epic: rest.is_epic !== 0 }
}

export class TaskRepo implements TaskStore, ProjectStore, CommentStore, AuditStore, LeaseStore {
  private readonly db: Database
  private readonly clock: Clock | null

  constructor(db: Database, clock?: unknown) {
    this.db = db
    this.clock = asClock(clock)
  }

  private monotonicIso(): string {
    if (this.clock) return this.clock.nowIso()
    return nowIso()
  }

  private inClause(count: number): string {
    return `IN (${Array.from({ length: count }, () => '?').join(',')})`
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  getTaskRow(id: number): Task | null {
    const row = this.db.query(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | null
    return row ? toTask(row) : null
  }

  insertTask(task: {
    title: string; description: string | null; priority: TaskPriority
    assignee: string | null; reporter: string; depends_on: string; now: string
    maxAttempts?: number
    epicId?: number; isEpic?: boolean; projectId?: number | null
  }): number {
    const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const epicId = task.epicId ?? null
    const isEpic = task.isEpic === true
    const epicFlag = isEpic ? 1 : 0
    const projectId = task.projectId ?? null
    // ADR 0002: an epic is born `open` and holds no lease, so it never carries an assignee.
    const status = isEpic ? 'open' : 'queued'
    const assignee = isEpic ? null : task.assignee
    const result = this.db.run(
      `INSERT INTO tasks (title, description, status, priority, assignee, reporter, depends_on, attempts, max_attempts, created_at, updated_at, epic_id, is_epic, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [task.title, task.description, status, task.priority, assignee, task.reporter, task.depends_on, maxAttempts, task.now, task.now, epicId, epicFlag, projectId]
    )
    return Number(result.lastInsertRowid)
  }

  deleteTask(id: number): void {
    // comments and audit_log carry ON DELETE CASCADE (schema v4), so the single delete
    // removes the task and every child row in one statement.
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }

  listTasks(filters: {
    assignee?: string; status?: TaskStatus; updatedSinceIso?: string; epicId?: number; limit: number; projectId?: number
  }): { rows: Task[]; total: number } {
    const conditions: string[] = []
    const params: (string | number | null)[] = []
    if (filters.projectId !== undefined) { conditions.push('t.project_id = ?'); params.push(filters.projectId) }
    if (filters.assignee) { conditions.push('t.assignee = ?'); params.push(filters.assignee) }
    if (filters.status) { conditions.push('t.status = ?'); params.push(filters.status) }
    if (filters.updatedSinceIso !== undefined) {
      conditions.push('t.updated_at >= ?')
      params.push(filters.updatedSinceIso)
    }
    if (filters.epicId !== undefined) {
      conditions.push('t.epic_id = ?')
      params.push(filters.epicId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = clampLimit(filters.limit, 0)
    // One pass: the window function carries the filtered total on every row, so no
    // second COUNT query is needed. When the filter yields no rows the window has
    // nothing to attach to, so total defaults to 0 (which is the correct total).
    type RowWithTotal = TaskRow & { __total: number }
    const rows = this.db.query(
      `SELECT *, COUNT(*) OVER() AS __total FROM (${TASK_SELECT} ${where}) ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...bindParams([...params, limit])) as RowWithTotal[]
    const total = rows.length > 0 ? rows[0].__total : 0
    return { rows: rows.map(({ __total: _ignored, ...rest }) => toTask(rest as TaskRow)), total }
  }

  queuedCandidates(limit: number, projectId: number, offset?: number): Task[] {
    const n = clampLimit(limit, 0)
    const o = clampLimit(offset ?? 0, 0)
    const rows = this.db.query(
      `SELECT t.*, p.slug AS project FROM tasks t INDEXED BY idx_tasks_queued_candidates LEFT JOIN projects p ON p.id = t.project_id WHERE t.status = 'queued' AND t.is_epic = 0 AND t.project_id = ?
       ORDER BY ${PRIORITY_ORDER_SQL}, t.created_at ASC, t.id ASC
       LIMIT ? OFFSET ?`
    ).all(projectId, n, o) as TaskRow[]
    return rows.map(toTask)
  }

  depsOf(id: number): string | null {
    const row = this.db.query('SELECT depends_on FROM tasks WHERE id = ?').get(id) as { depends_on: string } | null
    return row?.depends_on ?? null
  }

  statusesOf(ids: number[]): Map<number, TaskStatus> {
    if (ids.length === 0) return new Map()
    const rows = this.db.query(`SELECT id, status FROM tasks WHERE id ${this.inClause(ids.length)}`).all(...bindParams(ids)) as Array<{ id: number; status: TaskStatus }>
    const map = new Map<number, TaskStatus>()
    for (const row of rows) map.set(row.id, row.status)
    return map
  }

  batchTasks(ids: number[]): Map<number, Task | null> {
    const map = new Map<number, Task | null>()
    if (ids.length === 0) return map
    // Chunk to stay under SQLite's bound-variable limit (portable builds cap at 999).
    const chunkSize = 500
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize)
      const rows = this.db.query(`${TASK_SELECT} WHERE t.id ${this.inClause(chunk.length)}`).all(...bindParams(chunk)) as TaskRow[]
      for (const row of rows) map.set(row.id, toTask(row))
    }
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
      // Terminal transitions drop ownership metadata so no stale assignee survives.
      if (TERMINAL_STATUSES.includes(status)) assignments.push('assignee = NULL')
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
      "SELECT id, version, attempts, max_attempts FROM tasks INDEXED BY idx_tasks_lease_expires_at WHERE status = 'in_progress' AND is_epic = 0 AND lease_expires_at IS NOT NULL AND lease_expires_at < ?"
    ).all(nowIso) as Array<{ id: number; version: number; attempts: number; max_attempts: number }>
  }

  reapTransition(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number {
    // The reap policy is derived from the target status here, so both write paths cannot drift
    // and no caller can pass a policy that contradicts the status it asks for.
    const completedAt = TERMINAL_STATUSES.includes(status) ? now : null
    const assignments = [
      'status = ?',
      'lease_expires_at = NULL',
      'attempts = ?',
      'version = version + 1',
      'updated_at = ?',
      'completed_at = COALESCE(?, completed_at)'
    ]
    const params: SqlParam[] = [status, attempts, now, completedAt]
    // Terminal transitions (and re-queue) drop ownership metadata so no stale assignee survives.
    if (status === 'queued' || TERMINAL_STATUSES.includes(status)) assignments.push('assignee = NULL')
    params.push(id, expectedVersion)
    const result = this.db.run(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND status = 'in_progress' AND version = ?`,
      bindParams(params)
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
    const n = clampLimit(limit, 0)
    const sql = `SELECT 'action' as type, agent, action || ': ' || COALESCE(old_value, 'null') || '->' || COALESCE(new_value, 'null') as text, created_at, rowid
      FROM audit_log WHERE task_id = ?
      UNION ALL
      SELECT 'comment', agent, content, created_at, rowid
      FROM comments WHERE task_id = ?
      ORDER BY created_at ASC, type ASC, rowid ASC
      LIMIT ?`
    return this.db.query(sql).all(taskId, taskId, n) as Array<{ type: string; agent: string; text: string; created_at: string }>
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
    // The WHERE confines promotion to a `queued` non-epic: that is the one state with no holder and no
    // work to destroy, so the rewrite cannot silently cancel in-flight work. Any other target matches
    // no row, leaving is_epic, status, assignee, lease_expires_at and version untouched. createTaskGuard
    // refuses every other non-terminal status up front; this is the defence behind it.
    this.db.run(
      "UPDATE tasks SET is_epic = 1, status = 'open', lease_expires_at = NULL, assignee = NULL, updated_at = ? WHERE id = ? AND is_epic = 0 AND status = 'queued'",
      [now, id]
    )
    if (auditLog) {
      this.auditAppend(id, agent, action, undefined, newValue)
    }
  }

  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string): void {
    this.auditAppend(taskId, agent, action, undefined, newValue)
  }

  insertProject(project: { slug: string; folderPath: string; now: string }): number {
    const result = this.db.run(
      'INSERT INTO projects (slug, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [project.slug, project.folderPath, project.now, project.now]
    )
    return Number(result.lastInsertRowid)
  }

  projectBySlug(slug: string): ProjectRow | null {
    return this.db.query('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | null
  }

  projectSlugs(): string[] {
    const rows = this.db.query('SELECT slug FROM projects ORDER BY slug ASC').all() as Array<{ slug: string }>
    return rows.map(row => row.slug)
  }

  listProjects(): ProjectListItem[] {
    return this.db.query(
      `SELECT p.slug AS slug, p.folder_path AS folder_path,
         COUNT(CASE WHEN t.status NOT IN ${TERMINAL_STATUSES_SQL} THEN 1 END) AS open
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       GROUP BY p.id
       ORDER BY p.slug ASC`
    ).all() as ProjectListItem[]
  }

  updateProject(id: number, patch: { slug?: string; folderPath?: string; archived?: boolean }, now: string): number {
    const assignments = ['updated_at = ?']
    const params: SqlParam[] = [now]
    if (patch.slug !== undefined) { assignments.push('slug = ?'); params.push(patch.slug) }
    if (patch.folderPath !== undefined) { assignments.push('folder_path = ?'); params.push(patch.folderPath) }
    if (patch.archived !== undefined) { assignments.push('archived_at = ?'); params.push(patch.archived ? now : null) }
    params.push(id)
    const result = this.db.run(`UPDATE projects SET ${assignments.join(', ')} WHERE id = ?`, bindParams(params))
    return Number(result.changes)
  }

  deleteProject(id: number): number {
    const result = this.db.run('DELETE FROM projects WHERE id = ?', [id])
    return Number(result.changes)
  }

  projectTaskCount(id: number): number {
    const row = this.db.query('SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?').get(id) as { cnt: number }
    return row.cnt
  }
}
