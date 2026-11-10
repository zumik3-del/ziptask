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

export const TASK_PRIORITIES = Object.freeze(['p0', 'p1', 'p2', 'p3'] as const)

export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export type TaskPriorityInput = TaskPriority | number | string

export const PRIORITY_INVALID_MESSAGE = `priority must be one of ${TASK_PRIORITIES.join(', ')} or the number 0..${TASK_PRIORITIES.length - 1}`

export function normalizePriority(value: unknown): TaskPriority | null {
  const last = TASK_PRIORITIES.length - 1
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > last) return null
    return `p${value}` as TaskPriority
  }
  if (typeof value === 'string') {
    const canonical = TASK_PRIORITIES.find((priority) => priority === value)
    if (canonical) return canonical
    if (!/^[0-9]$/.test(value)) return null
    const digit = Number(value)
    if (digit > last) return null
    return `p${digit}` as TaskPriority
  }
  return null
}

export function isTaskPriorityInput(value: unknown): value is TaskPriorityInput {
  return normalizePriority(value) !== null
}

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

export const STATUS_CODES = Object.freeze(
  Object.fromEntries([
    ['not_found', 0],
    ...TASK_STATUS_VALUES.map((status, index) => [status, index + 1])
  ])
) as Record<TaskStatus | 'not_found', number>

export const TASK_STATUSES = TASK_STATUS_VALUES

// Named statuses for the write paths: a store spells `STATUS.queued` instead of the literal, so the
// vocabulary stays in this module and a typo is a compile error.
export const STATUS = Object.freeze({
  queued: 'queued',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  canceled: 'canceled',
  open: 'open'
} as const satisfies Record<TaskStatus, TaskStatus>)

export const EDITABLE_STATUSES: readonly TaskStatus[] = Object.freeze([STATUS.queued, STATUS.open])

export function statusToCode(status: TaskStatus | 'not_found'): number {
  return STATUS_CODES[status]
}

export function sanitizePipe(text: string): string {
  return text.replaceAll('|', '/').replace(/[\r\n]+/g, ' ')
}

export function pipeJoin(...fields: Array<string | number>): string {
  return fields.join('|')
}

export type CommentType = 'comment' | 'resolution'

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = Object.freeze({
  queued: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_progress', 'review', 'failed', 'blocked', 'canceled'],
  review: ['done', 'in_progress', 'failed', 'canceled'],
  done: [],
  // The administrative withdrawal: a failed task is closed for work, but it can be closed out.
  // It is never reopened — `failed -> queued`/`in_progress`/`review` stay illegal.
  failed: ['canceled'],
  blocked: ['queued', 'in_progress', 'canceled'],
  canceled: [],
  open: ['done', 'failed', 'canceled']
})

// Closed for work: no further work is expected on these tasks, so they carry a `completed_at`,
// hold no lease holder, and never block a dependent, a parent epic or an open count. The list is
// written out and NOT derived from the transition table: `failed` belongs here although the table
// gives it one outgoing edge (the administrative withdrawal), and deriving the set from "no
// outgoing edge" would silently drop `failed` and change every behaviour that reads this list.
export const TERMINAL_STATUSES: readonly TaskStatus[] = Object.freeze([
  'done',
  'failed',
  'canceled'
])

// The statuses a lease can be taken from: `claim_task` and a non-renewal `update_status` both accept
// a `queued` task and a manually parked `blocked` one, and both re-check `depends_on` on entry.
export const CLAIMABLE_STATUSES: readonly TaskStatus[] = Object.freeze([
  STATUS.queued,
  STATUS.blocked
])

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

export interface Clock {
  nowMs(): number
  nowIso(): string
}

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
//   - { nowIso(): string }          → nowIso as given; nowMs from nowMs when present, otherwise
//                                    parsed out of nowIso()
//   - { nowMs(): number }           → nowIso is derived from nowMs
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
    const nowMsFn =
      typeof o.nowMs === 'function'
        ? (o.nowMs as () => number).bind(o)
        : () => Date.parse(nowIsoFn())
    return { nowMs: nowMsFn, nowIso: nowIsoFn }
  }
  if (typeof o.nowMs === 'function') {
    const nowMsFn = (o.nowMs as () => number).bind(o)
    return { nowMs: nowMsFn, nowIso: () => new Date(nowMsFn()).toISOString() }
  }
  return null
}

export function clockNowMs(clock: Clock | null): number {
  return clock ? clock.nowMs() : monotonicNowMs()
}

export function clockNowIso(clock: Clock | null): string {
  return clock ? clock.nowIso() : nowIso()
}

export const MAX_TITLE_LENGTH = 200
export const MAX_AGENT_LENGTH = 200
export const MAX_CONTENT_LENGTH = 10000
export const MAX_DESCRIPTION_LENGTH = 20000
export const MAX_DEPENDS_ON = 100
export const MAX_RESULT_LIMIT = 1000
export const MAX_LEASE_TTL_MIN = 1440
export const LEASE_TTL_TOO_LARGE_MESSAGE = 'lease_ttl_min too large'
export const MAX_SAFE_TIMESTAMP_MS = 8_640_000_000_000_000
export const MAX_CURSOR_OFFSET = Number.MAX_SAFE_INTEGER

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

export function clampLimit(value: number | undefined, fallback: number): number {
  return clampValue(value, fallback, MAX_RESULT_LIMIT)
}

export function clampCursor(value: number | undefined, fallback: number): number {
  return clampValue(value, fallback, MAX_CURSOR_OFFSET)
}
