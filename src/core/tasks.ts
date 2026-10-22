// The one status list: the union type, the enum, the codes, the terminal set and the SQL list
// are all derived from it (the SQL text itself lives in src/db/sql.ts).
export const TASK_STATUS_VALUES = Object.freeze([
  'queued',
  'in_progress',
  'review',
  'done',
  'failed',
  'blocked',
  'canceled',
  'open'
] as const)

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number]

// The one priority list, next to the type it defines: the union type and the zod enum are both
// derived from it, so the accepted values and the type can never drift.
export const TASK_PRIORITIES = Object.freeze(['p0', 'p1', 'p2', 'p3'] as const)

export type TaskPriority = (typeof TASK_PRIORITIES)[number]

// The shapes a caller may write a priority in: the canonical "pN" string, the number N and the
// digit string "N". They all resolve to the canonical string through normalizePriority below.
export type TaskPriorityInput = TaskPriority | number | string

// The one refusal text for a priority outside the accepted set. The set is derived from the list
// above, so the message cannot drift from it.
// The text is BARE, like every other service refusal (src/core/guards.ts): the service carries it
// in a SvcError and formatError adds the code prefix (src/core/result.ts), while the schema layers
// add the `INVALID: ` prefix themselves. A message that carried the prefix as well would read
// "INVALID: INVALID: priority must be ..." on the service path.
export const PRIORITY_INVALID_MESSAGE =
  `priority must be one of ${TASK_PRIORITIES.join(', ')} or the number 0..${TASK_PRIORITIES.length - 1}`

// The one mapping from an accepted shape to the canonical string: "p2", 2 and "2" all become "p2".
// Every other value is refused (out of range, fractional, an unknown string, another type), so no
// caller can write a priority that breaks the queue order: the column is sorted lexicographically
// and only the canonical "pN" strings keep that order (p0 first, p3 last).
// The digit string is matched by shape (a single ASCII digit), never by parsing it: Number()
// trims whitespace and reads other Unicode decimal digits, so " " would become 0 and "٣" 3.
export function normalizePriority(value: unknown): TaskPriority | null {
  const last = TASK_PRIORITIES.length - 1
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > last) return null
    return `p${value}` as TaskPriority
  }
  if (typeof value === 'string') {
    const canonical = TASK_PRIORITIES.find(priority => priority === value)
    if (canonical) return canonical
    if (!/^[0-9]$/.test(value)) return null
    const digit = Number(value)
    if (digit > last) return null
    return `p${digit}` as TaskPriority
  }
  return null
}

// The type guard for the accepted shapes: the schema layers ask it, and it narrows an untrusted
// value to the accepted set. An absent priority is not one of them — the default takes its place.
export function isTaskPriorityInput(value: unknown): value is TaskPriorityInput {
  return normalizePriority(value) !== null
}

// The status a task is born with: a regular task starts queued, an epic starts open. The repo
// owns that rule and reports the status it wrote (src/db/repo.ts).
export type CreatedTaskStatus = 'queued' | 'open'

export interface Task {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assignee: string | null
  reporter: string
  depends_on: string
  attempts: number
  max_attempts: number
  lease_expires_at: string | null
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
  epic_id: number | null
  is_epic: boolean
  project: string | null
}

// Codes are the 1-based position in the canonical list; not_found is the only code outside it.
// Object.fromEntries cannot carry the key union, so the assertion restores the type the source
// list already proves (the keys are TASK_STATUS_VALUES plus not_found, nothing else).
export const STATUS_CODES = Object.freeze(
  Object.fromEntries([
    ['not_found', 0],
    ...TASK_STATUS_VALUES.map((status, index) => [status, index + 1])
  ])
) as Record<TaskStatus | 'not_found', number>

export const TASK_STATUSES = TASK_STATUS_VALUES

// The statuses in which a task may still be edited: the states in which nobody holds the contract yet.
// One list, next to TERMINAL_STATUSES — the guard, the write and the docs all read it.
export const EDITABLE_STATUSES: readonly TaskStatus[] = Object.freeze(['queued', 'open'])

export function statusToCode(status: TaskStatus | 'not_found'): number {
  return STATUS_CODES[status]
}

export function sanitizePipe(text: string): string {
  return text.replaceAll('|', '/')
}

export function pipeJoin(...fields: Array<string | number>): string {
  return fields.join('|')
}

export type CommentType = 'comment' | 'resolution'

// The legality graph: which transition is legal from which status. It is not the definition of
// "closed for work" — a status can carry one administrative edge out of it and still be closed.
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = Object.freeze({
  queued: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_progress', 'review', 'failed', 'blocked', 'canceled'],
  review: ['done', 'in_progress', 'failed', 'canceled'],
  done: [],
  // The administrative withdrawal: a failed task is closed for work, but it can be closed out.
  // It is never reopened — `failed -> queued`/`in_progress`/`review` stay illegal.
  failed: ['canceled'],
  blocked: ['queued', 'in_progress', 'review', 'canceled'],
  canceled: [],
  open: ['done', 'failed', 'canceled']
})

// Closed for work: no further work is expected on these tasks, so they carry a `completed_at`,
// hold no lease holder, and never block a dependent, a parent epic or an open count. The list is
// written out and NOT derived from the transition table: `failed` belongs here although the table
// gives it one outgoing edge (the administrative withdrawal), and deriving the set from "no
// outgoing edge" would silently drop `failed` and change every behaviour that reads this list.
export const TERMINAL_STATUSES: readonly TaskStatus[] = Object.freeze(['done', 'failed', 'canceled'])

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

// Clock contract: a pluggable time source. The default implementation is the process-wide monotonic
// clock below; tests may inject a deterministic clock or reset the global one.
export interface Clock {
  nowMs(): number
  nowIso(): string
}

export type MonotonicClock = Clock

// The single time source: every stamp is strictly greater than the previous one, even when two
// calls land in the same millisecond, so no ordering invariant depends on the wall clock ticking.
let lastTimestampMs = 0

export function monotonicNowMs(): number {
  const now = Date.now()
  const next = now > lastTimestampMs ? now : lastTimestampMs + 1
  lastTimestampMs = next
  return next
}

export function nowIso(): string {
  return new Date(monotonicNowMs()).toISOString()
}

// Test-only seam: reset the process-wide counter so a test file starts from a known state (the
// next stamp is the current wall clock again). Production code must never call it — the ordering
// guarantee (#1608) holds only for the stamps taken between two resets.
export function resetMonotonicClock(): void {
  lastTimestampMs = 0
}

// Normalize an unknown value into a Clock or null. This is the single place that says which clock
// shapes exist, and every clock consumer (TaskRepo, TaskService, LeaseReaper) normalizes through
// it, so they accept exactly this set:
//   - null / undefined              → no clock; the caller falls back to the process-wide source
//   - () => number                  → a bare nowMs function
//   - { nowIso(): string }          → nowIso as given; nowMs from nowMs/now/monotonicNowMs when
//                                    present, otherwise parsed out of nowIso()
//   - { nowMs(): number }           → nowIso is derived from nowMs
//   - { now(): number }             → alias of nowMs
//   - { monotonicNowMs(): number }  → alias of nowMs
//   - { clock: <any of the above> } → unwrapped and normalized
// Anything else → null (the caller falls back to the process-wide source).
export function asClock(input: unknown): Clock | null {
  if (input == null) return null
  if (typeof input === 'function') {
    const fn = input as () => number
    return { nowMs: fn, nowIso: () => new Date(fn()).toISOString() }
  }
  if (typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.clock !== 'undefined') return asClock(o.clock)
  if (typeof o.nowIso === 'function') {
    const nowIsoFn = (o.nowIso as () => string).bind(o)
    const nowMsFn = typeof o.nowMs === 'function'
      ? (o.nowMs as () => number).bind(o)
      : typeof o.now === 'function'
        ? (o.now as () => number).bind(o)
        : typeof o.monotonicNowMs === 'function'
          ? (o.monotonicNowMs as () => number).bind(o)
          : () => Date.parse(nowIsoFn())
    return { nowMs: nowMsFn, nowIso: nowIsoFn }
  }
  if (typeof o.nowMs === 'function' || typeof o.now === 'function' || typeof o.monotonicNowMs === 'function') {
    const nowMsFn = ((o.nowMs ?? o.now ?? o.monotonicNowMs) as () => number).bind(o)
    return { nowMs: nowMsFn, nowIso: () => new Date(nowMsFn()).toISOString() }
  }
  return null
}

export const defaultClock: Clock = {
  nowMs: monotonicNowMs,
  nowIso: nowIso
}

export const MAX_TITLE_LENGTH = 200
export const MAX_AGENT_LENGTH = 200
export const MAX_CONTENT_LENGTH = 10000
// A task description is the contract (goal, AC, constraints, deliverable), so it gets more room
// than a comment; `depends_on` is a list of ids and stays inside one batch read.
export const MAX_DESCRIPTION_LENGTH = 20000
export const MAX_DEPENDS_ON = 100
export const MAX_RESULT_LIMIT = 1000
export const MAX_SAFE_TIMESTAMP_MS = 8_640_000_000_000_000
// The ceiling of an internal pagination cursor (an OFFSET). A cursor must not be capped at the
// result ceiling: a scan that re-reads the same page never reaches the tail of the queue.
export const MAX_CURSOR_OFFSET = Number.MAX_SAFE_INTEGER

// The one unit every string bound is measured in: Unicode code points. JSON Schema defines a
// string's length in code points and zod v4 measures `maxLength` in code points too, so the
// advertised schema and the service guard count a string the same way. A code point is one UTF-16
// unit, except a surrogate pair (one code point, two units) — so the count is the unit count minus
// the surrogate pairs.
export function codePointLength(value: string): number {
  let count = value.length
  for (let i = 0; i < value.length - 1; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        count--
        i++
      }
    }
  }
  return count
}

function clampValue(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

// A user-facing result limit: the ceiling is the result ceiling, so no call site can widen it by
// accident and no cursor can be routed through it.
export function clampLimit(value: number | undefined, fallback: number): number {
  return clampValue(value, fallback, MAX_RESULT_LIMIT)
}

// An internal pagination cursor: the ceiling is the cursor ceiling, never the result ceiling.
export function clampCursor(value: number | undefined, fallback: number): number {
  return clampValue(value, fallback, MAX_CURSOR_OFFSET)
}
