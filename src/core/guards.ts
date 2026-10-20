import type { Task, TaskStatus } from './tasks'
import { isValidTransition, TERMINAL_STATUSES, MAX_TITLE_LENGTH, MAX_AGENT_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_DEPENDS_ON } from './tasks'
import type { TaskStore, SvcError } from './types'
import { parseDeps, depsSatisfied } from './deps'
import { requiredError, tooLongError, optionalFieldError, epicError } from './validation'
import { RESERVED_PROJECT_SLUG } from './project-slug'

// Only the reads a guard performs: a guard never writes, so it cannot reach the mutating half.
type GuardStore = Pick<TaskStore, 'batchTasks' | 'getTaskRow' | 'statusesOf' | 'nonTerminalChildCount'>
type DepsStore = Pick<TaskStore, 'statusesOf'>

export type CreateTaskInput = {
  title: string; description?: string | null; priority?: string; assignee?: string | null
  depends_on?: number[]; reporter?: string; epic?: boolean; epic_id?: number
  defaultReporter: string
  project: string; projectArchived: boolean
}

export type UpdateStatusInput = {
  id: number; agent: string; status: TaskStatus; version?: number
  comment?: string; renew?: boolean; reset_attempts?: boolean
}

// -- claim-grade eligibility -------------------------------------------------

// An epic is never leased. The exact wire string is written here once, so claim_task and the
// update_status acquisition guard can never drift apart.
export function epicNotClaimableError(task: Task): SvcError | null {
  return task.is_epic ? { code: 'INVALID', message: `#${task.id} is an epic, not claimable` } : null
}

// The full claim precondition set: not an epic, deps satisfied.
export function claimEligibilityError(task: Task, store: DepsStore): SvcError | null {
  const epicErr = epicNotClaimableError(task)
  if (epicErr) return epicErr
  const deps = parseDeps(task.depends_on)
  if (!depsSatisfied(store.statusesOf(deps), deps)) return { code: 'BLOCKED', message: 'dependencies not satisfied' }
  return null
}

// -- create_task guard -------------------------------------------------------

// Pure precondition set for create_task: title/actor/description lengths, the depends_on size
// bound, the epic↔(epic_id|deps) conflicts, the dep-on-epic rule, and the epic_id target shape.
// Returns the first failure or null.
export function createTaskGuard(args: CreateTaskInput, store: GuardStore): SvcError | null {
  const titleErr = requiredError(args.title, 'title') ?? tooLongError(args.title, MAX_TITLE_LENGTH, 'title')
  if (titleErr) return titleErr
  const reporterErr = tooLongError(args.reporter ?? args.defaultReporter, MAX_AGENT_LENGTH, 'reporter')
  if (reporterErr) return reporterErr
  const assigneeErr = optionalFieldError(args.assignee, MAX_AGENT_LENGTH, 'assignee')
  if (assigneeErr) return assigneeErr
  const descriptionErr = optionalFieldError(args.description, MAX_DESCRIPTION_LENGTH, 'description')
  if (descriptionErr) return descriptionErr
  const deps = args.depends_on ?? []
  if (deps.length > MAX_DEPENDS_ON) return { code: 'INVALID', message: 'depends_on too long' }
  // D5: epic cannot coexist with epic_id or depends_on
  if (args.epic && args.epic_id !== undefined) return { code: 'INVALID', message: 'epic cannot have a parent epic' }
  if (args.epic && deps.length > 0) return { code: 'INVALID', message: 'epic cannot have depends_on' }
  // An epic is never leased, so it never has a holder; `assignee` means exactly "lease holder"
  // everywhere else. Refuse rather than silently drop the caller's value — the repo also hard-writes
  // NULL for epics, so the invariant holds even if this guard is ever bypassed.
  if (args.epic && args.assignee !== undefined) {
    return { code: 'INVALID', message: 'an epic takes no assignee: it holds no lease' }
  }
  // G1/G2: `legacy` parks pre-v5 rows and archived projects keep their work readable but take no new
  // task; both are refusals on the resolved project row the service already looked up.
  if (args.project === RESERVED_PROJECT_SLUG) {
    return { code: 'INVALID', message: `create_task is refused in the reserved project '${RESERVED_PROJECT_SLUG}'` }
  }
  if (args.projectArchived) return { code: 'INVALID', message: `project '${args.project}' is archived` }
  // D5: rejects depends_on pointing at an epic; G3: a dependency must live in the same project
  if (deps.length > 0) {
    const batch = store.batchTasks(deps)
    for (const [d, t] of batch) {
      if (t?.is_epic) return { code: 'INVALID', message: `dependencies on epic tasks not allowed (#${d})` }
      if (t && t.project !== args.project) {
        return { code: 'INVALID', message: `dependency #${d} belongs to project '${t.project ?? ''}'` }
      }
    }
  }
  // D5: epic_id target must exist, be non-terminal, and have epic_id IS NULL
  // G4: it must also live in the same project (G5: an epic's children inherit, never guess)
  if (args.epic_id !== undefined) {
    const target = store.getTaskRow(args.epic_id)
    if (!target) return { code: 'NOT_FOUND', message: '' }
    if (TERMINAL_STATUSES.includes(target.status)) return { code: 'INVALID', message: 'cannot attach to a terminal task' }
    if (target.epic_id !== null) return { code: 'INVALID', message: 'cannot attach to a sub-task (no nesting)' }
    if (target.project !== args.project) {
      return { code: 'INVALID', message: `epic #${args.epic_id} belongs to project '${target.project ?? ''}'` }
    }
    // Promotion rewrites the target's status to `open` and clears its lease, so it is only safe on a
    // task nobody has started. Promoting an in_progress/review/blocked row would silently destroy
    // live work: the holder loses its lease and the status change leaves no audit row of its own.
    // Attaching to an epic that already exists promotes nothing, so the existing statuses stay legal.
    if (!target.is_epic && target.status !== 'queued') {
      return { code: 'INVALID', message: `cannot promote #${args.epic_id} from ${target.status}: only a queued task can become an epic` }
    }
  }
  return null
}

// -- epic promotion race -----------------------------------------------------

// The one refusal for the promotion race: the epic_id target left the state the up-front guard
// accepted, so the attach is refused. It is a conflict, not a malformed request — the target moved.
export function epicPromotionRaceError(epicId: number): SvcError {
  return { code: 'CONFLICT', message: `epic #${epicId} changed state during promotion` }
}

// The epic_id target preconditions, re-checked next to the write. createTaskGuard reads the target
// before the write, and a rival can claim it in between (a claim takes the row out of `queued`), so
// the same preconditions are verified again inside the write transaction. A target that already is
// an epic only has to stay attachable (non-terminal, no parent); a non-epic is promoted here, and
// only from `queued` — the one state with no holder and no work to destroy. Every mismatch means
// the target changed after the guard accepted it, so it is reported as the race, not as a
// precondition the caller got wrong.
export function epicTargetChangedError(target: Task | null, epicId: number, project: string): SvcError | null {
  if (!target) return epicPromotionRaceError(epicId)
  if (target.epic_id !== null) return epicPromotionRaceError(epicId)
  if (target.project !== project) return epicPromotionRaceError(epicId)
  if (target.is_epic) return TERMINAL_STATUSES.includes(target.status) ? epicPromotionRaceError(epicId) : null
  return target.status === 'queued' ? null : epicPromotionRaceError(epicId)
}

// -- update_status guard -----------------------------------------------------

// All refusals that do not touch the row: version CAS, the lease self-edge/renew rules, the
// transition table, claim-grade eligibility for a non-renewal in_progress, the epic refund ban
// and the epic terminal close-guard. Returns the first failure or null.
export function updateStatusGuard(args: UpdateStatusInput, task: Task, refund: boolean, store: GuardStore): SvcError | null {
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
  // ADR 0002: `open` is epic-only and epics never hold queued/in_progress/review/blocked. Sits after the
  // renew-intent refusals and ahead of the transition table so the documented order holds and an epic
  // reports itself (`#N is an epic`) rather than the transition table's `open → in_progress`. The
  // in_progress clause excludes the renewal self-edge: that is a heartbeat on a legacy leased epic and
  // is answered by the renewal path below with the shorter `#N is an epic`.
  if (!task.is_epic && args.status === 'open') {
    return { code: 'INVALID', message: `${task.status} → open` }
  }
  if (task.is_epic && (args.status === 'queued' || args.status === 'review' || args.status === 'blocked')) {
    return { code: 'INVALID', message: `${task.status} → ${args.status}` }
  }
  if (task.is_epic && args.status === 'in_progress' && task.status !== 'in_progress') {
    return { code: 'INVALID', message: `#${task.id} is an epic, not claimable` }
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
  // row read, the status window by isValidTransition, so is_epic and deps are the rest. Both use
  // claimEligibilityError; review -> in_progress is a deliberate superset (work sent back) and asks
  // only for the epic half, because its deps are provably still satisfied: deps are immutable after
  // create and terminal statuses have no outgoing edge.
  if (args.status === 'in_progress' && !selfEdge) {
    const eligibilityErr = task.status === 'queued' || task.status === 'blocked'
      ? claimEligibilityError(task, store)
      : epicNotClaimableError(task)
    if (eligibilityErr) return eligibilityErr
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
