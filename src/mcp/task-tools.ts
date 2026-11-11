import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import type { TaskStatus, TaskPriorityInput } from '../core/tasks'
import {
  statusToCode,
  sanitizePipe,
  pipeJoin,
  TASK_STATUSES,
  TASK_PRIORITIES,
  MAX_RESULT_LIMIT,
  MAX_LEASE_TTL_MIN,
  LEASE_TTL_TOO_LARGE_MESSAGE,
  MAX_SAFE_TIMESTAMP_MS,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_AGENT_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_DEPENDS_ON
} from '../core/tasks'
import { PRIORITY_INPUT as BASE_PRIORITY_INPUT } from '../config'
import { foldResult } from '../core/result'
import {
  type ToolResult,
  jsonResult,
  textResult,
  errorTool,
  toToolResult,
  pickFields,
  rejectUnknownArgs,
  registerTool,
  PROJECT_ARG,
  TaskId
} from './common'

const PRIORITY_JSON_SHAPE = {
  anyOf: [
    { type: 'string', enum: [...TASK_PRIORITIES] },
    { type: 'integer', minimum: 0, maximum: TASK_PRIORITIES.length - 1 },
    { type: 'string', enum: TASK_PRIORITIES.map((_, index) => String(index)) }
  ]
}

const PRIORITY_INPUT = BASE_PRIORITY_INPUT.meta(PRIORITY_JSON_SHAPE)

const MAX_FIELD_CHARS = z
  .number()
  .int()
  .positive()
  .max(MAX_DESCRIPTION_LENGTH)
  .optional()
  .describe('truncate each string field to N code points, marker …(+N chars); omitted = full text')

const BATCH_FORMAT = z
  .enum(['pipe', 'json'])
  .optional()
  .describe(
    'ids mode only: pipe id|code|<fields> (default) or json {tasks:[...]}; ignored when filters are used'
  )

function pipeCell(value: unknown): string | number {
  if (value === undefined || value === null) return '-'
  return typeof value === 'string' ? sanitizePipe(value) : String(value)
}

const CREATE_TASK_SHAPE = {
  title: z
    .string()
    .max(MAX_TITLE_LENGTH, 'INVALID: title too long')
    .describe('English, <=200 code points'),
  description: z
    .string()
    .max(MAX_DESCRIPTION_LENGTH, 'INVALID: description too long')
    .optional()
    .describe('English; fill get_template("task") or "epic" first; <=20000 code points'),
  priority: PRIORITY_INPUT.optional().describe(
    'p0 (highest urgency) … p3 (lowest), default p2; the number 0..3 and the digit string "0".."3" are accepted too'
  ),
  assignee: z
    .string()
    .max(MAX_AGENT_LENGTH, 'INVALID: assignee too long')
    .optional()
    .describe(
      'refused at creation: a task holds a lease only from in_progress; the claim writes the holder; <=200 code points'
    ),
  depends_on: z.array(TaskId).max(MAX_DEPENDS_ON, 'INVALID: depends_on too long').optional(),
  reporter: z
    .string()
    .max(MAX_AGENT_LENGTH, 'INVALID: reporter too long')
    .optional()
    .describe('<=200 code points'),
  epic: z
    .boolean()
    .optional()
    .describe(
      'Create as an epic (not claimable); description follows get_template("epic") with required Source'
    ),
  epic_id: TaskId.optional().describe('Attach as sub-task to an existing task'),
  project: PROJECT_ARG
}

const GET_TASK_SHAPE = {
  id: TaskId,
  fields: z.array(z.string()).optional(),
  max_field_chars: MAX_FIELD_CHARS
}

const LIST_TASKS_SHAPE = {
  assignee: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional(),
  updated_since: z
    .number()
    .finite()
    .min(-MAX_SAFE_TIMESTAMP_MS)
    .max(MAX_SAFE_TIMESTAMP_MS)
    .optional(),
  epic_id: TaskId.optional(),
  is_epic: z.boolean().optional(),
  ids: z.array(TaskId).max(MAX_RESULT_LIMIT).optional(),
  format: BATCH_FORMAT,
  max_field_chars: MAX_FIELD_CHARS,
  project: PROJECT_ARG
}

const CLAIM_TASK_SHAPE = {
  agent: z
    .string()
    .max(MAX_AGENT_LENGTH, 'INVALID: agent too long')
    .optional()
    .describe('agent name; defaults to "unknown" when omitted; <=200 code points'),
  task_id: TaskId.optional(),
  fields: z.array(z.string()).optional().describe('extra fields to include in the response'),
  max_field_chars: MAX_FIELD_CHARS,
  lease_ttl_min: z
    .number()
    .int()
    .positive()
    .max(MAX_LEASE_TTL_MIN, `INVALID: ${LEASE_TTL_TOO_LARGE_MESSAGE}`)
    .optional()
    .describe(
      `lease TTL in minutes for this claim; overrides the server default for this claim only; <=${MAX_LEASE_TTL_MIN}`
    ),
  project: PROJECT_ARG
}

const UPDATE_STATUS_SHAPE = {
  id: TaskId,
  agent: z
    .string()
    .max(MAX_AGENT_LENGTH, 'INVALID: agent too long')
    .describe('agent name; <=200 code points'),
  status: z.enum(TASK_STATUSES),
  version: z
    .number()
    .int()
    .optional()
    .describe('optimistic lock; omit to skip the version check (a stale version still refuses)'),
  comment: z
    .string()
    .max(MAX_CONTENT_LENGTH, 'INVALID: comment too long')
    .optional()
    .describe('typed resolution when done/failed/canceled; <=10000 code points'),
  renew: z
    .boolean()
    .optional()
    .describe(
      'with status=in_progress on an in_progress task: re-arm your own lease (heartbeat, ~lease_ttl_min/3)'
    ),
  reset_attempts: z
    .boolean()
    .optional()
    .describe(
      'with any legal transition: zero attempts (budget refund, max_attempts untouched), requires comment, max_attempts untouched, echoes attempts in the response; not on epics, not on tasks closed for work'
    )
}

const UPDATE_TASK_SHAPE = {
  id: TaskId,
  agent: z.string().max(MAX_AGENT_LENGTH, 'INVALID: agent too long'),
  version: z
    .number()
    .int()
    .optional()
    .describe('optimistic lock; omit to skip the version check (a stale version still refuses)'),
  title: z.string().max(MAX_TITLE_LENGTH, 'INVALID: title too long').optional(),
  description: z.string().max(MAX_DESCRIPTION_LENGTH, 'INVALID: description too long').optional(),
  priority: PRIORITY_INPUT.optional(),
  depends_on: z.array(TaskId).max(MAX_DEPENDS_ON, 'INVALID: depends_on too long').optional(),
  comment: z
    .string()
    .max(MAX_CONTENT_LENGTH, 'INVALID: comment too long')
    .optional()
    .describe('rationale stored as a comment; <=10000 code points')
}

const LIST_QUEUE_SHAPE = {
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional(),
  project: PROJECT_ARG
}

export function handleCreateTask(
  svc: TaskService,
  args: {
    title: string
    description?: string
    priority?: TaskPriorityInput
    assignee?: string
    depends_on?: number[]
    reporter?: string
    epic?: boolean
    epic_id?: number
    project?: string
  }
): ToolResult {
  const unknown = rejectUnknownArgs('create_task', CREATE_TASK_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.createTask(args))
}

export function handleGetTask(
  svc: TaskService,
  args: { id: number; fields?: string[]; max_field_chars?: number }
): ToolResult {
  const unknown = rejectUnknownArgs('get_task', GET_TASK_SHAPE, args)
  if (unknown) return unknown
  return foldResult(
    svc.getTaskView(args.id),
    (data) => {
      const fields = args.fields ?? ['id', 'title', 'status', 'priority', 'blocked_by']
      const result = pickFields(data.task, fields, args.max_field_chars)
      if (fields.includes('blocked_by')) {
        result.blocked_by = data.blockedBy
      }
      if (fields.includes('subtasks') && data.subtasks) {
        result.subtasks = data.subtasks
      }
      return jsonResult(result)
    },
    errorTool
  )
}

export function handleListTasks(
  svc: TaskService,
  args: {
    assignee?: string
    status?: TaskStatus
    fields?: string[]
    limit?: number
    updated_since?: number
    epic_id?: number
    is_epic?: boolean
    ids?: number[]
    format?: 'pipe' | 'json'
    max_field_chars?: number
    project?: string
  }
): ToolResult {
  const unknown = rejectUnknownArgs('list_tasks', LIST_TASKS_SHAPE, args)
  if (unknown) return unknown
  if (args.ids !== undefined && args.ids.length > 0) {
    const fields = args.fields ?? []
    return foldResult(
      svc.getTasksByIds(args.ids),
      ({ items }) => {
        if (args.format === 'json') {
          const tasks = items.map(({ id, task }) =>
            task === null
              ? { id, code: statusToCode('not_found') }
              : {
                  id,
                  code: statusToCode(task.status),
                  ...pickFields(task, fields, args.max_field_chars)
                }
          )
          return jsonResult({ tasks, total: items.length })
        }
        const lines = items.map(({ id, task }) => {
          if (task === null) {
            return pipeJoin(id, statusToCode('not_found'), ...fields.map(() => '-'))
          }
          const picked = pickFields(task, fields, args.max_field_chars)
          return pipeJoin(id, statusToCode(task.status), ...fields.map((f) => pipeCell(picked[f])))
        })
        return textResult(lines.join('\n'))
      },
      errorTool
    )
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
  return foldResult(
    svc.listTasks(filters),
    (data) => {
      const tasks = data.tasks.map((task) => pickFields(task, fields, args.max_field_chars))
      return jsonResult({ tasks, total: data.total })
    },
    errorTool
  )
}

export function handleClaimTask(
  svc: TaskService,
  args: {
    agent?: string
    task_id?: number
    fields?: string[]
    lease_ttl_min?: number
    max_field_chars?: number
    project?: string
  }
): ToolResult {
  const unknown = rejectUnknownArgs('claim_task', CLAIM_TASK_SHAPE, args)
  if (unknown) return unknown
  const taskId = args.task_id
  return foldResult(
    svc.claimTask({
      agent: args.agent ?? 'unknown',
      taskId,
      leaseTtlMin: args.lease_ttl_min,
      project: args.project
    }),
    ({ id, leaseTtlMin, task }) => {
      const result: Record<string, unknown> = {
        id,
        lease_ttl_min: leaseTtlMin,
        version: task.version
      }
      Object.assign(result, pickFields(task, args.fields ?? [], args.max_field_chars))
      return jsonResult(result)
    },
    errorTool
  )
}

export function handleUpdateStatus(
  svc: TaskService,
  args: {
    id: number
    agent: string
    status: TaskStatus
    version?: number
    comment?: string
    renew?: boolean
    reset_attempts?: boolean
  }
): ToolResult {
  const unknown = rejectUnknownArgs('update_status', UPDATE_STATUS_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.updateStatus(args))
}

export function handleUpdateTask(
  svc: TaskService,
  args: {
    id: number
    agent: string
    version?: number
    title?: string
    description?: string | null
    priority?: TaskPriorityInput
    depends_on?: number[]
    comment?: string
  }
): ToolResult {
  const unknown = rejectUnknownArgs('update_task', UPDATE_TASK_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.updateTask(args))
}

export function handleListQueue(
  svc: TaskService,
  args: { limit?: number; project?: string }
): ToolResult {
  const unknown = rejectUnknownArgs('list_queue', LIST_QUEUE_SHAPE, args)
  if (unknown) return unknown
  return foldResult(
    svc.listQueue(args),
    (ready) => {
      const lines = ready.map((t) => pipeJoin(t.id, t.priority, sanitizePipe(t.title)))
      return textResult(lines.join('\n'))
    },
    errorTool
  )
}

export function registerTaskTools(server: McpServer, svc: TaskService) {
  registerTool(server, svc, {
    name: 'create_task',
    description:
      'Create a task. Regular tasks start `queued`, epics `open`; `assignee` is refused at creation (a lease exists only from `in_progress`, and the claim writes the holder). `epic_id` attaches a sub-task and promotes a queued target. `project` is required. Build `description` from get_template("task") or get_template("epic").',
    shape: CREATE_TASK_SHAPE,
    run: handleCreateTask
  })

  registerTool(server, svc, {
    name: 'get_task',
    description:
      'Brief default: id,title,status,priority,blocked_by. More via fields — description, version, project, subtasks (epic roll-up); null fields are omitted. max_field_chars truncates long strings with a …(+N chars) marker. By-id: no project argument.',
    shape: GET_TASK_SHAPE,
    run: handleGetTask
  })

  registerTool(server, svc, {
    name: 'list_tasks',
    description:
      'Filters: assignee,status,updated_since(ms),epic_id(children),is_epic; `project` is required unless `ids` is non-empty. Batch `ids` ignores filters and keeps request order: pipe `id|code|<fields...>` (`-` for null or unknown) or `format:"json"` — use json for description, pipe escaping rewrites | and newlines. description only via fields; max_field_chars truncates.',
    shape: LIST_TASKS_SHAPE,
    run: handleListTasks
  })

  registerTool(server, svc, {
    name: 'claim_task',
    description: `Claim a task: auto-pick takes the best queued task of the required \`project\`; with \`task_id\` the call is unscoped and also accepts a blocked task. agent defaults to "unknown"; lease_ttl_min overrides the default for this claim only (<=${MAX_LEASE_TTL_MIN}, larger refused). fields adds task fields to the response; max_field_chars truncates.`,
    shape: CLAIM_TASK_SHAPE,
    run: handleClaimTask
  })

  registerTool(server, svc, {
    name: 'update_status',
    description:
      'Transition status. `version` is an optional optimistic lock — read it via get_task fields:["version"] or the claim response; a stale one answers CONFLICT, so re-read and retry, except CONFLICT: lease held by <other>, which means hand the task back. `canceled` withdraws any task still open for work; `failed` is closed for work and only withdrawable to `canceled`; epics stay `open` and close directly to done/failed/canceled, refused while children are not terminal. A non-renewal entry into `in_progress` is held to claim eligibility (not an epic, deps satisfied). `renew:true` with status=in_progress re-arms your own lease (heartbeat ~lease_ttl_min/3) and bumps version. `reset_attempts:true` rides any legal transition, requires a comment, zeroes attempts, and is refused on epics and closed tasks.',
    shape: UPDATE_STATUS_SHAPE,
    run: handleUpdateStatus
  })

  registerTool(server, svc, {
    name: 'update_task',
    description:
      'Patch a queued task or an open epic with no lease holder: title, description (the contract), priority, depends_on (replaces the list, <=100 ids; epics take no deps), comment (rationale). Immutable: status, assignee (the lease holder), project, epic_id, reporter, max_attempts. version is an optional optimistic lock; a stale one answers CONFLICT. Refused for in_progress/review/blocked or closed tasks — use add_comment; no editable field → INVALID: nothing to update; a value equal to the stored one is a no-op (changed:[]). Output {id,version,changed}.',
    shape: UPDATE_TASK_SHAPE,
    run: handleUpdateTask
  })

  registerTool(server, svc, {
    name: 'list_queue',
    description:
      'Deps-satisfied queued tasks of one project, pipe id|priority|title; `project` is required (no default or all-projects mode).',
    shape: LIST_QUEUE_SHAPE,
    run: handleListQueue
  })
}
