import type { Task, TaskStatus } from './tasks'
import {
  isValidTransition,
  TERMINAL_STATUSES,
  EDITABLE_STATUSES,
  MAX_TITLE_LENGTH,
  MAX_AGENT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_DEPENDS_ON,
  normalizePriority,
  PRIORITY_INVALID_MESSAGE
} from './tasks'
import type { TaskStore, SvcError } from './types'
import { parseDeps, depsSatisfied, collapseDeps } from './deps'
import { requiredError, tooLongError, optionalFieldError, epicError, textError } from './validation'
import { RESERVED_PROJECT_SLUG } from './project-slug'

type GuardStore = Pick<
  TaskStore,
  'batchTasks' | 'getTaskRow' | 'statusesOf' | 'nonTerminalChildCount'
>
type DepsStore = Pick<TaskStore, 'statusesOf'>

export type CreateTaskInput = {
  title: string
  description?: string | null
  priority?: unknown
  assignee?: string | null
  depends_on?: number[]
  reporter?: string
  epic?: boolean
  epic_id?: number
  defaultReporter: string
  project: string
  projectArchived: boolean
}

export type UpdateStatusInput = {
  id: number
  agent: string
  status: TaskStatus
  version?: number
  comment?: string
  renew?: boolean
  reset_attempts?: boolean
}

export type UpdateTaskInput = {
  id: number
  agent: string
  version?: number
  title?: string
  description?: string | null
  priority?: unknown
  depends_on?: number[]
  comment?: string
}

export function editableWindowError(task: Task): SvcError | null {
  if (!EDITABLE_STATUSES.includes(task.status)) {
    return {
      code: 'INVALID',
      message: `cannot edit #${task.id} in status=${task.status}: only a queued task (or an open epic) is editable`
    }
  }
  if (task.assignee !== null || task.lease_expires_at !== null) {
    return { code: 'INVALID', message: `task #${task.id} holds a lease and is not editable` }
  }
  return null
}

// An epic is never leased. The exact wire string is written here once, so claim_task and the
// update_status acquisition guard can never drift apart.
const epicNotClaimableMessage = (id: number): string => `#${id} is an epic, not claimable`

export function epicNotClaimableError(task: Task): SvcError | null {
  return task.is_epic ? { code: 'INVALID', message: epicNotClaimableMessage(task.id) } : null
}

export function claimEligibilityError(task: Task, store: DepsStore): SvcError | null {
  const epicErr = epicNotClaimableError(task)
  if (epicErr) return epicErr
  const deps = parseDeps(task.depends_on)
  if (!depsSatisfied(store.statusesOf(deps), deps))
    return { code: 'BLOCKED', message: 'dependencies not satisfied' }
  return null
}

// The epic_id target preconditions, in ONE predicate. `null` means the target is attachable; a
// refusal names the precondition that failed. Both call sites read this list — the up-front guard
// maps a refusal to the caller's mistake, the in-transaction re-check maps the same refusal to the
// promotion race — so the two copies cannot drift apart.
//
// The order is the up-front guard's order: a target that breaks several preconditions at once keeps
// the message it has today.
//
// The project check is reachable from the guard (the target may live in another project) and
// unreachable from the re-check: a task's project membership is immutable — nothing moves a task
// between projects — so a re-check only ever sees a target of the same project. It lives in the
// shared predicate because the guard needs it; the re-check inherits it and maps it to the race.
export type EpicTargetRefusal =
  | { kind: 'missing' }
  | { kind: 'terminal' }
  | { kind: 'nested' }
  | { kind: 'project'; project: string }
  | { kind: 'not-promotable'; status: TaskStatus }

export function epicTargetRefusal(target: Task | null, project: string): EpicTargetRefusal | null {
  if (!target) return { kind: 'missing' }
  if (TERMINAL_STATUSES.includes(target.status)) return { kind: 'terminal' }
  if (target.epic_id !== null) return { kind: 'nested' }
  if (target.project !== project) return { kind: 'project', project: target.project ?? '' }
  // Promotion rewrites the target's status to `open` and clears its lease, so it is only safe on a
  // task nobody has started. Promoting an in_progress/review/blocked row would silently destroy
  // live work: the holder loses its lease and the status change leaves no audit row of its own.
  // Attaching to an epic that already exists promotes nothing, so the existing statuses stay legal.
  if (!target.is_epic && target.status !== 'queued')
    return { kind: 'not-promotable', status: target.status }
  return null
}

export function epicTargetGuardError(refusal: EpicTargetRefusal, epicId: number): SvcError {
  switch (refusal.kind) {
    case 'missing':
      return { code: 'NOT_FOUND', message: '' }
    case 'terminal':
      return { code: 'INVALID', message: 'cannot attach to a terminal task' }
    case 'nested':
      return { code: 'INVALID', message: 'cannot attach to a sub-task (no nesting)' }
    case 'project':
      return { code: 'INVALID', message: `epic #${epicId} belongs to project '${refusal.project}'` }
    case 'not-promotable': {
      return {
        code: 'INVALID',
        message: `cannot promote #${epicId} from ${refusal.status}: only a queued task can become an epic`
      }
    }
  }
}

export function depsGuardError(
  store: GuardStore,
  deps: number[],
  project: string
): SvcError | null {
  const batch = store.batchTasks(deps)
  for (const d of deps) {
    const t = batch.get(d)
    if (!t) return { code: 'INVALID', message: `dependency #${d} not found` }
    if (t.is_epic)
      return { code: 'INVALID', message: `dependencies on epic tasks not allowed (#${d})` }
    if (t.project !== project)
      return {
        code: 'INVALID',
        message: `dependency #${d} belongs to project '${t.project ?? ''}'`
      }
  }
  return null
}

export function createTaskGuard(args: CreateTaskInput, store: GuardStore): SvcError | null {
  const titleErr =
    requiredError(args.title, 'title') ?? tooLongError(args.title, MAX_TITLE_LENGTH, 'title')
  if (titleErr) return titleErr
  const reporterErr = tooLongError(
    args.reporter ?? args.defaultReporter,
    MAX_AGENT_LENGTH,
    'reporter'
  )
  if (reporterErr) return reporterErr
  const assigneeErr = optionalFieldError(args.assignee, MAX_AGENT_LENGTH, 'assignee')
  if (assigneeErr) return assigneeErr
  const descriptionErr = optionalFieldError(args.description, MAX_DESCRIPTION_LENGTH, 'description')
  if (descriptionErr) return descriptionErr
  if (args.depends_on !== undefined && !Array.isArray(args.depends_on)) {
    return { code: 'INVALID', message: 'invalid depends_on' }
  }
  const deps = args.depends_on === undefined ? [] : collapseDeps(args.depends_on)
  if (deps.length > MAX_DEPENDS_ON) return { code: 'INVALID', message: 'depends_on too long' }
  if (args.epic && args.epic_id !== undefined)
    return { code: 'INVALID', message: 'epic cannot have a parent epic' }
  if (args.epic && deps.length > 0)
    return { code: 'INVALID', message: 'epic cannot have depends_on' }
  // An epic is never leased, so it never has a holder; `assignee` means exactly "lease holder"
  // everywhere else. Refuse rather than silently drop the caller's value — the repo also hard-writes
  // NULL for epics, so the invariant holds even if this guard is ever bypassed.
  if (args.epic && args.assignee !== undefined) {
    return { code: 'INVALID', message: 'an epic takes no assignee: it holds no lease' }
  }
  // A regular task is born `queued`, which is no lease either: the holder is written when the task
  // is claimed. A creation-time `assignee` would be a holder without a lease, and nothing would
  // honour it — the queue is shared and the first claim overwrites the column. So the value is
  // refused rather than silently dropped (the same rule as the epic above), and the repo hard-writes
  // NULL, so the invariant holds even if this guard is ever bypassed.
  if (args.assignee !== undefined) {
    return {
      code: 'INVALID',
      message: 'assignee is refused at creation: a task holds a lease only from in_progress'
    }
  }
  if (args.project === RESERVED_PROJECT_SLUG) {
    return {
      code: 'INVALID',
      message: `create_task is refused in the reserved project '${RESERVED_PROJECT_SLUG}'`
    }
  }
  if (args.projectArchived)
    return { code: 'INVALID', message: `project '${args.project}' is archived` }
  if (deps.length > 0) {
    const depErr = depsGuardError(store, deps, args.project)
    if (depErr) return depErr
  }
  if (args.epic_id !== undefined) {
    const refusal = epicTargetRefusal(store.getTaskRow(args.epic_id), args.project)
    if (refusal) return epicTargetGuardError(refusal, args.epic_id)
  }
  return null
}

export function epicPromotionRaceError(epicId: number): SvcError {
  return { code: 'CONFLICT', message: `epic #${epicId} changed state during promotion` }
}

export function epicTargetChangedError(
  target: Task | null,
  epicId: number,
  project: string
): SvcError | null {
  return epicTargetRefusal(target, project) ? epicPromotionRaceError(epicId) : null
}

export function updateStatusGuard(
  args: UpdateStatusInput,
  task: Task,
  refund: boolean,
  store: GuardStore
): SvcError | null {
  if (args.version !== undefined && task.version !== args.version) {
    return { code: 'CONFLICT', message: `expected version ${task.version}, got ${args.version}` }
  }

  const selfEdge = task.status === 'in_progress' && args.status === 'in_progress'
  const renewal = selfEdge && args.renew === true
  if (args.renew === true && !selfEdge) {
    return { code: 'INVALID', message: 'renew requires status=in_progress on an in_progress task' }
  }
  if (selfEdge && !renewal) {
    return { code: 'INVALID', message: 'in_progress → in_progress requires renew: true' }
  }
  // ADR 0002: `open` is epic-only and epics never hold queued/in_progress/review/blocked. Sits after the
  // renew-intent refusals and ahead of the transition table so the documented order holds and an epic
  // reports itself (`#N is an epic`) rather than the transition table's `open → in_progress`. The
  // in_progress clause excludes the renewal self-edge: that is a heartbeat on a legacy leased epic and
  // is answered by the renewal path below with the shorter `#N is an epic`.
  if (!task.is_epic && args.status === 'open') {
    return { code: 'INVALID', message: `${task.status} → open` }
  }
  if (
    task.is_epic &&
    (args.status === 'queued' || args.status === 'review' || args.status === 'blocked')
  ) {
    return { code: 'INVALID', message: `${task.status} → ${args.status}` }
  }
  if (task.is_epic && args.status === 'in_progress' && task.status !== 'in_progress') {
    return { code: 'INVALID', message: epicNotClaimableMessage(task.id) }
  }
  if (!isValidTransition(task.status, args.status)) {
    return { code: 'INVALID', message: `${task.status} → ${args.status}` }
  }
  if (renewal) {
    const epicErr = epicError(task, `#${task.id} is an epic`)
    if (epicErr) return epicErr
    if (task.assignee !== args.agent)
      return { code: 'CONFLICT', message: `lease held by ${task.assignee}` }
  }
  if (args.status === 'in_progress' && !selfEdge) {
    const eligibilityErr =
      task.status === 'queued' || task.status === 'blocked'
        ? claimEligibilityError(task, store)
        : epicNotClaimableError(task)
    if (eligibilityErr) return eligibilityErr
  }
  if (refund) {
    const epicErr = epicError(task, `cannot reset attempts on epic #${task.id}`)
    if (epicErr) return epicErr
    if (TERMINAL_STATUSES.includes(task.status)) {
      return { code: 'INVALID', message: `cannot reset attempts on terminal task #${task.id}` }
    }
  }
  if (task.is_epic && TERMINAL_STATUSES.includes(args.status)) {
    const open = store.nonTerminalChildCount(args.id)
    if (open > 0) return { code: 'CHILDREN', message: `${open} sub-tasks not terminal` }
  }
  return null
}

export function updateTaskGuard(
  args: UpdateTaskInput,
  task: Task,
  store: GuardStore
): SvcError | null {
  const agentErr =
    requiredError(args.agent, 'agent') ?? tooLongError(args.agent, MAX_AGENT_LENGTH, 'agent')
  if (agentErr) return agentErr
  if (args.comment !== undefined) {
    const commentErr = textError(args.comment, 'comment')
    if (commentErr) return commentErr
  }
  if (args.version !== undefined && task.version !== args.version) {
    return { code: 'CONFLICT', message: `expected version ${task.version}, got ${args.version}` }
  }
  const windowErr = editableWindowError(task)
  if (windowErr) return windowErr
  const hasField =
    args.title !== undefined ||
    args.description !== undefined ||
    args.priority !== undefined ||
    args.depends_on !== undefined
  if (!hasField) return { code: 'INVALID', message: 'nothing to update' }
  if (args.title !== undefined) {
    const titleErr =
      requiredError(args.title, 'title') ?? tooLongError(args.title, MAX_TITLE_LENGTH, 'title')
    if (titleErr) return titleErr
  }
  if (args.description !== undefined) {
    if (args.description === null) return { code: 'INVALID', message: 'description required' }
    const descErr = tooLongError(args.description, MAX_DESCRIPTION_LENGTH, 'description')
    if (descErr) return descErr
  }
  if (args.priority !== undefined) {
    if (normalizePriority(args.priority) === null) {
      return { code: 'INVALID', message: PRIORITY_INVALID_MESSAGE }
    }
  }
  if (args.depends_on !== undefined) {
    if (!Array.isArray(args.depends_on)) return { code: 'INVALID', message: 'invalid depends_on' }
    const deps = collapseDeps(args.depends_on)
    if (deps.length > MAX_DEPENDS_ON) return { code: 'INVALID', message: 'depends_on too long' }
    if (task.is_epic && (deps.length > 0 || parseDeps(task.depends_on).length > 0)) {
      return { code: 'INVALID', message: 'an epic cannot have depends_on' }
    }
    const depErr = depsGuardError(store, deps, task.project ?? '')
    if (depErr) return depErr
  }
  return null
}
