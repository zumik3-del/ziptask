import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test'
import { createLogger, normalizeError, parseLogLevel, type LogLevel } from './logger'

type JsonRecord = Record<string, unknown>

// Every record leaves the logger through the same single stderr write, so the capture
// lives here for the whole file instead of being copied into each describe below.
let writeSpy: ReturnType<typeof spyOn>
let chunks: string[]

beforeEach(() => {
  chunks = []
  writeSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    if (typeof chunk === 'string') chunks.push(chunk)
    return true
  })
})

afterEach(() => {
  writeSpy.mockRestore()
})

function drainLines(): string[] {
  const snapshot = [...chunks]
  chunks.length = 0
  return snapshot
}

function drain(): JsonRecord[] {
  return drainLines().map(line => JSON.parse(line) as JsonRecord)
}

describe('createLogger level gating', () => {
  function emitAll(log: ReturnType<typeof createLogger>): void {
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
  }

  test('off: nothing emits at any level', () => {
    emitAll(createLogger('off-test', 'off'))
    expect(drain()).toEqual([])
    expect(writeSpy).not.toHaveBeenCalled()
  })

  test('error: only error emits', () => {
    emitAll(createLogger('err-only', 'error'))
    expect(drain().map(r => ({ level: r.level, msg: r.msg }))).toEqual([
      { level: 'error', msg: 'e' }
    ])
  })

  test('warn: error and warn emit, info and debug suppressed', () => {
    emitAll(createLogger('warn-only', 'warn'))
    expect(drain().map(r => ({ level: r.level, msg: r.msg }))).toEqual([
      { level: 'error', msg: 'e' },
      { level: 'warn', msg: 'w' }
    ])
  })

  test('info: error, warn and info emit, debug suppressed', () => {
    emitAll(createLogger('info-level', 'info'))
    expect(drain().map(r => ({ level: r.level, msg: r.msg }))).toEqual([
      { level: 'error', msg: 'e' },
      { level: 'warn', msg: 'w' },
      { level: 'info', msg: 'i' }
    ])
  })

  test('debug: every level emits', () => {
    emitAll(createLogger('dbg', 'debug'))
    expect(drain().map(r => ({ level: r.level, msg: r.msg }))).toEqual([
      { level: 'error', msg: 'e' },
      { level: 'warn', msg: 'w' },
      { level: 'info', msg: 'i' },
      { level: 'debug', msg: 'd' }
    ])
  })

  test('the level is matched case-insensitively and without a warn record', () => {
    emitAll(createLogger('case', 'WARN'))
    expect(drain().map(r => r.level)).toEqual(['error', 'warn'])
  })
})

describe('createLogger record contract', () => {
  test('one stderr write and one JSON object per line, per call', () => {
    const log = createLogger('fmt', 'info')
    log.info('first')
    log.info('second')

    expect(writeSpy).toHaveBeenCalledTimes(2)
    const lines = drainLines()
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true)
      const body = line.trimEnd()
      // a second line inside one chunk would mean the record was not one JSON line
      expect(body.includes('\n')).toBe(false)
      expect(body.startsWith('{')).toBe(true)
      expect(body.endsWith('}')).toBe(true)
    }
  })

  test('a newline inside a field value is escaped, so the record stays one line and forges nothing', () => {
    const payload = '{"level":"error","logger":"forged","msg":"forged record"}'
    createLogger('forge', 'info').info('real', { agent: `evil\n${payload}` })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const lines = drainLines()
    expect(lines.length).toBe(1)
    // The newline left as the two-character escape \n, so the chunk is one physical line
    // and nothing after it can be read as a second record.
    expect(lines[0]!.endsWith('\n')).toBe(true)
    expect(lines[0]!.slice(0, -1).includes('\n')).toBe(false)
    expect(lines[0]!).toContain('\\n')

    const records = lines.map(line => JSON.parse(line) as JsonRecord)
    expect(records.length).toBe(1)
    expect(records[0]!.msg).toBe('real')
    expect(records[0]!.logger).toBe('forge')
    // ...and the value still round trips intact, so escaping loses no information.
    expect(records[0]!.agent).toBe(`evil\n${payload}`)
  })

  test('a newline inside msg or a stack is escaped too, keeping every record one parseable line', () => {
    const boom = new Error('boom')
    createLogger('forge2', 'info').info('real\n{"msg":"forged"}')
    createLogger('forge2', 'info').error('failed\n{"msg":"forged"}', boom)

    const lines = drainLines()
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line.slice(0, -1).includes('\n')).toBe(false)
    }
    const [injected, fromError] = lines.map(line => JSON.parse(line) as JsonRecord)
    expect(injected!.msg).toBe('real\n{"msg":"forged"}')
    // an Error stack is multi-line by nature, so it is the field most at risk
    expect((fromError!.stack as string).includes('\n')).toBe(true)
    expect(fromError!.stack as string).toBe(boom.stack as string)
    expect(fromError!.err).toBe('boom')
  })

  test('ts, level, logger and msg are present with the call values', () => {
    createLogger('my-module', 'info').info('hello')
    const [record] = drain()
    expect(Object.keys(record!).sort()).toEqual(['level', 'logger', 'msg', 'ts'])
    expect(record!.logger).toBe('my-module')
    expect(record!.level).toBe('info')
    expect(record!.msg).toBe('hello')
    // ISO-8601 and re-serializable: toISOString() on an unparsable ts would throw
    expect(new Date(record!.ts as string).toISOString()).toBe(record!.ts as string)
  })

  test('structured field values survive the JSON round trip', () => {
    createLogger('shapes', 'info').info('shapes', {
      count: 3,
      ok: true,
      tags: ['a', 'b'],
      nested: { a: 1 },
      missing: null
    })
    const [record] = drain()
    expect(record!.count).toBe(3)
    expect(record!.ok).toBe(true)
    expect(record!.tags).toEqual(['a', 'b'])
    expect(record!.nested).toEqual({ a: 1 })
    expect(record!.missing).toBeNull()
  })

  test('reserved keys win over both ctx and per-call fields', () => {
    createLogger('reserved', 'info')
      .child({ logger: 'fake-logger', ts: 'fake-ts', level: 'off', msg: 'fake-msg', tenant: 'acme' })
      .info('real', { logger: 'fake-logger', ts: 'fake-ts', level: 'debug', msg: 'fake-msg', port: 1 })

    const [record] = drain()
    expect(record!.logger).toBe('reserved')
    expect(record!.level).toBe('info')
    expect(record!.msg).toBe('real')
    expect(record!.ts).not.toBe('fake-ts')
    // non-reserved keys from ctx and fields still pass through
    expect(record!.tenant).toBe('acme')
    expect(record!.port).toBe(1)
    expect(Object.keys(record!).includes('fake-msg')).toBe(false)
  })

  test('reserved keys are emitted last, so a shadowing field cannot displace them', () => {
    createLogger('order', 'info').child({ tenant: 'acme' }).info('ordered', {
      level: 'debug',
      ts: 'fake-ts',
      port: 1
    })
    const [record] = drain()
    // Two defenses (stripping reserved keys, and writing them last) make the values
    // hold on their own; only the key order tells them apart, so pin it too.
    expect(Object.keys(record!)).toEqual(['tenant', 'port', 'logger', 'ts', 'level', 'msg'])
    expect(record!.level).toBe('info')
    expect(record!.ts).not.toBe('fake-ts')
  })

  test('writes to stderr, not stdout', () => {
    const log = createLogger('stream', 'info')
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
    log.info('check-stream')
    stdoutSpy.mockRestore()
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(drain()[0]!.msg).toBe('check-stream')
  })
})

describe('createLogger child contexts', () => {
  test('child merges its ctx into every record', () => {
    const log = createLogger('parent', 'info')
    const child = log.child({ taskId: 7 })
    child.info('a')
    child.error('b')
    const out = drain()
    expect(out.map(r => ({ level: r.level, msg: r.msg, taskId: r.taskId }))).toEqual([
      { level: 'info', msg: 'a', taskId: 7 },
      { level: 'error', msg: 'b', taskId: 7 }
    ])
  })

  test('child ctx does not leak back into the parent', () => {
    const log = createLogger('parent', 'info')
    log.child({ taskId: 7 }).info('from-child')
    log.info('from-parent')
    const out = drain()
    expect(out[0]!.taskId).toBe(7)
    expect(Object.keys(out[1]!).sort()).toEqual(['level', 'logger', 'msg', 'ts'])
  })

  test('a nested child merges both levels, the nearer one winning', () => {
    const log = createLogger('parent', 'info').child({ taskId: 7, session: 's1' })
    log.child({ taskId: 8 }).info('nested')
    const [record] = drain()
    expect(record!.taskId).toBe(8)
    expect(record!.session).toBe('s1')
    expect(record!.logger).toBe('parent')
  })

  test('per-call fields override the child ctx', () => {
    createLogger('parent', 'info').child({ taskId: 7 }).info('override', { taskId: 9 })
    expect(drain()[0]!.taskId).toBe(9)
  })
})

describe('createLogger error records', () => {
  test('an Error is reported as err message plus stack', () => {
    const boom = new Error('boom')
    createLogger('err', 'info').error('failed', boom)
    const [record] = drain()
    expect(record!.level).toBe('error')
    expect(record!.msg).toBe('failed')
    expect(record!.err).toBe('boom')
    expect(record!.stack).toBe(boom.stack as string)
    expect(record!.stack as string).toContain('boom')
  })

  test('a non-Error value is stringified into err and adds no stack', () => {
    createLogger('err', 'info').error('failed', 'just-a-string')
    const [record] = drain()
    expect(record!.err).toBe('just-a-string')
    expect(Object.keys(record!).includes('stack')).toBe(false)
  })

  test('the reported error wins over call-site fields named err or stack', () => {
    createLogger('err', 'info').error('failed', new Error('real'), { err: 'fake-err', stack: 'fake-stack' })
    const [record] = drain()
    expect(record!.err).toBe('real')
    expect(record!.stack).not.toBe('fake-stack')
  })

  test('error with a message only emits no err key', () => {
    createLogger('err', 'info').error('plain')
    const [record] = drain()
    expect(Object.keys(record!).sort()).toEqual(['level', 'logger', 'msg', 'ts'])
  })

  test('error without an error argument emits no err key', () => {
    createLogger('err', 'info').error('plain', undefined, { taskId: 1 })
    const [record] = drain()
    expect(record!.taskId).toBe(1)
    expect(Object.keys(record!).sort()).toEqual(['level', 'logger', 'msg', 'taskId', 'ts'])
  })

  test('a plain object in the second position is emitted as fields, not as err (signature pin)', () => {
    createLogger('err', 'info').error('fields-object', { taskId: 1, nested: { a: 1 } })
    const [record] = drain()
    expect(record!.taskId).toBe(1)
    expect(record!.nested).toEqual({ a: 1 })
    expect(Object.keys(record!).includes('err')).toBe(false)
    expect(Object.keys(record!).sort()).toEqual(['level', 'logger', 'msg', 'nested', 'taskId', 'ts'])
  })

  test('fields beside an Error survive, with err and stack still taken from the error', () => {
    const boom = new Error('boom')
    createLogger('err', 'info').error('failed', boom, { taskId: 42, tenant: 'acme' })
    const [record] = drain()
    expect(record!.err).toBe('boom')
    expect(record!.stack).toBe(boom.stack as string)
    expect(record!.taskId).toBe(42)
    expect(record!.tenant).toBe('acme')
  })

  test('null and an array in the error position are stringified into err, not read as fields', () => {
    const log = createLogger('err', 'info')
    log.error('null-thrown', null)
    log.error('array-thrown', [1, 2])
    const [nulled, arrayed] = drain()
    expect(nulled!.err).toBe('null')
    expect(arrayed!.err).toBe('1,2')
    // neither is an Error, so neither carries a stack
    expect(Object.keys(nulled!).includes('stack')).toBe(false)
    expect(Object.keys(arrayed!).includes('stack')).toBe(false)
  })
})

describe('normalizeError', () => {
  test('an Error passes through by identity, so error() still reports its message and stack', () => {
    const boom = new Error('boom')
    expect(normalizeError(boom)).toBe(boom)

    createLogger('norm', 'info').error('failed', normalizeError(boom))
    const [record] = drain()
    expect(record!.err).toBe('boom')
    expect(record!.stack).toBe(boom.stack as string)
  })

  test('a non-Error becomes a thrown field that keeps the value instead of String()-collapsing it', () => {
    const object = { code: 'E_CUSTOM', detail: 'not an Error' }
    expect(normalizeError(object)).toEqual({ thrown: object })

    createLogger('norm', 'info').error('failed', normalizeError(object))
    const [fromObject] = drain()
    expect(fromObject!.thrown).toEqual(object)
    // the err slot would have collapsed the object to "[object Object]"
    expect(Object.keys(fromObject!).includes('err')).toBe(false)
    expect(Object.keys(fromObject!).includes('stack')).toBe(false)

    createLogger('norm', 'info').error('failed', normalizeError('just-a-string'))
    const [fromString] = drain()
    expect(fromString!.thrown).toBe('just-a-string')
    expect(Object.keys(fromString!).includes('err')).toBe(false)
  })
})

describe('createLogger unserializable fields', () => {
  test('a circular field does not throw and falls back to fieldsUnserializable', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular

    expect(() => createLogger('circ', 'info').info('circular', { circular })).not.toThrow()
    const [record] = drain()
    expect(record!.level).toBe('info')
    expect(record!.msg).toBe('circular')
    expect(record!.logger).toBe('circ')
    expect(typeof record!.ts).toBe('string')
    expect(typeof record!.fieldsUnserializable).toBe('string')
    expect(record!.fieldsUnserializable as string).not.toBe('')
    expect(Object.keys(record!).includes('circular')).toBe(false)
  })

  test('a BigInt field falls back to fieldsUnserializable instead of throwing', () => {
    expect(() => createLogger('big', 'info').info('bigint', { size: 1n })).not.toThrow()
    const [record] = drain()
    expect(record!.msg).toBe('bigint')
    expect(typeof record!.fieldsUnserializable).toBe('string')
    expect(Object.keys(record!).includes('size')).toBe(false)
  })

  test('an unserializable ctx field is dropped the same way', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => createLogger('circ-ctx', 'debug').child({ circular }).info('ctx')).not.toThrow()
    const [record] = drain()
    expect(record!.msg).toBe('ctx')
    expect(typeof record!.fieldsUnserializable).toBe('string')
  })
})

describe('createLogger level parsing', () => {
  test('an unknown level falls back to info and warns once at construction', () => {
    const log = createLogger('bad-level', 'verbose')
    const out = drain()
    expect(out.length).toBe(1)
    expect(out[0]!.level).toBe('warn')
    expect(out[0]!.logger).toBe('bad-level')
    expect(out[0]!.msg).toBe('unknown log level requested, falling back to info')
    expect(out[0]!.requested).toBe('verbose')

    // the fallback is really the info gate, not an open level
    log.info('kept')
    log.debug('suppressed')
    expect(drain().map(r => r.msg)).toEqual(['kept'])
  })

  test('a case variant of a known level is not reported as unknown', () => {
    const log = createLogger('ok-level', 'DEBUG')
    expect(drain()).toEqual([])
    log.debug('kept')
    expect(drain().map(r => r.msg)).toEqual(['kept'])
  })
})

describe('parseLogLevel', () => {
  test('accepts every known level, case-insensitively', () => {
    for (const level of ['off', 'error', 'warn', 'info', 'debug'] as LogLevel[]) {
      expect(parseLogLevel(level)).toBe(level)
      expect(parseLogLevel(level.toUpperCase())).toBe(level)
    }
  })

  test('falls back to info for an unknown or empty value', () => {
    expect(parseLogLevel('verbose')).toBe('info')
    expect(parseLogLevel('warning')).toBe('info')
    expect(parseLogLevel('')).toBe('info')
    // not trimmed: a padded value is a typo, not a level
    expect(parseLogLevel(' warn ')).toBe('info')
  })
})

describe('createLogger type safety', () => {
  test('LogLevel union is exhaustive', () => {
    const levels: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug']
    for (const lvl of levels) {
      const log = createLogger(`type-${lvl}`, lvl)
      expect(typeof log.error).toBe('function')
      expect(typeof log.warn).toBe('function')
      expect(typeof log.info).toBe('function')
      expect(typeof log.debug).toBe('function')
      expect(typeof log.child).toBe('function')
    }
  })
})
