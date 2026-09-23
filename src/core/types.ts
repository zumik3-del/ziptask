import type { Task, TaskStatus, CommentType } from './tasks'

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
  statusesOf(ids: number[]): Map<number, TaskStatus>
  batchTasks(ids: number[]): Map<number, Task | null>
  markClaimed(id: number, expectedVersion: number, agent: string, leaseUntil: string, now: string): number
  transitionStatus(id: number, expectedVersion: number, status: TaskStatus,
    now: string, completedAt: string | null, leaseUntilIso: string | null): number
  transaction<T>(fn: () => T): T
  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>>
  reapSettle(id: number, expectedVersion: number, status: TaskStatus, attempts: number, now: string): number
  insertComment(taskId: number, agent: string, content: string, type?: 'comment' | 'resolution'): number
  auditAppend(taskId: number, agent: string, action: string, oldValue?: string, newValue?: string): void
  timelineEntries(taskId: number, limit: number): TimelineRow[]
  commentsOf(taskId: number): CommentRow[]
  nonTerminalChildCount(epicId: number): number
  childStatusCounts(epicId: number): { total: number; open: number; done: number; failed: number; canceled: number }
  promoteEpicWithMirror(id: number, agent: string, action: string, newValue: string, now: string, auditLog: boolean): void
  appendEpicAuditMirror(taskId: number, agent: string, action: string, newValue: string): void
}

export type TimelineRow = { type: string; agent: string; text: string; created_at: string }

export type CommentRow = { id: number; agent: string; content: string; type: CommentType; created_at: string }

export type SvcResult<T> = { ok: true; data: T } | { ok: false; error: string }
