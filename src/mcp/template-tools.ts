import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import { type ToolResult, rejectUnknownArgs, textResult } from './common'

import taskTemplate from '../../templates/task-description.md' with { type: 'text' }
import epicTemplate from '../../templates/epic.md' with { type: 'text' }
import commentSuccessTemplate from '../../templates/comment-success.md' with { type: 'text' }
import commentFailureTemplate from '../../templates/comment-failure.md' with { type: 'text' }

const TEMPLATE_NAMES = ['task', 'epic', 'comment-success', 'comment-failure'] as const
type TemplateName = typeof TEMPLATE_NAMES[number]

// Keep API names stable; imports embed the markdown so the compiled binary works.
const TEMPLATES: Record<TemplateName, string> = {
  task: taskTemplate,
  epic: epicTemplate,
  'comment-success': commentSuccessTemplate,
  'comment-failure': commentFailureTemplate
}

const GET_TEMPLATE_SHAPE = {
  name: z.enum(TEMPLATE_NAMES)
}

export function handleGetTemplate(args: { name: TemplateName }): ToolResult {
  const unknown = rejectUnknownArgs('get_template', GET_TEMPLATE_SHAPE, args)
  if (unknown) return unknown
  return textResult(TEMPLATES[args.name])
}

export function registerTemplateTools(server: McpServer, _svc: TaskService) {
  server.registerTool('get_template', {
    description: 'Return a markdown template by name',
    inputSchema: z.object(GET_TEMPLATE_SHAPE).catchall(z.unknown())
  }, async (args) => handleGetTemplate(args))
}
