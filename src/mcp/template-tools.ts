import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import {
  type ToolResult,
  rejectUnknownArgs,
  registerTool,
  textResult,
  READ_ONLY_ANNOTATIONS
} from './common'

import taskTemplate from '../../templates/task-description.md' with { type: 'text' }
import epicTemplate from '../../templates/epic.md' with { type: 'text' }
import commentSuccessTemplate from '../../templates/comment-success.md' with { type: 'text' }
import commentFailureTemplate from '../../templates/comment-failure.md' with { type: 'text' }

const TEMPLATE_NAMES = ['task', 'epic', 'comment-success', 'comment-failure'] as const
type TemplateName = (typeof TEMPLATE_NAMES)[number]

const TEMPLATES: Record<TemplateName, string> = {
  task: taskTemplate,
  epic: epicTemplate,
  'comment-success': commentSuccessTemplate,
  'comment-failure': commentFailureTemplate
}

const GET_TEMPLATE_SHAPE = {
  name: z.enum(TEMPLATE_NAMES).describe('template name')
}

export function handleGetTemplate(args: { name: TemplateName }): ToolResult {
  const unknown = rejectUnknownArgs('get_template', GET_TEMPLATE_SHAPE, args)
  if (unknown) return unknown
  return textResult(TEMPLATES[args.name])
}

export function registerTemplateTools(server: McpServer, svc: TaskService) {
  registerTool(server, svc, {
    name: 'get_template',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      'Return the template text: `task`/`epic` for a create_task description, `comment-success`/`comment-failure` for an add_comment body.',
    shape: GET_TEMPLATE_SHAPE,
    run: (_svc, args: { name: TemplateName }) => handleGetTemplate(args)
  })
}
