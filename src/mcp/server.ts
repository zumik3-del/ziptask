import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAllTools } from './tools'
import type { TaskService } from '../core/service'

export function createMcpServer(svc: TaskService): McpServer {
  const server = new McpServer({
    name: 'ziptask',
    version: '0.1.0'
  })
  registerAllTools(server, svc)
  return server
}
