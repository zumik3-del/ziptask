import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import { sanitizePipe, pipeJoin, MAX_RESULT_LIMIT } from '../core/tasks'
import { type ToolResult, toToolResult, rejectUnknownArgs, foldResult, textResult, errorTool, TaskId } from './common'

const ADD_COMMENT_SHAPE = {
  id: TaskId,
  agent: z.string(),
  content: z.string().optional().describe('English; fill get_template("comment-success") or "comment-failure"'),
  text: z.string().optional().describe('alias of content'),
  comment: z.string().optional().describe('alias of content')
}

const GET_TIMELINE_SHAPE = {
  id: TaskId,
  limit: z.number().int().positive().max(MAX_RESULT_LIMIT).optional()
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
  return foldResult(svc.getTimeline(args.id, args.limit), (rows) => {
    const lines = rows.map((row, i) => pipeJoin(i + 1, row.type, row.agent, row.created_at, sanitizePipe(row.text)))
    return textResult(lines.join('\n'))
  }, errorTool)
}

export function registerCommentTools(server: McpServer, svc: TaskService) {
  server.registerTool('add_comment', {
    description: 'Add comment to task. Requires non-empty agent and content (content, or its alias text/comment); one-liner from get_template("comment-success") or "comment-failure"',
    inputSchema: z.object(ADD_COMMENT_SHAPE).catchall(z.unknown())
  }, async (args) => handleAddComment(svc, args))

  server.registerTool('get_timeline', {
    description: 'Merged audit_log + comments feed for a task, pipe seq|type|agent|at|text',
    inputSchema: z.object(GET_TIMELINE_SHAPE).catchall(z.unknown())
  }, async (args) => handleGetTimeline(svc, args))
}