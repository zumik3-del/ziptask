import type { Database } from 'bun:sqlite'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDatabase, closeDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import { startHttp } from './server'
import { loadSettings } from './config'
import { createLogger } from './logger'

const VERSION = (globalThis as any).__ZIPTASK_VERSION__ ?? '0.0.0'

const settings = loadSettings()
const logger = createLogger('app', settings.logging.level)

const isVersion = process.argv.includes('--version')
if (isVersion) {
  console.log(`ziptask ${VERSION}`)
  process.exit(0)
}

try {
  const db = openDatabase(settings.dbPath)
  const svc = new TaskService(new TaskRepo(db), {
    leaseTtlMin: settings.leaseTtlMin,
    maxAttempts: settings.maxAttempts,
    auditLog: settings.auditLog
  })

  function startStdio() {
    const server = createMcpServer(svc)
    const transport = new StdioServerTransport()
    server.connect(transport).catch(err => {
      logger.error('stdio error: %s', err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
    logger.info('MCP stdio server started')
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
      logger,
      onShutdown: () => closeDatabase(db as Database)
    })
  }
} catch (err) {
  if (err instanceof Error && err.message.startsWith('SCHEMA:')) {
    logger.error('%s', err.message)
    process.exit(1)
  }
  throw err
}
