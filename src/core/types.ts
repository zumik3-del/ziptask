import type { Task, TaskStatus, CommentType } from './tasks'

// The lease reaper (core/reaper.ts) needs only a narrow slice of the store — the sweep, its CAS
// transition and the audit row it writes — so it cannot reach the rest of the store.
export interface LeaseStore {
  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>>
  reapTransition(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number
  auditAppend(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void
}

export interface TaskStore extends LeaseStore {
  getTaskRow(id: number): Task | null
  insertTask(task: { title: string; description: string | null; priority: string;
    assignee: string | null; reporter: string; depends_on: string; now: string; maxAttempts?: number
    epicId?: number; isEpic?: boolean }): number
  deleteTask(id: number): void
  listTasks(filters: { assignee?: string; status?: string; updatedSinceIso?: string; epicId?: number; limit: number })
    : { rows: Task[]; total: number }
  queuedCandidates(limit: number, offset?: number): Task[]
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
  insertComment(taskId: number, agent: string, content: string, type?: 'comment' | 'resolution'): number
  timelineEntries(taskId: number, limit: number): TimelineRow[]
  commentsOf(taskId: number): CommentRow[]
}

export type TimelineRow = { type: string; agent: string; text: string; created_at: string }

export type CommentRow = { id: number; agent: string; content: string; type: CommentType; created_at: string }

export type ErrorCode = 'INVALID' | 'CONFLICT' | 'NOT_FOUND' | 'BLOCKED' | 'CHILDREN' | 'EMPTY' | 'CYCLE'

export type SvcError = { code: ErrorCode; message: string }

export type SvcResult<T> = { ok: true; data: T } | { ok: false; error: SvcError }

// attempts is present only when update_status was called with reset_attempts
export type UpdateStatusData = { id: number; status: TaskStatus; version: number; attempts?: number }
