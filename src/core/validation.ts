import type { Task } from './tasks'
import type { SvcError } from './types'

export function requiredError(value: string, field: string): SvcError | null {
  return value.trim() ? null : { code: 'INVALID', message: `${field} required` }
}

export function tooLongError(value: string, max: number, field: string): SvcError | null {
  return value.length > max ? { code: 'INVALID', message: `${field} too long` } : null
}

export function epicError(task: Task, message: string): SvcError | null {
  return task.is_epic ? { code: 'INVALID', message } : null
}
