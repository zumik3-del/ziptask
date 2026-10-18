import { z } from 'zod/v4'
import type { Task } from '../core/tasks'
import type { SvcResult, SvcError } from '../core/types'
import { foldResult, formatError } from '../core/result'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

export function errorResult(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }], isError: true }
}

export function errorTool(error: SvcError): ToolResult {
  return errorResult(formatError(error))
}

export function toToolResult<T>(r: SvcResult<T>): ToolResult {
  return foldResult(r, jsonResult, errorTool)
}

export function pickFields(src: Task, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f in src) {
      const v = (src as unknown as Record<string, unknown>)[f]
      if (v !== null && v !== undefined) out[f] = v
    }
  }
  return out
}

// One shape literal per tool: registered as the advertised inputSchema and reused by
// rejectUnknownArgs (Object.keys), so schema and guard can never drift apart.
// `project` is optional in the four enumerating shapes (the SDK must not pre-empt the refusal
// text) and enforced in the service; by-id shapes do not declare it at all.
export const PROJECT_ARG = z.string().optional().describe('project slug; required on every enumerating call (no default, no all-projects mode)')

// Shared by every task-id-ish argument, so a fractional or non-positive id is refused by the
// schema instead of reaching the service and surfacing as NOT_FOUND.
export const TaskId = z.number().int().positive()

export function rejectUnknownArgs(tool: string, shape: object, args: object): ToolResult | null {
  const accepted = Object.keys(shape).sort()
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k))
  if (unknown.length === 0) return null
  unknown.sort()
  return errorResult(
    `INVALID: unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} on ${tool} (accepted: ${accepted.join(', ')})`
  )
}

// Re-exports for convenience
export type { Task, TaskStatus, TaskPriority } from '../core/tasks'
export { statusToCode, sanitizePipe, pipeJoin, TASK_STATUSES, MAX_RESULT_LIMIT, MAX_SAFE_TIMESTAMP_MS } from '../core/tasks'
export { TASK_PRIORITIES } from '../defaults'
export type { TaskService } from '../core/service'
export type { SvcResult, SvcError } from '../core/types'
export { foldResult, formatError } from '../core/result'
