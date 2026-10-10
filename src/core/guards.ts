import type { Task, TaskStatus } from './tasks'
import { isValidTransition, TERMINAL_STATUSES } from './tasks'
import type { TaskStore, SvcError } from './types'
import { parseDeps, depsSatisfied } from './deps'
import { tooLongError, epicError, MAX_TITLE, MAX_AGENT } from './validation'

export type CreateTaskInput = {
  title: string; description?: string; priority?: string; assignee?: string
  depends_on?: number[]; reporter?: string; epic?: boolean; epic_id?: number
  defaultReporter: string
}

export type UpdateStatusInput = {
  id: number; agent: string; status: TaskStatus; version?: number
  comment?: string; renew?: boolean; reset_attempts?: boolean
}

// -- length / required helpers (pure, no-store) -----------------------------
// (moved to core/validation.ts)

// -- create_task guard -------------------------------------------------------

// Pure precondition set for create_task: title/actor lengths, the epic↔(epic_id|deps) conflicts,
// the dep-on-epic rule, and the epic_id target shape. Returns the first failure or null.
export function createTaskGuard(args: CreateTaskInput, store: TaskStore): SvcError | null {
  if (!args.title.trim()) return { code: 'INVALID', message: 'title required' }
  if (args.title.length > MAX_TITLE) return { code: 'INVALID', message: 'title too long' }
  const reporterErr = tooLongError(args.reporter ?? args.defaultReporter, MAX_AGENT, 'reporter')
  if (reporterErr) return reporterErr
  if (args.assignee !== undefined) {
    const assigneeErr = tooLongError(args.assignee, MAX_AGENT, 'assignee')
    if (assigneeErr) return assigneeErr
  }
  const deps = args.depends_on ?? []
  // D5: epic cannot coexist with epic_id or depends_on
  if (args.epic && args.epic_id !== undefined) return { code: 'INVALID', message: 'epic cannot have a parent epic' }
  if (args.epic && deps.length > 0) return { code: 'INVALID', message: 'epic cannot have depends_on' }
  // D5: rejects depends_on pointing at an epic
  if (deps.length > 0) {
    const batch = store.batchTasks(deps)
    for (const [d, t] of batch) {
      if (t?.is_epic) return { code: 'INVALID', message: `dependencies on epic tasks not allowed (#${d})` }
    }
  }
  // D5: epic_id target must exist, be non-terminal, and have epic_id IS NULL
  if (args.epic_id !== undefined) {
    const target = store.getTaskRow(args.epic_id)
    if (!target) return { code: 'NOT_FOUND', message: '' }
    if (TERMINAL_STATUSES.includes(target.status)) return { code: 'INVALID', message: 'cannot attach to a terminal task' }
    if (target.epic_id !== null) return { code: 'INVALID', message: 'cannot attach to a sub-task (no nesting)' }
  }
  return null
}

// -- update_status guard -----------------------------------------------------

// All refusals that do not touch the row: version CAS, the lease self-edge/renew rules, the
// transition table, claim-grade eligibility for a non-renewal in_progress, the epic refund ban
// and the epic terminal close-guard. Returns the first failure or null.
export function updateStatusGuard(args: UpdateStatusInput, task: Task, refund: boolean, store: TaskStore): SvcError | null {
  // version is optional: when omitted the read-time check is skipped, but the write still CASes on
  // the version read here, so a concurrent modification between read and write refuses as CONFLICT.
  if (args.version !== undefined && task.version !== args.version) {
    return { code: 'CONFLICT', message: `expected version ${task.version}, got ${args.version}` }
  }

  // Lease heartbeat: only the holder re-arms its own in_progress lease. The reap above is the fence,
  // so a late heartbeat sees a requeued task and fails here instead of resurrecting the lease.
  const selfEdge = task.status === 'in_progress' && args.status === 'in_progress'
  const renewal = selfEdge && args.renew === true
  if (args.renew === true && !selfEdge) {
    return { code: 'INVALID', message: 'renew requires status=in_progress on an in_progress task' }
  }
  // the self-edge exists in VALID_TRANSITIONS; without the flag it stays unreachable so a
  // typo'd in_progress cannot silently become a lease bump
  if (selfEdge && !renewal) {
    return { code: 'INVALID', message: 'in_progress → in_progress requires renew: true' }
  }
  if (!isValidTransition(task.status, args.status)) {
    return { code: 'INVALID', message: `${task.status} → ${args.status}` }
  }
  if (renewal) {
    const epicErr = epicError(task, `#${task.id} is an epic`)
    if (epicErr) return epicErr
    if (task.assignee !== args.agent) return { code: 'CONFLICT', message: `lease held by ${task.assignee}` }
  }
  // acquiring a lease is a claim-verb concern: update_status must not stay a second, unguarded
  // door to in_progress. The claimTask precondition set maps 1:1 — NOT_FOUND is covered by the
  // row read, the status window by isValidTransition, so is_epic and deps are the only two
  // missing checks. review -> in_progress is a deliberate superset (work sent back): its deps are
  // provably still satisfied, because deps are immutable after create and terminal statuses have
  // no outgoing edge.
  if (args.status === 'in_progress' && !selfEdge) {
    const epicErr = epicError(task, `#${task.id} is an epic, not claimable`)
    if (epicErr) return epicErr
    if (task.status === 'queued' || task.status === 'blocked') {
      const deps = parseDeps(task.depends_on)
      if (!depsSatisfied(store.statusesOf(deps), deps)) return { code: 'BLOCKED', message: 'dependencies not satisfied' }
    }
  }
  // an epic is never leased (the in_progress acquisition guard above), so its attempts is always 0 and
  // a refund here would be a no-op write with a misleading audit row. Terminal statuses need no guard:
  // they have no outgoing edge, so isValidTransition refuses them all.
  if (refund) {
    const epicErr = epicError(task, `cannot reset attempts on epic #${task.id}`)
    if (epicErr) return epicErr
  }
  // D3: epic terminal guard — reject done/failed while non-terminal children exist
  if (task.is_epic && TERMINAL_STATUSES.includes(args.status)) {
    const open = store.nonTerminalChildCount(args.id)
    if (open > 0) return { code: 'CHILDREN', message: `${open} sub-tasks not terminal` }
  }
  return null
}
