import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskService } from '../core/service'

import { registerTaskTools } from './task-tools'
import { registerCommentTools } from './comment-tools'
import { registerTemplateTools } from './template-tools'
import { registerProjectTools } from './project-tools'

export function registerAllTools(server: McpServer, svc: TaskService) {
  registerTaskTools(server, svc)
  registerCommentTools(server, svc)
  registerTemplateTools(server, svc)
  registerProjectTools(server, svc)
}