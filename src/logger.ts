import { DEFAULT_LOG_LEVEL, LEVELS, type LogLevel, logLevelEnabled, matchLogLevel } from './defaults'

export type { LogLevel }
export type LogFields = Record<string, unknown>

// Re-exported for schema/enum consumers: LEVELS and LogLevel are owned by src/defaults.ts.
export { LEVELS }

type RecordLevel = Exclude<LogLevel, 'off'>
type LogRecord = LogFields & { logger: string; ts: string; level: RecordLevel; msg: string }

const RESERVED_KEYS = new Set(['logger', 'ts', 'level', 'msg'])

/**
 * Canonical error() contract, in one place:
 *
 *   error(msg)                -> the record carries no err/stack key at all
 *   error(msg, fields)        -> fields merge into the record (a plain object in the second
 *                                position is fields, never an err)
 *   error(msg, err, fields?)  -> err joins the record; fields are optional
 *
 * `err` is `unknown` because it normally comes from a catch or an `uncaughtException`
 * listener. An Error contributes its message and stack, anything else is String()-ified into
 * `err`; wrap a non-Error throw with normalizeError() to keep its shape instead.
 */
export interface Logger {
  error(msg: string): void
  error(msg: string, fields: LogFields): void
  error(msg: string, err: unknown, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

/**
 * Result of reading a configured level. The return type separates "recognised" from
 * "fallback" so the caller decides what a fallback means; `matched` is present exactly when
 * the configured value was recognised.
 */
export type LogLevelResolution =
  | { matched: true; level: LogLevel }
  | { matched: false; level: LogLevel; requested: string }

export function resolveLogLevel(raw: string): LogLevelResolution {
  const level = matchLogLevel(raw)
  return level === undefined ? { matched: false, level: DEFAULT_LOG_LEVEL, requested: raw } : { matched: true, level }
}

// Recognised level, or the info fallback for callers that only want the level.
export function parseLogLevel(raw: string): LogLevel {
  return resolveLogLevel(raw).level
}

// Reserved keys are dropped rather than spread: a call-site or child-context `logger`/`ts`/
// `level`/`msg` field must not be able to forge record metadata.
export function stripReservedKeys(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED_KEYS.has(key)) out[key] = value
  }
  return out
}

export function mergeContext(ctx: LogFields, fields: LogFields): LogFields {
  return { ...stripReservedKeys(ctx), ...stripReservedKeys(fields) }
}

export function serializeRecord(record: LogRecord): string {
  try {
    return JSON.stringify(record)
  } catch (err) {
    // A circular or BigInt field must not take the caller down with it (inside an http
    // handler that would turn a log line into a 500): keep the reserved keys and report that
    // the structured fields were dropped.
    return JSON.stringify({
      logger: record.logger,
      ts: record.ts,
      level: record.level,
      msg: record.msg,
      fieldsUnserializable: String(err)
    })
  }
}

// A throw site hands over `unknown`: an Error carries its own message and stack, anything else
// (a string, a plain object) only keeps its shape as a field, since String() would collapse an
// object to "[object Object]". Pass the result as the err argument of error(): an Error lands
// in the err slot, the fields object in the fields slot.
export function normalizeError(err: unknown): Error | LogFields {
  return err instanceof Error ? err : { thrown: err }
}

function errFields(err: unknown): LogFields {
  if (err instanceof Error) return { err: err.message, stack: err.stack }
  return { err: String(err) }
}

function isFieldsObject(value: unknown): value is LogFields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error)
}

function writeRecord(record: LogRecord): void {
  // stderr only: stdout carries the stdio MCP JSON-RPC stream, one log line breaks it.
  process.stderr.write(serializeRecord(record) + '\n')
}

export function createLogger(name: string, level: string): Logger {
  const resolved = resolveLogLevel(level)

  function build(ctx: LogFields): Logger {
    function emit(recordLevel: RecordLevel, msg: string, fields: LogFields): void {
      if (!logLevelEnabled(resolved.level, recordLevel)) return
      writeRecord({
        ...mergeContext(ctx, fields),
        logger: name,
        ts: new Date().toISOString(),
        level: recordLevel,
        msg
      })
    }

    return {
      error(msg: string, errOrFields?: unknown, fields?: LogFields) {
        if (fields === undefined && isFieldsObject(errOrFields)) {
          emit('error', msg, errOrFields)
          return
        }
        // errFields last, for the same reason the reserved keys go last: the failure being
        // reported must win over a call-site field named `err` or `stack`.
        const errPart = errOrFields === undefined ? {} : errFields(errOrFields)
        emit('error', msg, fields === undefined ? errPart : { ...fields, ...errPart })
      },
      warn(msg, fields = {}) {
        emit('warn', msg, fields)
      },
      info(msg, fields = {}) {
        emit('info', msg, fields)
      },
      debug(msg, fields = {}) {
        emit('debug', msg, fields)
      },
      child(fields) {
        return build({ ...ctx, ...fields })
      }
    }
  }

  const logger = build({})
  if (!resolved.matched) {
    logger.warn('unknown log level requested, falling back to info', { requested: resolved.requested })
  }
  return logger
}
