import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { Task, TaskStatus, CreatedTaskStatus, CommentType, Clock } from '../core/tasks'
import {
  asClock,
  clampCursor,
  clampLimit,
  clockNowIso,
  STATUS,
  TERMINAL_STATUSES
} from '../core/tasks'
import type {
  AuditStore,
  ChildStatusCounts,
  CommentRow,
  CommentStore,
  InsertTaskInput,
  LeaseStore,
  ListTasksFilters,
  ProjectListItem,
  ProjectRow,
  ProjectStore,
  SvcResult,
  TaskStore,
  UpdateTaskPatch
} from '../core/types'
import { DEFAULT_MAX_ATTEMPTS } from '../defaults'
import {
  PRIORITY_ORDER_SQL,
  TASK_SELECT,
  TERMINAL_STATUSES_SQL,
  EDITABLE_STATUSES_SQL,
  CLAIMABLE_STATUSES_SQL
} from './sql'

const BATCH_CHUNK_SIZE = 500

type SqlParam = string | number | null

function bindParams(params: SqlParam[]): SQLQueryBindings[] {
  return params as SQLQueryBindings[]
}

type TaskRow = Omit<Task, 'is_epic'> & { is_epic: number; project_id: number | null }

// A body that returns `ok:false` must not commit, so it is thrown out of the bun:sqlite transaction
// (which rolls back) and turned back into the SvcResult the caller asked for. Module-private: no
// caller can throw it deliberately.
class Rollback<T> {
  constructor(readonly result: SvcResult<T>) {}
}

function toTask(row: TaskRow): Task {
  const { project_id: _internal, ...rest } = row
  return { ...rest, project: rest.project, is_epic: rest.is_epic !== 0 }
}

export class TaskRepo implements TaskStore, ProjectStore, CommentStore, AuditStore, LeaseStore {
  private readonly db: Database
  private readonly clock: Clock | null

  constructor(db: Database, clock?: unknown) {
    this.db = db
    this.clock = asClock(clock)
  }

  private inClause(count: number): string {
    return `IN (${Array.from({ length: count }, () => '?').join(',')})`
  }

  transaction<T>(fn: () => SvcResult<T>): SvcResult<T> {
    // An IMMEDIATE transaction takes the write lock up front, so a read-then-write body (the cycle
    // check in update_task is one) waits for a concurrent writer instead of failing with
    // SQLiteError: database is locked (a snapshot that went stale between the read and the write).
    try {
      return this.db
        .transaction((): SvcResult<T> => {
          const outcome = fn()
          if (!outcome.ok) throw new Rollback(outcome)
          return outcome
        })
        .immediate()
    } catch (error) {
      if (error instanceof Rollback) return error.result as SvcResult<T>
      throw error
    }
  }

  getTaskRow(id: number): Task | null {
    const row = this.db.query(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | null
    return row ? toTask(row) : null
  }

  insertTask(task: InsertTaskInput): { id: number; status: CreatedTaskStatus } {
    const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const epicId = task.epicId ?? null
    const isEpic = task.isEpic === true
    const epicFlag = isEpic ? 1 : 0
    const projectId = task.projectId ?? null
    // ADR 0002: an epic is born `open` and holds no lease, so it never carries an assignee.
    const status = isEpic ? STATUS.open : STATUS.queued
    const result = this.db.run(
      `INSERT INTO tasks (title, description, status, priority, assignee, reporter, depends_on, attempts, max_attempts, created_at, updated_at, epic_id, is_epic, project_id)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [
        task.title,
        task.description,
        status,
        task.priority,
        task.reporter,
        task.depends_on,
        maxAttempts,
        task.now,
        task.now,
        epicId,
        epicFlag,
        projectId
      ]
    )
    return { id: Number(result.lastInsertRowid), status }
  }

  deleteTask(id: number): void {
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
  }

  listTasks(filters: ListTasksFilters): { rows: Task[]; total: number } {
    const conditions: string[] = []
    const params: (string | number | null)[] = []
    if (filters.projectId !== undefined) {
      conditions.push('t.project_id = ?')
      params.push(filters.projectId)
    }
    if (filters.assignee) {
      conditions.push('t.assignee = ?')
      params.push(filters.assignee)
    }
    if (filters.status) {
      conditions.push('t.status = ?')
      params.push(filters.status)
    }
    if (filters.updatedSinceIso !== undefined) {
      conditions.push('t.updated_at >= ?')
      params.push(filters.updatedSinceIso)
    }
    if (filters.epicId !== undefined) {
      conditions.push('t.epic_id = ?')
      params.push(filters.epicId)
    }
    if (filters.isEpic !== undefined) {
      conditions.push('t.is_epic = ?')
      params.push(filters.isEpic ? 1 : 0)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = clampLimit(filters.limit, 0)
    type RowWithTotal = TaskRow & { __total: number }
    const rows = this.db
      .query(
        `SELECT *, COUNT(*) OVER() AS __total FROM (${TASK_SELECT} ${where}) ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(...bindParams([...params, limit])) as RowWithTotal[]
    const total = rows.length > 0 ? rows[0].__total : 0
    return { rows: rows.map(({ __total: _ignored, ...rest }) => toTask(rest as TaskRow)), total }
  }

  queuedCandidates(limit: number, projectId: number, offset?: number): Task[] {
    const n = clampLimit(limit, 0)
    const o = clampCursor(offset ?? 0, 0)
    // INDEXED BY only matches when the partial index's predicate is in the statement text: a bind
    // parameter there fails with "no query solution", so the status is interpolated from STATUS at
    // build time - and changing that constant means changing the migration's predicate too.
    const rows = this.db
      .query(
        `SELECT t.*, p.slug AS project FROM tasks t INDEXED BY idx_tasks_queued_candidates LEFT JOIN projects p ON p.id = t.project_id WHERE t.status = '${STATUS.queued}' AND t.is_epic = 0 AND t.project_id = ?
       ORDER BY ${PRIORITY_ORDER_SQL}, t.created_at ASC, t.id ASC
       LIMIT ? OFFSET ?`
      )
      .all(projectId, n, o) as TaskRow[]
    return rows.map(toTask)
  }

  depsOf(id: number): string | null {
    const row = this.db.query('SELECT depends_on FROM tasks WHERE id = ?').get(id) as {
      depends_on: string
    } | null
    return row?.depends_on ?? null
  }

  statusesOf(ids: number[]): Map<number, TaskStatus> {
    if (ids.length === 0) return new Map()
    const rows = this.db
      .query(`SELECT id, status FROM tasks WHERE id ${this.inClause(ids.length)}`)
      .all(...bindParams(ids)) as Array<{ id: number; status: TaskStatus }>
    const map = new Map<number, TaskStatus>()
    for (const row of rows) map.set(row.id, row.status)
    return map
  }

  batchTasks(ids: number[]): Map<number, Task | null> {
    const map = new Map<number, Task | null>()
    if (ids.length === 0) return map
    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE)
      const rows = this.db
        .query(`${TASK_SELECT} WHERE t.id ${this.inClause(chunk.length)}`)
        .all(...bindParams(chunk)) as TaskRow[]
      for (const row of rows) map.set(row.id, toTask(row))
    }
    return map
  }

  // Every status write bumps `version`, so the CAS below already fences a stale claim. The status
  // predicate states the invariant it backstops: a lease is taken only from a row that is claimable
  // (`queued`/`blocked`), never over a row that is already under way or sent to `review`.
  markClaimed(
    id: number,
    expectedVersion: number,
    agent: string,
    leaseUntil: string,
    now: string
  ): number {
    const result = this.db.run(
      `UPDATE tasks SET status = '${STATUS.in_progress}', assignee = ?, lease_expires_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status IN ${CLAIMABLE_STATUSES_SQL}`,
      [agent, leaseUntil, now, id, expectedVersion]
    )
    return Number(result.changes)
  }

  transitionStatus(
    id: number,
    expectedVersion: number,
    status: TaskStatus,
    now: string,
    completedAt: string | null,
    leaseUntilIso: string | null,
    holder: string | null = null,
    resetAttempts: 0 | 1 = 0
  ): number {
    const assignments = [
      'status = ?',
      'version = version + 1',
      'updated_at = ?',
      'completed_at = COALESCE(?, completed_at)'
    ]
    const params: SqlParam[] = [status, now, completedAt]
    if (status === STATUS.in_progress) {
      assignments.push('lease_expires_at = ?', 'assignee = ?')
      params.push(leaseUntilIso, holder)
    } else {
      assignments.push('lease_expires_at = NULL', 'assignee = NULL')
    }
    if (resetAttempts === 1) assignments.push('attempts = 0')
    params.push(id, expectedVersion)
    const result = this.db.run(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND version = ?`,
      bindParams(params)
    )
    return Number(result.changes)
  }

  updateTaskFields(
    id: number,
    expectedVersion: number,
    patch: UpdateTaskPatch,
    now: string
  ): number {
    const hasField =
      patch.title !== undefined ||
      patch.description !== undefined ||
      patch.priority !== undefined ||
      patch.dependsOn !== undefined
    if (!hasField) return 0
    const assignments: string[] = []
    const params: SqlParam[] = []
    if (patch.title !== undefined) {
      assignments.push('title = ?')
      params.push(patch.title)
    }
    if (patch.description !== undefined) {
      assignments.push('description = ?')
      params.push(patch.description)
    }
    if (patch.priority !== undefined) {
      assignments.push('priority = ?')
      params.push(patch.priority)
    }
    if (patch.dependsOn !== undefined) {
      assignments.push('depends_on = ?')
      params.push(patch.dependsOn)
    }
    assignments.push('version = version + 1', 'updated_at = ?')
    params.push(now)
    params.push(id, expectedVersion)
    const result = this.db.run(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND version = ? AND status IN ${EDITABLE_STATUSES_SQL} AND assignee IS NULL AND lease_expires_at IS NULL`,
      bindParams(params)
    )
    return Number(result.changes)
  }

  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>> {
    // INDEXED BY only matches when the partial index's predicate is in the statement text: a bind
    // parameter there fails with "no query solution", so the status is interpolated from STATUS at
    // build time - and changing that constant means changing the migration's predicate too.
    return this.db
      .query(
        `SELECT id, version, attempts, max_attempts FROM tasks INDEXED BY idx_tasks_lease_expires_at WHERE status = '${STATUS.in_progress}' AND is_epic = 0 AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`
      )
      .all(nowIso) as Array<{ id: number; version: number; attempts: number; max_attempts: number }>
  }

  reapTransition(
    id: number,
    expectedVersion: number,
    status: 'queued' | 'failed',
    attempts: number,
    now: string
  ): number {
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
    assignments.push('assignee = NULL')
    params.push(id, expectedVersion)
    const result = this.db.run(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND status = '${STATUS.in_progress}' AND version = ?`,
      bindParams(params)
    )
    return Number(result.changes)
  }

  insertComment(
    taskId: number,
    agent: string,
    content: string,
    type: CommentType = 'comment'
  ): number {
    const result = this.db.run(
      'INSERT INTO comments (task_id, agent, content, type, created_at) VALUES (?, ?, ?, ?, ?)',
      [taskId, agent, content, type, clockNowIso(this.clock)]
    )
    return Number(result.lastInsertRowid)
  }

  auditAppend(
    taskId: number,
    agent: string,
    action: string,
    oldValue?: string,
    newValue?: string
  ): void {
    this.db.run(
      'INSERT INTO audit_log (task_id, agent, action, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [taskId, agent, action, oldValue ?? null, newValue ?? null, clockNowIso(this.clock)]
    )
  }

  timelineEntries(
    taskId: number,
    limit: number
  ): Array<{ type: string; agent: string; text: string; created_at: string }> {
    const n = clampLimit(limit, 0)
    const sql = `SELECT type, agent, text, created_at FROM (
      SELECT 'action' as type, agent, action || ': ' || COALESCE(old_value, 'null') || '->' || COALESCE(new_value, 'null') as text, created_at, rowid AS rid
      FROM audit_log WHERE task_id = ?
      UNION ALL
      SELECT 'comment', agent, content, created_at, rowid AS rid
      FROM comments WHERE task_id = ?
      ORDER BY created_at DESC, type DESC, rid DESC
      LIMIT ?
    ) ORDER BY created_at ASC, type ASC, rid ASC`
    return this.db.query(sql).all(taskId, taskId, n) as Array<{
      type: string
      agent: string
      text: string
      created_at: string
    }>
  }

  commentsOf(taskId: number): CommentRow[] {
    return this.db
      .query(
        'SELECT id, agent, content, type, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC, id ASC'
      )
      .all(taskId) as CommentRow[]
  }

  nonTerminalChildCount(epicId: number): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) as cnt FROM tasks WHERE epic_id = ? AND status NOT IN ${TERMINAL_STATUSES_SQL}`
      )
      .get(epicId) as { cnt: number }
    return row.cnt
  }

  childStatusCounts(epicId: number): ChildStatusCounts {
    const row = this.db
      .query(
        `SELECT
         COUNT(*) as total,
         COALESCE(SUM(CASE WHEN status NOT IN ${TERMINAL_STATUSES_SQL} THEN 1 ELSE 0 END), 0) as open,
         COALESCE(SUM(CASE WHEN status = '${STATUS.done}' THEN 1 ELSE 0 END), 0) as done,
         COALESCE(SUM(CASE WHEN status = '${STATUS.failed}' THEN 1 ELSE 0 END), 0) as failed,
         COALESCE(SUM(CASE WHEN status = '${STATUS.canceled}' THEN 1 ELSE 0 END), 0) as canceled
       FROM tasks WHERE epic_id = ?`
      )
      .get(epicId) as ChildStatusCounts
    return row
  }

  promoteEpic(id: number, now: string): number {
    const result = this.db.run(
      `UPDATE tasks SET is_epic = 1, status = '${STATUS.open}', lease_expires_at = NULL, assignee = NULL, version = version + 1, updated_at = ? WHERE id = ? AND is_epic = 0 AND status = '${STATUS.queued}'`,
      [now, id]
    )
    return Number(result.changes)
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
    const rows = this.db.query('SELECT slug FROM projects ORDER BY slug ASC').all() as Array<{
      slug: string
    }>
    return rows.map((row) => row.slug)
  }

  listProjects(): ProjectListItem[] {
    return this.db
      .query(
        `SELECT p.slug AS slug, p.folder_path AS folder_path,
         COUNT(CASE WHEN t.status NOT IN ${TERMINAL_STATUSES_SQL} THEN 1 END) AS open
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       GROUP BY p.id
       ORDER BY p.slug ASC`
      )
      .all() as ProjectListItem[]
  }

  updateProject(
    id: number,
    patch: { folderPath?: string; archived?: boolean },
    now: string
  ): number {
    const assignments = ['updated_at = ?']
    const params: SqlParam[] = [now]
    if (patch.folderPath !== undefined) {
      assignments.push('folder_path = ?')
      params.push(patch.folderPath)
    }
    if (patch.archived !== undefined) {
      assignments.push('archived_at = ?')
      params.push(patch.archived ? now : null)
    }
    params.push(id)
    const result = this.db.run(
      `UPDATE projects SET ${assignments.join(', ')} WHERE id = ?`,
      bindParams(params)
    )
    return Number(result.changes)
  }

  deleteProject(id: number): number {
    const result = this.db.run('DELETE FROM projects WHERE id = ?', [id])
    return Number(result.changes)
  }

  projectTaskCount(id: number): number {
    const row = this.db.query('SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?').get(id) as {
      cnt: number
    }
    return row.cnt
  }
}
