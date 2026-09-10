export type TaskStatus = 'queued' | 'in_progress' | 'review' | 'done' | 'failed' | 'blocked' | 'canceled'
export type TaskPriority = 'p0' | 'p1' | 'p2' | 'p3'

export interface Task {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  assignee: string | null
  reporter: string
  depends_on: string
  attempts: number
  max_attempts: number
  lease_expires_at: string | null
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
  epic_id: number | null
  is_epic: number
}

export const STATUS_CODES: Record<TaskStatus | 'not_found', number> = {
  not_found: 0,
  queued: 1,
  in_progress: 2,
  review: 3,
  done: 4,
  failed: 5,
  blocked: 6,
  canceled: 7
}

export const TASK_STATUSES = ['queued', 'in_progress', 'review', 'done', 'failed', 'blocked', 'canceled'] as const
export const TASK_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const

export function statusToCode(status: TaskStatus | 'not_found'): number {
  return STATUS_CODES[status] ?? 0
}

export function sanitizePipe(text: string): string {
  return text.replaceAll('|', '/')
}

export function pipeJoin(...fields: Array<string | number>): string {
  return fields.join('|')
}

export type CommentType = 'comment' | 'resolution'

export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'canceled']

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['review', 'failed', 'blocked', 'canceled'],
  review: ['done', 'in_progress', 'failed', 'canceled'],
  done: [],
  failed: [],
  blocked: ['queued', 'in_progress', 'review', 'canceled'],
  canceled: []
}

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

export function nowIso(): string {
  return new Date().toISOString()
}

export const MAX_RESULT_LIMIT = 1000

export function clampLimit(value: number | undefined, fallback: number, max = MAX_RESULT_LIMIT): number {
  if (value === undefined) return fallback
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}
