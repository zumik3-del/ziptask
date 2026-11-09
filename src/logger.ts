import { DEFAULT_LOG_LEVEL, type LogLevel, logLevelEnabled, matchLogLevel } from './defaults'

export type { LogLevel }
export type LogFields = Record<string, unknown>

type RecordLevel = Exclude<LogLevel, 'off'>
type LogRecord = LogFields & { logger: string; ts: string; level: RecordLevel; msg: string }

const RESERVED_KEYS = new Set(['logger', 'ts', 'level', 'msg'])

export interface Logger {
  error(msg: string): void
  error(msg: string, fields: LogFields): void
  error(msg: string, err: unknown, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

type LogLevelResolution =
  | { matched: true; level: LogLevel }
  | { matched: false; level: LogLevel; requested: string }

function resolveLogLevel(raw: string): LogLevelResolution {
  const level = matchLogLevel(raw)
  return level === undefined
    ? { matched: false, level: DEFAULT_LOG_LEVEL, requested: raw }
    : { matched: true, level }
}

export function parseLogLevel(raw: string): LogLevel {
  return resolveLogLevel(raw).level
}

function stripReservedKeys(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED_KEYS.has(key)) out[key] = value
  }
  return out
}

function mergeContext(ctx: LogFields, fields: LogFields): LogFields {
  return { ...stripReservedKeys(ctx), ...stripReservedKeys(fields) }
}

function serializeRecord(record: LogRecord): string {
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

export function normalizeError(err: unknown): Error | LogFields {
  return err instanceof Error ? err : { thrown: err }
}

function errFields(err: unknown): LogFields {
  if (err instanceof Error) return { err: err.message, stack: err.stack }
  return { err: String(err) }
}

function isFieldsObject(value: unknown): value is LogFields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  )
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
    logger.warn('unknown log level requested, falling back to info', {
      requested: resolved.requested
    })
  }
  return logger
}
