import type { Task, TaskStatus, TaskPriority, CreatedTaskStatus, CommentType } from './tasks'

export type InsertTaskInput = {
  title: string
  description: string | null
  priority: TaskPriority
  reporter: string
  depends_on: string
  now: string
  maxAttempts?: number
  epicId?: number
  isEpic?: boolean
  projectId?: number | null
}

export type ListTasksFilters = {
  assignee?: string
  status?: TaskStatus
  updatedSinceIso?: string
  epicId?: number
  isEpic?: boolean
  limit: number
  projectId?: number
}

export type UpdateTaskPatch = {
  title?: string
  description?: string | null
  priority?: TaskPriority
  dependsOn?: string
}

export type ChildStatusCounts = {
  total: number
  open: number
  done: number
  failed: number
  canceled: number
}

export type TaskView = {
  task: Readonly<Task>
  blockedBy: number[]
  subtasks?: ChildStatusCounts
}

export type TaskListPage = { tasks: ReadonlyArray<Readonly<Task>>; total: number }

export type TaskBatch = { items: Array<{ id: number; task: Readonly<Task> | null }>; total: number }

export interface LeaseStore {
  expiredLeases(nowIso: string): Array<Pick<Task, 'id' | 'version' | 'attempts' | 'max_attempts'>>
  reapTransition(
    id: number,
    expectedVersion: number,
    status: 'queued' | 'failed',
    attempts: number,
    now: string
  ): number
}

export interface TaskStore {
  getTaskRow(id: number): Task | null
  insertTask(task: InsertTaskInput): { id: number; status: CreatedTaskStatus }
  deleteTask(id: number): void
  listTasks(filters: ListTasksFilters): { rows: Task[]; total: number }
  queuedCandidates(limit: number, projectId: number, offset?: number): Task[]
  depsOf(id: number): string | null
  statusesOf(ids: number[]): Map<number, TaskStatus>
  batchTasks(ids: number[]): Map<number, Task | null>
  markClaimed(
    id: number,
    expectedVersion: number,
    agent: string,
    leaseUntil: string,
    now: string
  ): number
  transitionStatus(
    id: number,
    expectedVersion: number,
    status: TaskStatus,
    now: string,
    completedAt: string | null,
    leaseUntilIso: string | null,
    holder?: string | null,
    resetAttempts?: 0 | 1
  ): number
  updateTaskFields(id: number, expectedVersion: number, patch: UpdateTaskPatch, now: string): number
  transaction<T>(fn: () => T): T
  nonTerminalChildCount(epicId: number): number
  childStatusCounts(epicId: number): ChildStatusCounts
  promoteEpicWithMirror(
    id: number,
    agent: string,
    action: string,
    newValue: string,
    now: string,
    auditLog: boolean
  ): number
}

export interface ProjectStore {
  insertProject(project: { slug: string; folderPath: string; now: string }): number
  projectBySlug(slug: string): ProjectRow | null
  projectSlugs(): string[]
  listProjects(): ProjectListItem[]
  updateProject(id: number, patch: { folderPath?: string; archived?: boolean }, now: string): number
  deleteProject(id: number): number
  projectTaskCount(id: number): number
}

export interface CommentStore {
  insertComment(
    taskId: number,
    agent: string,
    content: string,
    type?: 'comment' | 'resolution'
  ): number
  commentsOf(taskId: number): CommentRow[]
}

export interface AuditStore {
  auditAppend(
    taskId: number,
    agent: string,
    action: string,
    oldValue?: string,
    newValue?: string
  ): void
  timelineEntries(taskId: number, limit: number): TimelineRow[]
}

export interface Store extends TaskStore, ProjectStore, CommentStore, AuditStore, LeaseStore {}

export type LifecycleStore = Pick<
  TaskStore,
  | 'getTaskRow'
  | 'insertTask'
  | 'deleteTask'
  | 'depsOf'
  | 'statusesOf'
  | 'batchTasks'
  | 'markClaimed'
  | 'transitionStatus'
  | 'updateTaskFields'
  | 'transaction'
  | 'nonTerminalChildCount'
  | 'promoteEpicWithMirror'
  | 'queuedCandidates'
> &
  Pick<CommentStore, 'insertComment'> &
  Pick<AuditStore, 'auditAppend'> &
  LeaseStore

export type QueryStore = Pick<
  TaskStore,
  | 'getTaskRow'
  | 'statusesOf'
  | 'batchTasks'
  | 'listTasks'
  | 'queuedCandidates'
  | 'childStatusCounts'
> &
  Pick<CommentStore, 'insertComment' | 'commentsOf'> &
  AuditStore &
  LeaseStore

export type CandidateStore = Pick<TaskStore, 'queuedCandidates' | 'statusesOf'>

export type TaskServiceStore = LifecycleStore & QueryStore & ProjectStore

export type ProjectRow = {
  id: number
  slug: string
  folder_path: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type ProjectListItem = { slug: string; folder_path: string; open: number }

export type TimelineRow = { type: string; agent: string; text: string; created_at: string }

export type CommentRow = {
  id: number
  agent: string
  content: string
  type: CommentType
  created_at: string
}

export type ErrorCode =
  | 'INVALID'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'BLOCKED'
  | 'CHILDREN'
  | 'EMPTY'
  | 'CYCLE'

export type SvcError = { code: ErrorCode; message: string }

export type SvcResult<T> = { ok: true; data: T } | { ok: false; error: SvcError }

export type UpdateStatusData = {
  id: number
  status: TaskStatus
  version: number
  attempts?: number
}
export type UpdateTaskData = {
  id: number
  version: number
  changed: ('title' | 'description' | 'priority' | 'depends_on')[]
}
