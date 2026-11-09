import { codePointLength, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH, type Task } from './tasks'
import type { SvcError } from './types'

export function requiredError(value: string | null | undefined, field: string): SvcError | null {
  return value?.trim() ? null : { code: 'INVALID', message: `${field} required` }
}

export function tooLongError(
  value: string | null | undefined,
  max: number,
  field: string
): SvcError | null {
  if (value === null || value === undefined) return requiredError(value, field)
  return codePointLength(value) > max ? { code: 'INVALID', message: `${field} too long` } : null
}

export function optionalFieldError(
  value: string | null | undefined,
  max: number,
  field: string
): SvcError | null {
  if (value === undefined) return null
  return tooLongError(value, max, field)
}

export function epicError(task: Task, message: string): SvcError | null {
  return task.is_epic ? { code: 'INVALID', message } : null
}

export function agentError(agent: string): SvcError | null {
  return requiredError(agent, 'agent') ?? tooLongError(agent, MAX_AGENT_LENGTH, 'agent')
}

export function textError(value: string, field: string): SvcError | null {
  return requiredError(value, field) ?? tooLongError(value, MAX_CONTENT_LENGTH, field)
}
