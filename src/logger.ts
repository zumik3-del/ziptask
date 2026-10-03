export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug'
export type LogFields = Record<string, unknown>

const LEVELS: readonly LogLevel[] = ['off', 'error', 'warn', 'info', 'debug']
const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }
const RESERVED_KEYS = new Set(['logger', 'ts', 'level', 'msg'])

export interface Logger {
  // Overloaded so a plain fields object cannot silently land in the err slot and be
  // stringified to "[object Object]": the second argument is fields unless it is
  // something an error can be (Error, or unknown from a catch).
  error(msg: string): void
  error(msg: string, fields: LogFields): void
  error(msg: string, err: unknown, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

function matchLevel(raw: string): LogLevel | undefined {
  const normalized = raw.toLowerCase()
  return LEVELS.find(level => level === normalized)
}

export function parseLogLevel(raw: string): LogLevel {
  return matchLevel(raw) ?? 'info'
}

function errFields(err: unknown): LogFields {
  if (err instanceof Error) return { err: err.message, stack: err.stack }
  return { err: String(err) }
}

// A throw site hands over `unknown`: an Error carries its own message and stack, anything
// else (a string, a plain object) only keeps its shape as a field, since String() would
// collapse an object to "[object Object]". Pass the result as the err argument of error():
// an Error lands in the err slot, the fields object in the fields slot.
export function normalizeError(err: unknown): Error | LogFields {
  return err instanceof Error ? err : { thrown: err }
}

function isFieldsObject(value: unknown): value is LogFields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error)
}

function unreserved(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED_KEYS.has(key)) out[key] = value
  }
  return out
}

export function createLogger(name: string, level: string): Logger {
  const min = parseLogLevel(level)

  function build(ctx: LogFields): Logger {
    const base = unreserved(ctx)

    function emit(recordLevel: Exclude<LogLevel, 'off'>, msg: string, fields: LogFields): void {
      if (min === 'off' || LEVEL_ORDER[recordLevel] > LEVEL_ORDER[min]) return
      const ts = new Date().toISOString()
      const record = { ...base, ...unreserved(fields), logger: name, ts, level: recordLevel, msg }
      let line: string
      try {
        line = JSON.stringify(record)
      } catch (err) {
        // A circular or BigInt field must not take the caller down with it (inside an
        // http handler that would turn a log line into a 500): keep the reserved keys
        // and report that the structured fields were dropped.
        line = JSON.stringify({ logger: name, ts, level: recordLevel, msg, fieldsUnserializable: String(err) })
      }
      // stderr only: stdout carries the stdio MCP JSON-RPC stream, one log line breaks it.
      process.stderr.write(line + '\n')
    }

    return {
      error(msg: string, errOrFields?: unknown, fields?: LogFields) {
        if (fields === undefined && isFieldsObject(errOrFields)) {
          emit('error', msg, errOrFields)
          return
        }
        // errFields last for the same reason the reserved keys go last: the failure being
        // reported must win over a call-site field named `err` or `stack`. No err key at
        // all when nothing was passed, instead of `err: "undefined"`.
        emit('error', msg, errOrFields === undefined ? (fields ?? {}) : { ...fields, ...errFields(errOrFields) })
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
  if (matchLevel(level) === undefined) {
    logger.warn('unknown log level requested, falling back to info', { requested: level })
  }
  return logger
}
