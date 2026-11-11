import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import {
  sanitizePipe,
  pipeJoin,
  MAX_RESULT_LIMIT,
  MAX_AGENT_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_SAFE_TIMESTAMP_MS
} from '../core/tasks'
import {
  type ToolResult,
  toToolResult,
  rejectUnknownArgs,
  registerTool,
  textResult,
  truncateChars,
  errorTool,
  TaskId
} from './common'
import { foldResult } from '../core/result'

const ADD_COMMENT_SHAPE = {
  id: TaskId,
  agent: z
    .string()
    .max(MAX_AGENT_LENGTH, 'INVALID: agent too long')
    .describe('agent name; <=200 code points'),
  content: z
    .string()
    .max(MAX_CONTENT_LENGTH, 'INVALID: content too long')
    .optional()
    .describe(
      'English; fill get_template("comment-success") or "comment-failure"; <=10000 code points'
    ),
  text: z
    .string()
    .max(MAX_CONTENT_LENGTH, 'INVALID: content too long')
    .optional()
    .describe('alias of content'),
  comment: z
    .string()
    .max(MAX_CONTENT_LENGTH, 'INVALID: content too long')
    .optional()
    .describe('alias of content')
}

const GET_TIMELINE_SHAPE = {
  id: TaskId,
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional(),
  since: z
    .number()
    .finite()
    .min(-MAX_SAFE_TIMESTAMP_MS)
    .max(MAX_SAFE_TIMESTAMP_MS)
    .optional()
    .describe(
      'unix ms; when set, returns the oldest N events at or after it (forward cursor) instead of the newest N'
    ),
  max_text_chars: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTENT_LENGTH)
    .optional()
    .describe('truncate each text to N code points, marker …(+N chars); 0 omits the text column')
}

export function handleAddComment(
  svc: TaskService,
  args: {
    id: number
    agent: string
    content?: string
    text?: string
    comment?: string
  }
): ToolResult {
  const unknown = rejectUnknownArgs('add_comment', ADD_COMMENT_SHAPE, args)
  if (unknown) return unknown
  const content = args.content ?? args.text ?? args.comment
  return toToolResult(svc.addComment({ id: args.id, agent: args.agent, content: content ?? '' }))
}

export function handleGetTimeline(
  svc: TaskService,
  args: { id: number; limit?: number; since?: number; max_text_chars?: number }
): ToolResult {
  const unknown = rejectUnknownArgs('get_timeline', GET_TIMELINE_SHAPE, args)
  if (unknown) return unknown
  return foldResult(
    svc.getTimeline(args.id, args.limit, args.since),
    (rows) => {
      const max = args.max_text_chars
      const lines = rows.map((row, i) => {
        const head = pipeJoin(i + 1, row.type, sanitizePipe(row.agent), row.created_at)
        if (max === 0) return head
        return `${head}|${truncateChars(sanitizePipe(row.text), max)}`
      })
      return textResult(lines.join('\n'))
    },
    errorTool
  )
}

export function registerCommentTools(server: McpServer, svc: TaskService) {
  registerTool(server, svc, {
    name: 'add_comment',
    description:
      'Add a comment; agent and non-empty content (alias text/comment) are required. One line from get_template("comment-success"/"comment-failure").',
    shape: ADD_COMMENT_SHAPE,
    run: handleAddComment
  })

  registerTool(server, svc, {
    name: 'get_timeline',
    description:
      'Merged audit + comments feed, pipe seq|type|agent|at|text ascending. `limit` is the newest N events (default defaults.timelineLimit); `since` (unix ms) switches to a forward cursor: the oldest N at or after it. `max_text_chars` truncates each text (0 omits it).',
    shape: GET_TIMELINE_SHAPE,
    run: handleGetTimeline
  })
}
