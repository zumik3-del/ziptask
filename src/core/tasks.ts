// The one status list: the union type, the enum, the codes, the terminal set and the SQL list
// are all derived from it (the SQL text itself lives in src/db/sql.ts).
export const TASK_STATUS_VALUES = Object.freeze([
  'queued',
  'in_progress',
  'review',
  'done',
  'failed',
  'blocked',
  'canceled'
] as const)

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number]
export type TaskPriority = 'p0' | 'p1' | 'p2' | 'p3'

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

// The canonical tuple under its historical name: callers pass it to z.enum and iterate it.
export const TASK_STATUSES = TASK_STATUS_VALUES

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

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = Object.freeze({
  queued: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_progress', 'review', 'failed', 'blocked', 'canceled'],
  review: ['done', 'in_progress', 'failed', 'canceled'],
  done: [],
  failed: [],
  blocked: ['queued', 'in_progress', 'review', 'canceled'],
  canceled: []
})

// Terminal means "no outgoing transition": the transition table is the only place that says so,
// so a new status cannot be added to one list and forgotten in the other.
export const TERMINAL_STATUSES: readonly TaskStatus[] = Object.freeze(
  TASK_STATUS_VALUES.filter(status => VALID_TRANSITIONS[status].length === 0)
)

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
let globalClock: Clock | null = null

export function monotonicNowMs(): number {
  if (globalClock) return globalClock.nowMs()
  const now = Date.now()
  const next = now > lastTimestampMs ? now : lastTimestampMs + 1
  lastTimestampMs = next
  return next
}

export function nowIso(): string {
  if (globalClock) return globalClock.nowIso()
  return new Date(monotonicNowMs()).toISOString()
}

export function isoFromNow(offsetMs: number): string {
  return new Date(monotonicNowMs() + offsetMs).toISOString()
}

// Reset hook for tests: clears the monotonic high-water mark and any injected global clock.
export function resetMonotonicClock(): void {
  lastTimestampMs = 0
  globalClock = null
}
export const resetMonotonicNowMs = resetMonotonicClock
export const resetClock = resetMonotonicClock
export const resetMonotonic = resetMonotonicClock

// Inject a global clock for tests; pass null to restore the default monotonic clock.
export function setClock(clock: Clock | null): void {
  globalClock = clock
}
export const setMonotonicClock = setClock
export const useClock = setClock

// Normalize an unknown value into a Clock or null (shared by TaskRepo/TaskService/etc.).
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

// Default process-wide clock handle (reflects the global monotonic source).
export const defaultClock: Clock = {
  nowMs: monotonicNowMs,
  nowIso: nowIso
}

export const MAX_TITLE_LENGTH = 200
export const MAX_AGENT_LENGTH = 200
export const MAX_CONTENT_LENGTH = 10000
export const MAX_RESULT_LIMIT = 1000
export const MAX_SAFE_TIMESTAMP_MS = 8_640_000_000_000_000

export function clampLimit(value: number | undefined, fallback: number, max = MAX_RESULT_LIMIT): number {
  if (value === undefined) return fallback
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}
