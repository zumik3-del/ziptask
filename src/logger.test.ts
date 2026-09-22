import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test'
import { createLogger, type LogLevel } from './logger'

describe('createLogger level gating', () => {
  let writeSpy: ReturnType<typeof spyOn>
  let outputs: string[]

  beforeEach(() => {
    outputs = []
    writeSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      if (typeof chunk === 'string') outputs.push(chunk)
      return true
    })
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  function drain(): string[] {
    const snapshot = [...outputs]
    outputs.length = 0
    return snapshot
  }

  test('off: nothing emits', () => {
    const log = createLogger('off-test', 'off')
    log.error('e')
    log.info('i')
    log.debug('d')
    expect(drain()).toEqual([])
    expect(writeSpy).not.toHaveBeenCalled()
  })

  test('error: only error emits; info and debug suppressed', () => {
    const log = createLogger('err-only', 'error')
    log.error('only-this')
    log.info('suppressed-info')
    log.debug('suppressed-debug')
    const out = drain()
    expect(out).toEqual(['[ziptask] [error] [err-only] only-this\n'])
  })

  test('info: error and info emit; debug suppressed', () => {
    const log = createLogger('info-level', 'info')
    log.error('err-msg')
    log.info('info-msg')
    log.debug('debug-msg')
    const out = drain()
    expect(out).toEqual([
      '[ziptask] [error] [info-level] err-msg\n',
      '[ziptask] [info] [info-level] info-msg\n'
    ])
  })

  test('debug: all levels emit', () => {
    const log = createLogger('dbg', 'debug')
    log.error('e')
    log.info('i')
    log.debug('d')
    const out = drain()
    expect(out).toEqual([
      '[ziptask] [error] [dbg] e\n',
      '[ziptask] [info] [dbg] i\n',
      '[ziptask] [debug] [dbg] d\n'
    ])
  })
})

describe('createLogger output format', () => {
  let writeSpy: ReturnType<typeof spyOn>
  let outputs: string[]

  beforeEach(() => {
    outputs = []
    writeSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      if (typeof chunk === 'string') outputs.push(chunk)
      return true
    })
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  function drain(): string[] {
    const snapshot = [...outputs]
    outputs.length = 0
    return snapshot
  }

  test('single-line per call, no extra whitespace', () => {
    const log = createLogger('fmt', 'info')
    log.info('hello')
    const line = drain()[0]!
    expect(line).toMatch(/^\[ziptask\] \[info\] \[fmt\] hello\n$/)
  })

  test('args appended as JSON after space', () => {
    const log = createLogger('args', 'info')
    log.info('prefix', 1, 'two')
    const line = drain()[0]!
    expect(line).toBe('[ziptask] [info] [args] prefix [1,"two"]\n')
  })

  test('no args: no trailing space', () => {
    const log = createLogger('no-args', 'info')
    log.info('plain')
    const line = drain()[0]!
    expect(line).toBe('[ziptask] [info] [no-args] plain\n')
    expect(line.endsWith(' \n')).toBe(false)
  })

  test('writes to stderr, not stdout', () => {
    const log = createLogger('stream', 'info')
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
    log.info('check-stream')
    stdoutSpy.mockRestore()
    expect(writeSpy).toHaveBeenCalled()
    const out = drain()
    expect(out.length).toBe(1)
    expect(out[0]).toContain('check-stream')
  })

  test('name injected into bracketed slot', () => {
    const log = createLogger('my-module', 'error')
    log.error('boom')
    const line = drain()[0]!
    expect(line).toContain('[my-module]')
  })
})

describe('createLogger type safety', () => {
  test('LogLevel union is exhaustive', () => {
    const levels: LogLevel[] = ['off', 'error', 'info', 'debug']
    for (const lvl of levels) {
      const log = createLogger(`type-${lvl}`, lvl)
      expect(typeof log.error).toBe('function')
      expect(typeof log.info).toBe('function')
      expect(typeof log.debug).toBe('function')
    }
  })
})
