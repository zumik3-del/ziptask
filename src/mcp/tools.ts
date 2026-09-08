import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import type { Task, TaskStatus, TaskPriority } from '../core/tasks'
import { statusToCode, sanitizePipe, pipeJoin, TASK_STATUSES, TASK_PRIORITIES } from '../core/tasks'
import type { TaskService } from '../core/service'

const TEMPLATE_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'templates')
const TEMPLATE_NAMES = ['task', 'comment-success', 'comment-failure'] as const
type TemplateName = typeof TEMPLATE_NAMES[number]

// Keep API names stable; map to on-disk filenames where they differ.
const FILE_NAME: Record<string, string> = { task: 'task-description' }

function readTemplate(name: string): string {
  const path = resolve(TEMPLATE_DIR, `${FILE_NAME[name] ?? name}.md`)
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    throw new Error(`Template not found: ${name}`)
  }
}

function handleGetTemplate(_svc: TaskService, args: { name: TemplateName }): ToolResult {
  try {
    return textResult(readTemplate(args.name))
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e))
  }
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }], isError: true }
}

function pickFields(src: Task, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (f in src) {
      const v = (src as unknown as Record<string, unknown>)[f]
      if (v !== null && v !== undefined) out[f] = v
    }
  }
  return out
}

export function registerAllTools(server: McpServer, svc: TaskService) {
  server.tool('create_task', 'Create task. Always queued; blocked is a manual flag only', {
    title: z.string().describe('English, <=200 chars'),
    description: z.string().optional().describe('English'),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assignee: z.string().optional(),
    depends_on: z.array(z.number()).optional(),
    reporter: z.string().optional()
  }, async (args) => handleCreateTask(svc, args))

  server.tool('get_task', 'Brief default: id,title,status,priority,blocked_by. description only via explicit fields; null fields omitted. version via fields:["version"]', {
    id: z.number(),
    fields: z.array(z.string()).optional()
  }, async (args) => handleGetTask(svc, args))

  server.tool('list_tasks', 'Filters: assignee,status,updated_since(unix ms). description only via explicit fields', {
    assignee: z.string().optional(),
    status: z.string().optional(),
    fields: z.array(z.string()).optional(),
    limit: z.number().optional(),
    updated_since: z.number().optional()
  }, async (args) => handleListTasks(svc, args))

  server.tool('claim_task', 'Claim queued task (auto-picks best, or task_id). include: extra fields in response', {
    agent: z.string(),
    task_id: z.number().optional(),
    include: z.array(z.string()).optional()
  }, async (args) => handleClaimTask(svc, args))

  server.tool('update_status', 'Transition status. Optimistic lock via version — read current version via get_task fields:["version"] (or from your claim response); on CONFLICT re-read version and retry', {
    id: z.number(),
    agent: z.string(),
    status: z.enum(TASK_STATUSES),
    version: z.number(),
    comment: z.string().optional().describe('typed resolution when done/failed')
  }, async (args) => handleUpdateStatus(svc, args))

  server.tool('batch_statuses', 'Pipe lines id|code (0=not_found 1=queued 2=in_progress 3=review 4=done 5=failed 6=blocked); include:["assignee"] adds assignee (- if null)', {
    ids: z.array(z.number()),
    include: z.array(z.string()).optional()
  }, async (args) => handleBatchStatuses(svc, args))

  server.tool('list_queue', 'Deps-satisfied queued tasks, pipe lines id|priority|title', {
    limit: z.number().optional()
  }, async (args) => handleListQueue(svc, args))

  server.tool('add_comment', 'Add comment to task. Requires non-empty agent and content', {
    id: z.number(),
    agent: z.string(),
    content: z.string()
  }, async (args) => handleAddComment(svc, args))

  server.tool('get_timeline', 'Merged audit_log + comments feed for a task, pipe seq|type|agent|at|text', {
    id: z.number(),
    limit: z.number().optional()
  }, async (args) => handleGetTimeline(svc, args))

  server.tool('get_template', 'Return a markdown template by name', {
    name: z.enum(TEMPLATE_NAMES)
  }, async (args) => handleGetTemplate(svc, args))

  server.tool('metrics', 'Aggregated stats: done_count, status_time per status, bottleneck. period=hours (default 24) or all', {
    period: z.union([z.number().positive(), z.literal('all')]).optional()
  }, async (args) => handleMetrics(svc, args))
}

export function handleCreateTask(svc: TaskService, args: {
  title: string
  description?: string
  priority?: TaskPriority
  assignee?: string
  depends_on?: number[]
  reporter?: string
}): ToolResult {
  const r = svc.createTask(args)
  return r.ok ? jsonResult(r.data) : errorResult(r.error)
}

export function handleGetTask(svc: TaskService, args: { id: number; fields?: string[] }): ToolResult {
  const r = svc.getTaskView(args.id)
  if (!r.ok) return errorResult(r.error)
  const task = r.data.task
  const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'blocked_by']
  const result = pickFields(task, fields)
  if (fields.includes('blocked_by')) {
    result.blocked_by = r.data.blockedBy
  }
  return jsonResult(result)
}

export function handleListTasks(svc: TaskService, args: {
  assignee?: string
  status?: string
  fields?: string[]
  limit?: number
  updated_since?: number
}): ToolResult {
  const result = svc.listTasks(args)
  const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'assignee']
  const tasks = result.tasks.map(task => pickFields(task, fields))
  return jsonResult({ tasks, total: result.total })
}

export function handleClaimTask(svc: TaskService, args: {
  agent: string
  task_id?: number
  include?: string[]
}): ToolResult {
  const r = svc.claimTask(args)
  if (!r.ok) return errorResult(r.error)
  const { id, leaseTtlMin, task } = r.data
  const result: Record<string, unknown> = { id, lease_ttl_min: leaseTtlMin, version: task.version }
  Object.assign(result, pickFields(task, args.include ?? []))
  return jsonResult(result)
}

export function handleUpdateStatus(svc: TaskService, args: {
  id: number
  agent: string
  status: TaskStatus
  version: number
  comment?: string
}): ToolResult {
  const r = svc.updateStatus(args)
  return r.ok ? jsonResult(r.data) : errorResult(r.error)
}

export function handleBatchStatuses(svc: TaskService, args: { ids: number[]; include?: string[] }): ToolResult {
  const withAssignee = args.include?.includes('assignee') ?? false
  const items = svc.batchStatuses(args.ids)
  const lines = items.map(({ id, task }) => {
    if (!task) return withAssignee ? pipeJoin(id, 0, '-') : pipeJoin(id, 0)
    const code = statusToCode(task.status)
    return withAssignee ? pipeJoin(id, code, task.assignee ?? '-') : pipeJoin(id, code)
  })
  return textResult(lines.join('\n'))
}

export function handleListQueue(svc: TaskService, args: { limit?: number }): ToolResult {
  const ready = svc.listQueue(args)
  const lines = ready.map(t => pipeJoin(t.id, t.priority, sanitizePipe(t.title)))
  return textResult(lines.join('\n'))
}

export function handleAddComment(svc: TaskService, args: { id: number; agent: string; content: string }): ToolResult {
  const r = svc.addComment(args)
  return r.ok ? jsonResult(r.data) : errorResult(r.error)
}

export function handleGetTimeline(svc: TaskService, args: { id: number; limit?: number }): ToolResult {
  const r = svc.getTimeline(args.id, args.limit)
  if (!r.ok) return errorResult(r.error)
  const lines = r.data.map((row, i) => pipeJoin(i + 1, row.type, row.agent, row.created_at, sanitizePipe(row.text)))
  return textResult(lines.join('\n'))
}

export function handleMetrics(svc: TaskService, args: { period?: number | 'all' }): ToolResult {
  const r = svc.metrics(args.period)
  if (!r.ok) return errorResult(r.error)
  const m = r.data
  const lines: string[] = [`done_count|${m.doneCount}`]
  for (const [status, mins] of Object.entries(m.statusTime).sort()) {
    lines.push(`status_time|${status}:${Math.round(mins)}`)
  }
  if (m.bottleneck) {
    lines.push(`bottleneck|${m.bottleneck.status}:${Math.round(m.bottleneck.minutes)}`)
  }
  return textResult(lines.join('\n'))
}
