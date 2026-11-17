import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { openDatabase, closeDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService, type TaskServiceOptions } from './core/service'
import { createMcpServer } from './mcp/server'
import { startHttp } from './server'
import { CLI_USAGE, parseCliArgs, loadSettings, type CliArgs } from './config'
import { createLogger, normalizeError } from './logger'
import { VERSION } from './version'

let cli: CliArgs
try {
  cli = parseCliArgs(process.argv)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

if (cli.help) {
  console.log(CLI_USAGE)
  process.exit(0)
}

if (cli.version) {
  console.log(`ziptask ${VERSION}`)
  process.exit(0)
}

const settingsWarnings: Array<{ message: string; fields: Record<string, unknown> }> = []
const settings = loadSettings({
  warn: (message, fields) => settingsWarnings.push({ message, fields })
})
const logger = createLogger('app', settings.logging.level)
for (const { message, fields } of settingsWarnings) logger.warn(message, fields)

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', normalizeError(err))
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', normalizeError(reason))
})

try {
  const db = openDatabase(settings.dbPath)
  const serviceOptions: TaskServiceOptions = {
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
  }
  const svc = new TaskService(new TaskRepo(db), serviceOptions)

  function startStdio() {
    serveStdio((_ctx) => createMcpServer(svc), { legacy: 'serve' })
    logger.info('ziptask started', { version: VERSION, dbPath: settings.dbPath })
  }

  if (cli.stdio) {
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
