import { describe, test, expect } from 'bun:test'
import { ok, fail, foldResult, formatError } from './core/result'

describe('result helpers', () => {
  test('ok/fail build the tagged union (fail accepts code+message or an SvcError)', () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 })
    expect(fail('INVALID', 'title required')).toEqual({ ok: false, error: { code: 'INVALID', message: 'title required' } })
    expect(fail('NOT_FOUND')).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '' } })
    expect(fail({ code: 'CONFLICT', message: 'x' })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'x' } })
  })

  test('formatError reproduces the wire strings', () => {
    expect(formatError({ code: 'NOT_FOUND', message: '' })).toBe('NOT_FOUND:')
    expect(formatError({ code: 'INVALID', message: 'title required' })).toBe('INVALID: title required')
    expect(formatError({ code: 'CHILDREN', message: '2 sub-tasks not terminal' })).toBe('CHILDREN: 2 sub-tasks not terminal')
  })

  test('fold touches only the ok branch', () => {
    expect(foldResult(ok(2), (n) => `v${n}`, () => 'err')).toBe('v2')
    expect(foldResult(fail<number>('EMPTY', 'x'), (n) => `v${n}`, (e) => e.code)).toBe('EMPTY')
  })
})
