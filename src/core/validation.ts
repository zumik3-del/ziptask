import { codePointLength, type Task } from './tasks'
import type { SvcError } from './types'

export function requiredError(value: string | null | undefined, field: string): SvcError | null {
  return value?.trim() ? null : { code: 'INVALID', message: `${field} required` }
}

// A value that is not a string has no length to measure: it is refused as missing, never measured.
// The refusal is the ordinary "<field> required", so a null never crashes the guard on its length.
// The length is counted in code points (`codePointLength`), the unit the advertised schema measures
// in, so both layers refuse the same strings.
export function tooLongError(value: string | null | undefined, max: number, field: string): SvcError | null {
  if (value === null || value === undefined) return requiredError(value, field)
  return codePointLength(value) > max ? { code: 'INVALID', message: `${field} too long` } : null
}

// The guard for an optional field: absent (undefined) passes, a present value is checked — a null
// is refused as missing, a string over the limit is refused as too long.
export function optionalFieldError(value: string | null | undefined, max: number, field: string): SvcError | null {
  if (value === undefined) return null
  return tooLongError(value, max, field)
}

export function epicError(task: Task, message: string): SvcError | null {
  return task.is_epic ? { code: 'INVALID', message } : null
}
