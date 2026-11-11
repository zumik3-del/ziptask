import type { Task, TaskPriority, CreatedTaskStatus, Clock } from './tasks'
import { MAX_LEASE_TTL_MIN, asClock } from './tasks'
import type {
  CommentRow,
  TaskBatch,
  TaskListPage,
  TaskServiceStore,
  TaskView,
  TimelineRow,
  SvcResult,
  UpdateStatusData,
  UpdateTaskData
} from './types'
import { LeaseReaper } from './reaper'
import {
  DEFAULT_LEASE_TTL_MIN,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_AUDIT_LOG,
  DEFAULT_REAP_COOLDOWN_SEC,
  DEFAULT_AUTO_CLAIM_CEILING,
  DEFAULT_PRIORITY,
  DEFAULT_REPORTER,
  DEFAULT_LIST_LIMIT,
  DEFAULT_TIMELINE_LIMIT,
  DEFAULT_QUEUE_LIMIT
} from '../defaults'

import { ProjectService } from './project-service'
import { TaskLifecycleService } from './task-lifecycle'
import { TaskQueryService } from './task-query'
import type {
  CreateTaskArgs,
  ClaimTaskArgs,
  UpdateStatusArgs,
  UpdateTaskArgs
} from './task-lifecycle'
import type { ListTasksArgs, ListQueueArgs } from './task-query'

export type TaskServiceOptions = {
  leaseTtlMin?: number
  maxAttempts?: number
  auditLog?: boolean
  reapCooldownSec?: number
  autoClaimCeiling?: number
  defaultPriority?: TaskPriority
  defaultReporter?: string
  listLimit?: number
  timelineLimit?: number
  queueLimit?: number
  scope?: string
  clock?: unknown
}

type ResolvedOptions = Required<Omit<TaskServiceOptions, 'scope' | 'clock'>> &
  Pick<TaskServiceOptions, 'scope'> & { clock: Clock | null }

function resolveOptions(opts: TaskServiceOptions): ResolvedOptions {
  const leaseTtlMin = opts.leaseTtlMin ?? DEFAULT_LEASE_TTL_MIN
  if (leaseTtlMin > MAX_LEASE_TTL_MIN) {
    throw new Error(`leaseTtlMin ${leaseTtlMin} exceeds MAX_LEASE_TTL_MIN (${MAX_LEASE_TTL_MIN})`)
  }
  return {
    leaseTtlMin,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    auditLog: opts.auditLog ?? DEFAULT_AUDIT_LOG,
    reapCooldownSec: opts.reapCooldownSec ?? DEFAULT_REAP_COOLDOWN_SEC,
    autoClaimCeiling: opts.autoClaimCeiling ?? DEFAULT_AUTO_CLAIM_CEILING,
    defaultPriority: opts.defaultPriority ?? DEFAULT_PRIORITY,
    defaultReporter: opts.defaultReporter ?? DEFAULT_REPORTER,
    listLimit: opts.listLimit ?? DEFAULT_LIST_LIMIT,
    timelineLimit: opts.timelineLimit ?? DEFAULT_TIMELINE_LIMIT,
    queueLimit: opts.queueLimit ?? DEFAULT_QUEUE_LIMIT,
    scope: opts.scope,
    clock: asClock(opts.clock)
  }
}

export class TaskService {
  readonly projects: ProjectService
  readonly lifecycle: TaskLifecycleService
  readonly query: TaskQueryService

  constructor(store: TaskServiceStore, opts: TaskServiceOptions = {}) {
    const resolved = resolveOptions(opts)
    const reaper = new LeaseReaper(
      store,
      resolved.reapCooldownSec,
      resolved.auditLog,
      resolved.clock
    )
    this.projects = new ProjectService(store, resolved.scope)
    this.lifecycle = new TaskLifecycleService(store, resolved, this.projects, reaper)
    this.query = new TaskQueryService(store, resolved, this.projects, reaper)
  }

  createTask(args: CreateTaskArgs): SvcResult<{ id: number; status: CreatedTaskStatus }> {
    return this.lifecycle.createTask(args)
  }

  getTaskView(id: number): SvcResult<TaskView> {
    return this.query.getTaskView(id)
  }

  listTasks(args: ListTasksArgs): SvcResult<TaskListPage> {
    return this.query.listTasks(args)
  }

  getTasksByIds(ids: number[]): SvcResult<TaskBatch> {
    return this.query.getTasksByIds(ids)
  }

  claimTask(
    args: ClaimTaskArgs
  ): SvcResult<{ id: number; leaseTtlMin: number; task: Readonly<Task> }> {
    return this.lifecycle.claimTask(args)
  }

  updateStatus(args: UpdateStatusArgs): SvcResult<UpdateStatusData> {
    return this.lifecycle.updateStatus(args)
  }

  updateTask(args: UpdateTaskArgs): SvcResult<UpdateTaskData> {
    return this.lifecycle.updateTask(args)
  }

  listQueue(args: ListQueueArgs): SvcResult<ReadonlyArray<Readonly<Task>>> {
    return this.query.listQueue(args)
  }

  addComment(args: {
    id: number
    agent: string
    content: string
  }): SvcResult<{ comment_id: number }> {
    return this.query.addComment(args)
  }

  getTimeline(
    id: number,
    limit?: number,
    since?: number
  ): SvcResult<ReadonlyArray<Readonly<TimelineRow>>> {
    return this.query.getTimeline(id, limit, since)
  }

  listComments(id: number): SvcResult<ReadonlyArray<Readonly<CommentRow>>> {
    return this.query.listComments(id)
  }
}

export { ProjectService, TaskLifecycleService, TaskQueryService }
export type { ResolvedOptions }
