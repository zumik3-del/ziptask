import type { Database } from 'bun:sqlite'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDatabase, closeDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import { startHttp } from './server'

const db = openDatabase()
const svc = new TaskService(new TaskRepo(db), {
  leaseTtlMin: Number(process.env.ZIPTASK_LEASE_TTL_MIN) || 15
})

function startStdio() {
  const server = createMcpServer(svc)
  const transport = new StdioServerTransport()
  server.connect(transport).catch(err => {
    console.error('[ziptask] stdio error:', err)
    process.exit(1)
  })
  console.error('[ziptask] MCP stdio server started')
}

const isStdio = process.argv.includes('--stdio')
if (isStdio) {
  startStdio()
} else {
  const port = Number(process.env.ZIPTASK_PORT) || 0
  const host = process.env.ZIPTASK_HOST || '127.0.0.1'
  startHttp({
    svc,
    port,
    host,
    onShutdown: () => closeDatabase(db as Database)
  })
}
