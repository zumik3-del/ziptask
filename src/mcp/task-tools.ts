import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import type { TaskStatus, TaskPriority } from '../core/tasks'
import { statusToCode, sanitizePipe, pipeJoin, TASK_STATUSES, TASK_PRIORITIES, MAX_RESULT_LIMIT, MAX_SAFE_TIMESTAMP_MS, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_AGENT_LENGTH, MAX_DEPENDS_ON } from '../core/tasks'
import { foldResult } from '../core/result'
import {
  type ToolResult, jsonResult, textResult, errorResult, errorTool, toToolResult, pickFields, rejectUnknownArgs,
  PROJECT_ARG, TaskId
} from './common'

// A string bound is counted in code points in both layers: zod v4 measures `maxLength` in code
// points, and the create guard measures the same way (`codePointLength`), so the schema and the
// guard refuse the same strings. `depends_on` counts ids — an array length, which both layers
// count identically. The actor names carry the bound the guard enforces on them
// (MAX_AGENT_LENGTH): every string field the guard bounds is bounded here too, so the advertised
// schema never understates what the service refuses.
const CREATE_TASK_SHAPE = {
  title: z.string().max(MAX_TITLE_LENGTH, 'INVALID: title too long').describe('English, <=200 code points'),
  description: z.string().max(MAX_DESCRIPTION_LENGTH, 'INVALID: description too long').optional().describe('English; fill get_template("task") or "epic" first; <=20000 code points'),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignee: z.string().max(MAX_AGENT_LENGTH, 'INVALID: assignee too long').optional().describe('refused at creation: a task holds a lease only from in_progress; the claim writes the holder; <=200 code points'),
  depends_on: z.array(TaskId).max(MAX_DEPENDS_ON, 'INVALID: depends_on too long').optional(),
  reporter: z.string().max(MAX_AGENT_LENGTH, 'INVALID: reporter too long').optional().describe('<=200 code points'),
  epic: z.boolean().optional().describe('Create as an epic (not claimable); description follows get_template("epic") with required Source'),
  epic_id: TaskId.optional().describe('Attach as sub-task to an existing task'),
  project: PROJECT_ARG
}

const GET_TASK_SHAPE = {
  id: TaskId,
  fields: z.array(z.string()).optional()
}

const LIST_TASKS_SHAPE = {
  assignee: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional(),
  updated_since: z.number().finite().min(-MAX_SAFE_TIMESTAMP_MS).max(MAX_SAFE_TIMESTAMP_MS).optional(),
  epic_id: TaskId.optional(),
  is_epic: z.boolean().optional(),
  ids: z.array(z.number().int()).max(MAX_RESULT_LIMIT).optional(),
  project: PROJECT_ARG
}

const CLAIM_TASK_SHAPE = {
  agent: z.string().optional().describe('agent name; defaults to "unknown" when omitted'),
  task_id: TaskId.optional(),
  id: TaskId.optional().describe('alias of task_id'),
  include: z.array(z.string()).optional(),
  lease_ttl_min: z.number().int().positive().optional().describe('lease TTL in minutes for this claim; overrides the server default for this claim only'),
  project: PROJECT_ARG
}

const UPDATE_STATUS_SHAPE = {
  id: TaskId,
  agent: z.string(),
  status: z.enum(TASK_STATUSES),
  version: z.number().int().optional().describe('optimistic lock; omit to skip the version check (a stale version still refuses)'),
  comment: z.string().optional().describe('typed resolution when done/failed/canceled'),
  renew: z.boolean().optional().describe('with status=in_progress on an in_progress task: re-arm your own lease (heartbeat, ~lease_ttl_min/3)'),
  reset_attempts: z.boolean().optional().describe('with any legal transition: zero attempts (budget refund, max_attempts untouched), requires comment, max_attempts untouched, echoes attempts in the response; not on epics, not on tasks closed for work')
}

const LIST_QUEUE_SHAPE = {
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional(),
  project: PROJECT_ARG
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
  project?: string
}): ToolResult {
  const unknown = rejectUnknownArgs('create_task', CREATE_TASK_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.createTask(args))
}

export function handleGetTask(svc: TaskService, args: { id: number; fields?: string[] }): ToolResult {
  const unknown = rejectUnknownArgs('get_task', GET_TASK_SHAPE, args)
  if (unknown) return unknown
  return foldResult(svc.getTaskView(args.id), (data) => {
    const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'blocked_by']
    const result = pickFields(data.task, fields)
    if (fields.includes('blocked_by')) {
      result.blocked_by = data.blockedBy
    }
    // D3: derived subtasks roll-up for epics
    if (fields.includes('subtasks') && data.subtasks) {
      result.subtasks = data.subtasks
    }
    return jsonResult(result)
  }, errorTool)
}

export function handleListTasks(svc: TaskService, args: {
  assignee?: string
  status?: TaskStatus
  fields?: string[]
  limit?: number
  updated_since?: number
  epic_id?: number
  is_epic?: boolean
  ids?: number[]
  project?: string
}): ToolResult {
  const unknown = rejectUnknownArgs('list_tasks', LIST_TASKS_SHAPE, args)
  if (unknown) return unknown
  if (args.ids !== undefined && args.ids.length > 0) {
    const withAssignee = args.fields?.includes('assignee') ?? false
    return foldResult(svc.getTasksByIds(args.ids), ({ items }) => {
      const lines = items.map(({ id, task }) => {
        if (!task) {
          const code = statusToCode('not_found')
          return withAssignee ? pipeJoin(id, code, '-') : pipeJoin(id, code)
        }
        const code = statusToCode(task.status)
        return withAssignee ? pipeJoin(id, code, task.assignee ?? '-') : pipeJoin(id, code)
      })
      return textResult(lines.join('\n'))
    }, errorTool)
  }
  const filters = {
    assignee: args.assignee,
    status: args.status,
    updated_since: args.updated_since,
    epic_id: args.epic_id,
    is_epic: args.is_epic,
    limit: args.limit,
    project: args.project
  }
  const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'assignee']
  return foldResult(svc.listTasks(filters), (data) => {
    const tasks = data.tasks.map((task) => pickFields(task, fields))
    return jsonResult({ tasks, total: data.total })
  }, errorTool)
}

export function handleClaimTask(svc: TaskService, args: {
  agent?: string
  task_id?: number
  id?: number
  include?: string[]
  lease_ttl_min?: number
  project?: string
}): ToolResult {
  const unknown = rejectUnknownArgs('claim_task', CLAIM_TASK_SHAPE, args)
  if (unknown) return unknown
  if (args.task_id !== undefined && args.id !== undefined && args.task_id !== args.id) {
    return errorResult(`INVALID: claim_task id/task_id conflict (id=${args.id} task_id=${args.task_id}); task_id is canonical`)
  }
  const taskId = args.task_id !== undefined ? args.task_id : args.id
  return foldResult(svc.claimTask({ agent: args.agent ?? 'unknown', taskId, leaseTtlMin: args.lease_ttl_min, project: args.project }), ({ id, leaseTtlMin, task }) => {
    const result: Record<string, unknown> = { id, lease_ttl_min: leaseTtlMin, version: task.version }
    Object.assign(result, pickFields(task, args.include ?? []))
    return jsonResult(result)
  }, errorTool)
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

export function handleListQueue(svc: TaskService, args: { limit?: number; project?: string }): ToolResult {
  const unknown = rejectUnknownArgs('list_queue', LIST_QUEUE_SHAPE, args)
  if (unknown) return unknown
  return foldResult(svc.listQueue(args), (ready) => {
    const lines = ready.map(t => pipeJoin(t.id, t.priority, sanitizePipe(t.title)))
    return textResult(lines.join('\n'))
  }, errorTool)
}

export function registerTaskTools(server: McpServer, svc: TaskService) {
  server.registerTool('create_task', {
    description: 'Create task. Regular tasks start queued; epics are created open. A task is born without a lease, so `assignee` is refused at creation (INVALID: assignee is refused at creation: a task holds a lease only from in_progress) — the claim writes the holder. `reporter` and `assignee` are bounded at 200 code points each (an over-long one is refused by the schema, as INVALID: reporter too long / INVALID: assignee too long). An epic takes no assignee (it holds no lease), and epic_id promotes its target only when the target is queued. blocked is a manual flag only for regular tasks. `project` is required (no default; refused in `legacy` and in an archived project). Build description from get_template("task"); for epics use get_template("epic")',
    inputSchema: z.object(CREATE_TASK_SHAPE).catchall(z.unknown())
  }, async (args) => handleCreateTask(svc, args))

  server.registerTool('get_task', {
    description: 'Brief default: id,title,status,priority,blocked_by. description only via explicit fields; null fields omitted. version via fields:["version"], project via fields:["project"]. By-id: no project argument',
    inputSchema: z.object(GET_TASK_SHAPE).catchall(z.unknown())
  }, async (args) => handleGetTask(svc, args))

  server.registerTool('list_tasks', {
    description: 'Filters: assignee,status,updated_since(unix ms),epic_id(children of epic),is_epic(epic filter). `project` (slug) is required unless ids is non-empty; ids batch-mode returns pipe id|code; assignee via fields:["assignee"]. description only via explicit fields',
    inputSchema: z.object(LIST_TASKS_SHAPE).catchall(z.unknown())
  }, async (args) => handleListTasks(svc, args))

  server.registerTool('claim_task', {
    description: 'Claim a task (auto-picks the best queued, or task_id — queued/blocked). id is an alias of task_id: id alone claims it, id equal to task_id is fine, id different from task_id is an INVALID conflict. `project` (slug) is required for the auto-pick (it is the only scoped branch); a by-id claim stays unscoped. agent is optional (defaults to "unknown"); lease_ttl_min overrides the server default lease for this claim only. include: extra fields in response',
    inputSchema: z.object(CLAIM_TASK_SHAPE).catchall(z.unknown())
  }, async (args) => handleClaimTask(svc, args))

  server.registerTool('update_status', {
    description: 'Transition status. Optimistic lock via version — read current version via get_task fields:["version"] (or from your claim response); on CONFLICT re-read version and retry, except CONFLICT: lease held by <other>, which means hand the task back to that agent. version is optional: when omitted the version check is skipped (a concurrent write still refuses with CONFLICT). canceled is terminal and withdraws any non-terminal task; a `failed` task is closed for work and can be withdrawn to `canceled` administratively — it is never reopened. Epics use `open` status, not queued/blocked/review, and close directly to done/failed/canceled. A non-renewal status=in_progress needs claim-grade eligibility: refused for an epic (INVALID: #N is an epic, not claimable) and for unsatisfied dependencies when entering from queued/blocked (BLOCKED: dependencies not satisfied) — an epic is never leased, and claim_task is the door to a lease. A renewal heartbeat on an epic is answered by the renewal path instead (INVALID: #N is an epic). renew:true with status=in_progress extends your own in_progress lease (heartbeat ~lease_ttl_min/3); the holder must match assignee and the version bumps. reset_attempts:true rides on any legal transition: zeroes attempts (budget refund, max_attempts untouched), requires a comment, and echoes attempts in the response; rejected on epics and on tasks closed for work (a failed task is recovered by recreating it, or withdrawn to canceled)',
    inputSchema: z.object(UPDATE_STATUS_SHAPE).catchall(z.unknown())
  }, async (args) => handleUpdateStatus(svc, args))

  server.registerTool('list_queue', {
    description: 'Deps-satisfied queued tasks of one project, pipe lines id|priority|title. `project` (slug) is required (no default, no all-projects mode)',
    inputSchema: z.object(LIST_QUEUE_SHAPE).catchall(z.unknown())
  }, async (args) => handleListQueue(svc, args))
}
