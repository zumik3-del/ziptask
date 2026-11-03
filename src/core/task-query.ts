import type { Task, TaskStatus, Clock } from './tasks'
import { clampLimit } from './tasks'
import type { QueryStore, SvcResult, CommentRow, TimelineRow } from './types'
import type { ProjectService } from './project-service'
import type { ResolvedOptions } from './service'
import { parseDeps, blockingDeps } from './deps'
import { readyCandidates } from './candidates'
import { ok, fail } from './result'
import { LeaseReaper } from './reaper'
import { agentError, contentError } from './validation'

export type ListTasksArgs = {
  assignee?: string; status?: TaskStatus; updated_since?: number; epic_id?: number; is_epic?: boolean
  limit?: number; project?: string
}

export type ListQueueArgs = { limit?: number; project?: string }

export class TaskQueryService {
  private readonly opts: ResolvedOptions
  private readonly clock: Clock | null
  private readonly reaper: LeaseReaper
  readonly projects: ProjectService

  constructor(private store: QueryStore, opts: ResolvedOptions, projects: ProjectService, reaper?: LeaseReaper) {
    this.opts = opts
    this.clock = opts.clock
    this.reaper = reaper ?? new LeaseReaper(store, this.opts.reapCooldownSec, this.opts.auditLog, this.clock)
    this.projects = projects
  }

  getTaskView(id: number): SvcResult<{ task: Readonly<Task>; blockedBy: number[]; subtasks?: { total: number; open: number; done: number; failed: number; canceled: number } }> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    const deps = parseDeps(task.depends_on)
    const depStatuses = this.store.statusesOf(deps)
    const blockedBy = blockingDeps(depStatuses, deps)
    if (task.is_epic) {
      const counts = this.store.childStatusCounts(id)
      if (counts.total > 0) {
        return ok({ task, blockedBy, subtasks: counts })
      }
    }
    return ok({ task, blockedBy })
  }

  listTasks(args: ListTasksArgs): SvcResult<{ tasks: ReadonlyArray<Readonly<Task>>; total: number }> {
    const project = this.projects.resolve(args.project)
    if (!project.ok) return fail(project.error)
    if (args.updated_since !== undefined) {
      if (!Number.isFinite(args.updated_since)) return fail('INVALID', 'invalid updated_since')
      const updatedSinceDate = new Date(args.updated_since)
      if (Number.isNaN(updatedSinceDate.getTime())) return fail('INVALID', 'invalid updated_since')
    }
    this.reaper.reapIfStale()
    const updatedSinceIso = args.updated_since !== undefined ? new Date(args.updated_since).toISOString() : undefined
    const { rows, total } = this.store.listTasks({
      assignee: args.assignee,
      status: args.status,
      updatedSinceIso,
      epicId: args.epic_id,
      isEpic: args.is_epic,
      limit: clampLimit(args.limit, this.opts.listLimit),
      projectId: project.data.id
    })
    return ok({ tasks: rows, total })
  }

  getTasksByIds(ids: number[]): SvcResult<{ items: Array<{ id: number; task: Readonly<Task> | null }>; total: number }> {
    this.reaper.reapIfStale()
    const batch = this.store.batchTasks(ids)
    return ok({
      items: ids.map(id => ({ id, task: batch.get(id) ?? null })),
      total: ids.length
    })
  }

  listQueue(args: ListQueueArgs): SvcResult<ReadonlyArray<Readonly<Task>>> {
    const project = this.projects.resolve(args.project)
    if (!project.ok) return fail(project.error)
    this.reaper.reapIfStale()
    const limit = clampLimit(args.limit, this.opts.queueLimit)
    return ok(readyCandidates(this.store, limit, this.opts.autoClaimCeiling, project.data.id))
  }

  addComment(args: { id: number; agent: string; content: string }): SvcResult<{ comment_id: number }> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(args.id)
    if (!task) return fail('NOT_FOUND')
    const validationErr =
      agentError(args.agent) ??
      contentError(args.content)
    if (validationErr) return fail(validationErr)
    const comment_id = this.store.insertComment(args.id, args.agent, args.content)
    return ok({ comment_id })
  }

  getTimeline(id: number, limit?: number): SvcResult<ReadonlyArray<Readonly<TimelineRow>>> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    const limitN = clampLimit(limit, this.opts.timelineLimit)
    const rows = this.store.timelineEntries(id, limitN)
    return ok(rows)
  }

  listComments(id: number): SvcResult<ReadonlyArray<Readonly<CommentRow>>> {
    this.reaper.reapIfStale()
    const task = this.store.getTaskRow(id)
    if (!task) return fail('NOT_FOUND')
    return ok(this.store.commentsOf(id))
  }
}
