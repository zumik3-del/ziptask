import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import taskTemplate from '../../templates/task-description.md' with { type: 'text' }
import epicTemplate from '../../templates/epic.md' with { type: 'text' }
import commentSuccessTemplate from '../../templates/comment-success.md' with { type: 'text' }
import commentFailureTemplate from '../../templates/comment-failure.md' with { type: 'text' }
import type { Task, TaskStatus, TaskPriority } from '../core/tasks'
import { statusToCode, sanitizePipe, pipeJoin, TASK_STATUSES, MAX_RESULT_LIMIT, MAX_SAFE_TIMESTAMP_MS } from '../core/tasks'
import { TASK_PRIORITIES } from '../defaults'
import type { TaskService } from '../core/service'
import type { SvcResult } from '../core/types'

const TEMPLATE_NAMES = ['task', 'epic', 'comment-success', 'comment-failure'] as const
type TemplateName = typeof TEMPLATE_NAMES[number]

// Keep API names stable; imports embed the markdown so the compiled binary works.
const TEMPLATES: Record<TemplateName, string> = {
  task: taskTemplate,
  epic: epicTemplate,
  'comment-success': commentSuccessTemplate,
  'comment-failure': commentFailureTemplate
}

function handleGetTemplate(_svc: TaskService, args: { name: TemplateName }): ToolResult {
  const unknown = rejectUnknownArgs('get_template', GET_TEMPLATE_SHAPE, args)
  if (unknown) return unknown
  const template = TEMPLATES[args.name]
  if (template === undefined) return errorResult(`Template not found: ${args.name}`)
  return textResult(template)
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

function toToolResult<T>(r: SvcResult<T>): ToolResult {
  return r.ok ? jsonResult(r.data) : errorResult(r.error)
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

// One shape literal per tool: registered as the advertised inputSchema and reused by
// rejectUnknownArgs (Object.keys), so schema and guard can never drift apart.
const CREATE_TASK_SHAPE = {
  title: z.string().describe('English, <=200 chars'),
  description: z.string().optional().describe('English; fill get_template("task") or "epic" first'),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: z.string().optional(),
  depends_on: z.array(z.number()).optional(),
  reporter: z.string().optional(),
  epic: z.boolean().optional().describe('Create as an epic (not claimable); description follows get_template("epic") with required Source'),
  epic_id: z.number().optional().describe('Attach as sub-task to an existing task')
}

const GET_TASK_SHAPE = {
  id: z.number(),
  fields: z.array(z.string()).optional()
}

const LIST_TASKS_SHAPE = {
  assignee: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional(),
  updated_since: z.number().finite().min(-MAX_SAFE_TIMESTAMP_MS).max(MAX_SAFE_TIMESTAMP_MS).optional(),
  epic_id: z.number().optional(),
  ids: z.array(z.number()).optional()
}

const CLAIM_TASK_SHAPE = {
  agent: z.string().optional().describe('agent name; defaults to "unknown" when omitted'),
  task_id: z.number().int().positive().optional(),
  id: z.number().int().positive().optional().describe('alias of task_id'),
  include: z.array(z.string()).optional(),
  lease_ttl_min: z.number().int().positive().optional().describe('lease TTL in minutes for this claim; overrides the server default for this claim only')
}

const UPDATE_STATUS_SHAPE = {
  id: z.number(),
  agent: z.string(),
  status: z.enum(TASK_STATUSES),
  version: z.number().optional().describe('optimistic lock; omit to skip the version check (a stale version still refuses)'),
  comment: z.string().optional().describe('typed resolution when done/failed/canceled'),
  renew: z.boolean().optional().describe('with status=in_progress on an in_progress task: re-arm your own lease (heartbeat, ~lease_ttl_min/3)'),
  reset_attempts: z.boolean().optional().describe('with any legal transition: zero attempts (refund a budget spent on accidents); requires comment, max_attempts untouched, echoes attempts in the response; not on epics, not on terminal tasks')
}

const LIST_QUEUE_SHAPE = {
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional()
}

const ADD_COMMENT_SHAPE = {
  id: z.number(),
  agent: z.string(),
  content: z.string().optional().describe('English; fill get_template("comment-success") or "comment-failure"'),
  text: z.string().optional().describe('alias of content'),
  comment: z.string().optional().describe('alias of content')
}

const GET_TIMELINE_SHAPE = {
  id: z.number(),
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional()
}

const GET_TEMPLATE_SHAPE = {
  name: z.enum(TEMPLATE_NAMES)
}

// First statement of every handler: the SDK strips unknown keys only for raw shapes, so
// catchall(z.unknown()) lets them reach us and we reject loudly instead of silently.
function rejectUnknownArgs(tool: string, shape: object, args: object): ToolResult | null {
  const accepted = Object.keys(shape).sort()
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k))
  if (unknown.length === 0) return null
  unknown.sort()
  return errorResult(
    `INVALID: unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} on ${tool} (accepted: ${accepted.join(', ')})`
  )
}

export function registerAllTools(server: McpServer, svc: TaskService) {
  server.registerTool('create_task', {
    description: 'Create task. Always queued; blocked is a manual flag only. Build description from get_template("task"); for epics use get_template("epic")',
    inputSchema: z.object(CREATE_TASK_SHAPE).catchall(z.unknown())
  }, async (args) => handleCreateTask(svc, args))

  server.registerTool('get_task', {
    description: 'Brief default: id,title,status,priority,blocked_by. description only via explicit fields; null fields omitted. version via fields:["version"]',
    inputSchema: z.object(GET_TASK_SHAPE).catchall(z.unknown())
  }, async (args) => handleGetTask(svc, args))

  server.registerTool('list_tasks', {
    description: 'Filters: assignee,status,updated_since(unix ms),epic_id(children of epic). ids batch-mode returns pipe id|code; assignee via fields:["assignee"]. description only via explicit fields',
    inputSchema: z.object(LIST_TASKS_SHAPE).catchall(z.unknown())
  }, async (args) => handleListTasks(svc, args))

  server.registerTool('claim_task', {
    description: 'Claim a task (auto-picks the best queued, or task_id — queued/blocked). id is an alias of task_id: id alone claims it, id equal to task_id is fine, id different from task_id is an INVALID conflict. agent is optional (defaults to "unknown"); lease_ttl_min overrides the server default lease for this claim only. include: extra fields in response',
    inputSchema: z.object(CLAIM_TASK_SHAPE).catchall(z.unknown())
  }, async (args) => handleClaimTask(svc, args))

  server.registerTool('update_status', {
    description: 'Transition status. Optimistic lock via version — read current version via get_task fields:["version"] (or from your claim response); on CONFLICT re-read version and retry, except CONFLICT: lease held by <other>, which means hand the task back to that agent. version is optional: when omitted the version check is skipped (a concurrent write still refuses with CONFLICT). canceled is terminal and withdraws any non-terminal task. A non-renewal status=in_progress needs claim-grade eligibility: refused for an epic (INVALID: #N is an epic, not claimable) and for unsatisfied dependencies when entering from queued/blocked (BLOCKED: dependencies not satisfied) — an epic is never leased, and claim_task is the door to a lease. renew:true with status=in_progress extends your own in_progress lease (heartbeat ~lease_ttl_min/3); the holder must match assignee and the version bumps. reset_attempts:true rides on any legal transition: zeroes attempts (budget refund, max_attempts untouched), requires a comment, and echoes attempts in the response; rejected on epics and on terminal tasks (a failed task is recovered by recreating it)',
    inputSchema: z.object(UPDATE_STATUS_SHAPE).catchall(z.unknown())
  }, async (args) => handleUpdateStatus(svc, args))

  server.registerTool('list_queue', {
    description: 'Deps-satisfied queued tasks, pipe lines id|priority|title',
    inputSchema: z.object(LIST_QUEUE_SHAPE).catchall(z.unknown())
  }, async (args) => handleListQueue(svc, args))

  server.registerTool('add_comment', {
    description: 'Add comment to task. Requires non-empty agent and content (content, or its alias text/comment); one-liner from get_template("comment-success") or "comment-failure"',
    inputSchema: z.object(ADD_COMMENT_SHAPE).catchall(z.unknown())
  }, async (args) => handleAddComment(svc, args))

  server.registerTool('get_timeline', {
    description: 'Merged audit_log + comments feed for a task, pipe seq|type|agent|at|text',
    inputSchema: z.object(GET_TIMELINE_SHAPE).catchall(z.unknown())
  }, async (args) => handleGetTimeline(svc, args))

  server.registerTool('get_template', {
    description: 'Return a markdown template by name',
    inputSchema: z.object(GET_TEMPLATE_SHAPE).catchall(z.unknown())
  }, async (args) => handleGetTemplate(svc, args))
}

export function handleCreateTask(svc: TaskService, args: {
  title: string
  description?: string
  priority?: TaskPriority
  assignee?: string
  depends_on?: number[]
  reporter?: string
  epic?: boolean
  epic_id?: number
}): ToolResult {
  const unknown = rejectUnknownArgs('create_task', CREATE_TASK_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.createTask(args))
}

export function handleGetTask(svc: TaskService, args: { id: number; fields?: string[] }): ToolResult {
  const unknown = rejectUnknownArgs('get_task', GET_TASK_SHAPE, args)
  if (unknown) return unknown
  const r = svc.getTaskView(args.id)
  if (!r.ok) return errorResult(r.error)
  const task = r.data.task
  const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'blocked_by']
  const result = pickFields(task, fields)
  if (fields.includes('blocked_by')) {
    result.blocked_by = r.data.blockedBy
  }
  // D3: derived subtasks roll-up for epics
  if (fields.includes('subtasks') && r.data.subtasks) {
    result.subtasks = r.data.subtasks
  }
  return jsonResult(result)
}

export function handleListTasks(svc: TaskService, args: {
  assignee?: string
  status?: string
  fields?: string[]
  limit?: number
  updated_since?: number
  epic_id?: number
  ids?: number[]
}): ToolResult {
  const unknown = rejectUnknownArgs('list_tasks', LIST_TASKS_SHAPE, args)
  if (unknown) return unknown
  if (args.ids !== undefined && args.ids.length > 0) {
    const withAssignee = args.fields?.includes('assignee') ?? false
    const batch = svc.listTasks({ ids: args.ids })
    if (!('items' in batch)) return errorResult('INVALID: ids batch mode')
    const lines = batch.items.map(({ id, task }) => {
      if (!task) return withAssignee ? pipeJoin(id, 0, '-') : pipeJoin(id, 0)
      const code = statusToCode(task.status)
      return withAssignee ? pipeJoin(id, code, task.assignee ?? '-') : pipeJoin(id, code)
    })
    return textResult(lines.join('\n'))
  }
  const result = svc.listTasks(args)
  if ('items' in result) return errorResult('INVALID: unexpected batch mode')
  const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'assignee']
  const tasks = result.tasks.map((task) => pickFields(task, fields))
  return jsonResult({ tasks, total: result.total })
}

export function handleClaimTask(svc: TaskService, args: {
  agent?: string
  task_id?: number
  id?: number
  include?: string[]
  lease_ttl_min?: number
}): ToolResult {
  const unknown = rejectUnknownArgs('claim_task', CLAIM_TASK_SHAPE, args)
  if (unknown) return unknown
  if (args.task_id !== undefined && args.id !== undefined && args.task_id !== args.id) {
    return errorResult(`INVALID: claim_task id/task_id conflict (id=${args.id} task_id=${args.task_id}); task_id is canonical`)
  }
  const taskId = args.task_id !== undefined ? args.task_id : args.id
  const r = svc.claimTask({ agent: args.agent ?? 'unknown', taskId, leaseTtlMin: args.lease_ttl_min })
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
  version?: number
  comment?: string
  renew?: boolean
  reset_attempts?: boolean
}): ToolResult {
  const unknown = rejectUnknownArgs('update_status', UPDATE_STATUS_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.updateStatus(args))
}

export function handleListQueue(svc: TaskService, args: { limit?: number }): ToolResult {
  const unknown = rejectUnknownArgs('list_queue', LIST_QUEUE_SHAPE, args)
  if (unknown) return unknown
  const ready = svc.listQueue(args)
  const lines = ready.map(t => pipeJoin(t.id, t.priority, sanitizePipe(t.title)))
  return textResult(lines.join('\n'))
}

export function handleAddComment(svc: TaskService, args: {
  id: number
  agent: string
  content?: string
  text?: string
  comment?: string
}): ToolResult {
  const unknown = rejectUnknownArgs('add_comment', ADD_COMMENT_SHAPE, args)
  if (unknown) return unknown
  // content is canonical; text/comment are forgiving aliases. An empty pick falls through to
  // the service's "content required" so that wording stays single-sourced.
  const content = args.content ?? args.text ?? args.comment
  return toToolResult(svc.addComment({ id: args.id, agent: args.agent, content: content ?? '' }))
}

export function handleGetTimeline(svc: TaskService, args: { id: number; limit?: number }): ToolResult {
  const unknown = rejectUnknownArgs('get_timeline', GET_TIMELINE_SHAPE, args)
  if (unknown) return unknown
  const r = svc.getTimeline(args.id, args.limit)
  if (!r.ok) return errorResult(r.error)
  const lines = r.data.map((row, i) => pipeJoin(i + 1, row.type, row.agent, row.created_at, sanitizePipe(row.text)))
  return textResult(lines.join('\n'))
}


