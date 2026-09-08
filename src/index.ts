import type { Database } from 'bun:sqlite'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDatabase, closeDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import { startHttp } from './server'
import { loadSettings } from './config'

const settings = loadSettings()

const db = openDatabase(settings.dbPath)
const svc = new TaskService(new TaskRepo(db), {
  leaseTtlMin: settings.leaseTtlMin
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
  startHttp({
    svc,
    port: settings.port,
    host: settings.host,
    maxSessions: settings.http.maxSessions,
    sessionTtlMs: settings.http.sessionTtlMs,
    onShutdown: () => closeDatabase(db as Database)
  })
}
