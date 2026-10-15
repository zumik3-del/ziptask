import type { Task } from './tasks'
import type { SvcError } from './types'
import { MAX_TITLE_LENGTH, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH } from './tasks'

export function requiredError(value: string, field: string): SvcError | null {
  return value.trim() ? null : { code: 'INVALID', message: `${field} required` }
}

export function tooLongError(value: string, max: number, field: string): SvcError | null {
  return value.length > max ? { code: 'INVALID', message: `${field} too long` } : null
}

export function epicError(task: Task, message: string): SvcError | null {
  return task.is_epic ? { code: 'INVALID', message } : null
}

export const MAX_TITLE = MAX_TITLE_LENGTH
export const MAX_AGENT = MAX_AGENT_LENGTH
export const MAX_CONTENT = MAX_CONTENT_LENGTH
