import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openDatabase, closeDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import { startHttp } from './server'
import { loadSettings } from './config'
import { createLogger, normalizeError } from './logger'
import { VERSION } from './version'

const settingsWarnings: Array<{ message: string; fields: Record<string, unknown> }> = []
const settings = loadSettings({ warn: (message, fields) => settingsWarnings.push({ message, fields }) })
const logger = createLogger('app', settings.logging.level)
for (const { message, fields } of settingsWarnings) logger.warn(message, fields)

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', normalizeError(err))
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', normalizeError(reason))
})

const wantsVersion = process.argv.includes('--version')
if (wantsVersion) {
  console.log(`ziptask ${VERSION}`)
  process.exit(0)
}

try {
  const db = openDatabase(settings.dbPath)
  const svc = new TaskService(new TaskRepo(db), {
    leaseTtlMin: settings.leaseTtlMin,
    maxAttempts: settings.maxAttempts,
    auditLog: settings.auditLog,
    reapCooldownSec: settings.reapCooldownSec,
    autoClaimCeiling: settings.autoClaimCeiling,
    defaultPriority: settings.defaults.priority,
    defaultReporter: settings.defaults.reporter,
    listLimit: settings.defaults.listLimit,
    timelineLimit: settings.defaults.timelineLimit,
    queueLimit: settings.defaults.queueLimit
  })

  function startStdio() {
    const server = createMcpServer(svc)
    const transport = new StdioServerTransport()
    server.connect(transport).catch(err => {
      logger.error('stdio transport error', normalizeError(err))
      process.exit(1)
    })
    logger.info('ziptask started', { version: VERSION, dbPath: settings.dbPath })
  }

  const isStdio = process.argv.includes('--stdio')
  if (isStdio) {
    startStdio()
  } else {
    startHttp({
      svc,
      port: settings.port,
      host: settings.host,
      dbPath: settings.dbPath,
      maxSessions: settings.http.maxSessions,
      sessionTtlMs: settings.http.sessionTtlMs,
      logger,
      onShutdown: () => closeDatabase(db)
    })
  }
} catch (err) {
  if (err instanceof Error && err.message.startsWith('SCHEMA:')) {
    logger.error('startup failed', err)
    process.exit(1)
  }
  throw err
}
