import type { Task, TaskStatus, TaskPriority, CommentType } from './tasks'

// Lease reaping needs only the sweep, its CAS transition and (via AuditStore) the audit row.
export interface LeaseStore {
  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>>
  reapTransition(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number
}

// Task-scoped storage: task CRUD, deps, leases, epic roll-up. No project/comment/audit methods.
export interface TaskStore {
  getTaskRow(id: number): Task | null
  insertTask(task: { title: string; description: string | null; priority: TaskPriority;
    assignee: string | null; reporter: string; depends_on: string; now: string; maxAttempts?: number
    epicId?: number; isEpic?: boolean; projectId?: number | null }): number
  deleteTask(id: number): void
  listTasks(filters: { assignee?: string; status?: TaskStatus; updatedSinceIso?: string; epicId?: number; limit: number; projectId?: number })
    : { rows: Task[]; total: number }
  queuedCandidates(limit: number, projectId: number, offset?: number): Task[]
  depsOf(id: number): string | null
  statusesOf(ids: number[]): Map<number, TaskStatus>
  batchTasks(ids: number[]): Map<number, Task | null>
  markClaimed(id: number, expectedVersion: number, agent: string, leaseUntil: string, now: string): number
  transitionStatus(id: number, expectedVersion: number, status: TaskStatus,
    now: string, completedAt: string | null, leaseUntilIso: string | null,
    holder?: string | null, resetAttempts?: 0 | 1): number
  transaction<T>(fn: () => T): T
  nonTerminalChildCount(epicId: number): number
  childStatusCounts(epicId: number): { total: number; open: number; done: number; failed: number; canceled: number }
  promoteEpicWithMirror(id: number, agent: string, action: string, newValue: string, now: string, auditLog: boolean): void
  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string): void
}

// Project administration storage.
export interface ProjectStore {
  insertProject(project: { slug: string; folderPath: string; now: string }): number
  projectBySlug(slug: string): ProjectRow | null
  projectSlugs(): string[]
  listProjects(): ProjectListItem[]
  updateProject(id: number, patch: { slug?: string; folderPath?: string; archived?: boolean }, now: string): number
  deleteProject(id: number): number
  projectTaskCount(id: number): number
}

// Comment storage.
export interface CommentStore {
  insertComment(taskId: number, agent: string, content: string, type?: 'comment' | 'resolution'): number
  commentsOf(taskId: number): CommentRow[]
}

// Audit storage.
export interface AuditStore {
  auditAppend(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void
  timelineEntries(taskId: number, limit: number): TimelineRow[]
}

// Aggregate store implemented by TaskRepo; use this when a component needs every slice.
export interface Store extends TaskStore, ProjectStore, CommentStore, AuditStore, LeaseStore {}

// The internal id never crosses the tool boundary; `slug` is the identity every call speaks.
export type ProjectRow = {
  id: number; slug: string; folder_path: string; created_at: string; updated_at: string; archived_at: string | null
}

export type ProjectListItem = { slug: string; folder_path: string; open: number }

export type TimelineRow = { type: string; agent: string; text: string; created_at: string }

export type CommentRow = { id: number; agent: string; content: string; type: CommentType; created_at: string }

export type ErrorCode = 'INVALID' | 'CONFLICT' | 'NOT_FOUND' | 'BLOCKED' | 'CHILDREN' | 'EMPTY' | 'CYCLE'

export type SvcError = { code: ErrorCode; message: string }

export type SvcResult<T> = { ok: true; data: T } | { ok: false; error: SvcError }

// attempts is present only when update_status was called with reset_attempts
export type UpdateStatusData = { id: number; status: TaskStatus; version: number; attempts?: number }