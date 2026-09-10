import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAllTools } from './tools'
import type { TaskService } from '../core/service'
import { VERSION } from '../version'

export function createMcpServer(svc: TaskService): McpServer {
  const server = new McpServer({
    name: 'ziptask',
    version: VERSION
  })
  registerAllTools(server, svc)
  return server
}
