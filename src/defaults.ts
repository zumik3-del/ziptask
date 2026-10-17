export const SECOND_MS = 1000
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000

export const DEFAULT_DB_PATH = './data/ziptask.db'
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 0
export const DEFAULT_LEASE_TTL_MIN = 15
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_REAP_COOLDOWN_SEC = 60
export const DEFAULT_AUTO_CLAIM_CEILING = 10000
export const DEFAULT_HTTP_MAX_SESSIONS = 100
export const DEFAULT_HTTP_SESSION_TTL_MS = HOUR_MS
// Upper bound on a single request body read by peekInitialize: an unbounded body would let a
// client exhaust server memory before the JSON-RPC layer ever sees the payload.
export const DEFAULT_HTTP_MAX_BODY_BYTES = 1_048_576
export const DEFAULT_PRIORITY = 'p2'
export const DEFAULT_REPORTER = 'system'
export const DEFAULT_LIST_LIMIT = 50
export const DEFAULT_TIMELINE_LIMIT = 50
export const DEFAULT_QUEUE_LIMIT = 100
export const LOG_LEVELS = Object.freeze(['off', 'error', 'warn', 'info', 'debug'] as const)
export type LogLevel = (typeof LOG_LEVELS)[number]
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'
// Closed enum of the levels: kept under its historical name so settings.json validation
// (src/config.ts) imports it from here instead of the logging module.
export const LEVELS: readonly LogLevel[] = LOG_LEVELS
export const DEFAULT_AUDIT_LOG = true
export const SQLITE_BUSY_TIMEOUT_MS = 5000
export const CANDIDATES_PAGE_SIZE = 100
export const SESSION_CLEANUP_INTERVAL_MS = MINUTE_MS
export const TASK_PRIORITIES = Object.freeze(['p0', 'p1', 'p2', 'p3'] as const)

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }

export function matchLogLevel(raw: string): LogLevel | undefined {
  const normalized = raw.toLowerCase()
  return LOG_LEVELS.find(level => level === normalized)
}

// Level comparison lives next to the level list so a new level cannot be added without saying
// where it lands in the order.
export function logLevelEnabled(min: LogLevel, recordLevel: LogLevel): boolean {
  return min !== 'off' && LOG_LEVEL_ORDER[recordLevel] <= LOG_LEVEL_ORDER[min]
}
