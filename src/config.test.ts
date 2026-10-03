import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings, DEFAULTS, type Settings } from './config'
import { createLogger } from './logger'
import { TaskService } from './core/service'

const TMP = '/tmp/opencode'

// Settings['logging']['level'] is an intersection of the settings.json enum and `string`, so
// it narrows to the five file levels in the type system while the runtime value handed over by
// loadSettings is the raw env string. Read it through here to pin what production passes on.
const rawLevel = (s: Settings): string => s.logging.level

function writeSettingsJson(dir: string, content: object): string {
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

let testDir: string

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  testDir = join(TMP, `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  try { rmSync(testDir, { recursive: true }) } catch {}
})

describe('loadSettings defaults', () => {
  test('returns all defaults when no opts provided', () => {
    const s = loadSettings({ env: {}, argv: ['node'] })
    expect(s).toEqual({
      dbPath: DEFAULTS.dbPath,
      host: DEFAULTS.host,
      port: DEFAULTS.port,
      leaseTtlMin: DEFAULTS.leaseTtlMin,
      maxAttempts: DEFAULTS.maxAttempts,
      reapCooldownSec: DEFAULTS.reapCooldownSec,
      autoClaimCeiling: DEFAULTS.autoClaimCeiling,
      http: { ...DEFAULTS.http },
      defaults: { ...DEFAULTS.defaults },
      logging: { ...DEFAULTS.logging },
      auditLog: DEFAULTS.auditLog
    })
  })

  test('returns all defaults with empty env and empty argv', () => {
    const s = loadSettings({ env: {}, argv: [] })
    expect(s.dbPath).toBe('./data/ziptask.db')
    expect(s.host).toBe('127.0.0.1')
    expect(s.port).toBe(0)
    expect(s.leaseTtlMin).toBe(15)
    expect(s.maxAttempts).toBe(3)
    expect(s.reapCooldownSec).toBe(60)
    expect(s.autoClaimCeiling).toBe(10000)
    expect(s.http.maxSessions).toBe(100)
    expect(s.http.sessionTtlMs).toBe(3_600_000)
    expect(s.defaults.priority).toBe('p2')
    expect(s.defaults.reporter).toBe('system')
    expect(s.defaults.listLimit).toBe(50)
    expect(s.defaults.timelineLimit).toBe(50)
    expect(s.defaults.queueLimit).toBe(100)
    expect(s.logging.level).toBe('info')
    expect(s.auditLog).toBe(true)
  })
})

describe('loadSettings settings.json', () => {
  test('applies values from settings.json via opts.path', () => {
    const settingsPath = writeSettingsJson(testDir, {
      dbPath: '/tmp/my.db',
      host: '0.0.0.0',
      port: 8080,
      leaseTtlMin: 30,
      maxAttempts: 5,
      http: { maxSessions: 200, sessionTtlMs: 1_800_000 },
      defaults: { priority: 'p0', reporter: 'human', listLimit: 10, timelineLimit: 20, queueLimit: 5 }
    })
    const s = loadSettings({ path: settingsPath, env: {}, argv: [] })
    expect(s.dbPath).toBe('/tmp/my.db')
    expect(s.host).toBe('0.0.0.0')
    expect(s.port).toBe(8080)
    expect(s.leaseTtlMin).toBe(30)
    expect(s.maxAttempts).toBe(5)
    expect(s.http.maxSessions).toBe(200)
    expect(s.http.sessionTtlMs).toBe(1_800_000)
    expect(s.defaults.priority).toBe('p0')
    expect(s.defaults.reporter).toBe('human')
    expect(s.defaults.listLimit).toBe(10)
    expect(s.defaults.timelineLimit).toBe(20)
    expect(s.defaults.queueLimit).toBe(5)
  })

  test('applies partial settings.json (missing fields keep defaults)', () => {
    const settingsPath = writeSettingsJson(testDir, { port: 9999 })
    const s = loadSettings({ path: settingsPath, env: {}, argv: [] })
    expect(s.port).toBe(9999)
    expect(s.dbPath).toBe(DEFAULTS.dbPath)
    expect(s.leaseTtlMin).toBe(DEFAULTS.leaseTtlMin)
  })

  test('accepts every logging.level, warn included', () => {
    for (const level of ['off', 'error', 'warn', 'info', 'debug'] as const) {
      const settingsPath = writeSettingsJson(testDir, { logging: { level } })
      expect(loadSettings({ path: settingsPath, env: {}, argv: [] }).logging.level).toBe(level)
    }
  })
})

describe('loadSettings env overrides', () => {
  test('ZIPTASK_* env vars override settings.json', () => {
    const settingsPath = writeSettingsJson(testDir, { dbPath: '/tmp/file.db', port: 7000 })
    const env = {
      ZIPTASK_DB: '/tmp/env.db',
      ZIPTASK_HOST: '10.0.0.1',
      ZIPTASK_PORT: '7777',
      ZIPTASK_LEASE_TTL_MIN: '45'
    }
    const s = loadSettings({ path: settingsPath, env, argv: [] })
    expect(s.dbPath).toBe('/tmp/env.db')
    expect(s.host).toBe('10.0.0.1')
    expect(s.port).toBe(7777)
    expect(s.leaseTtlMin).toBe(45)
    // port from settings.json should be overridden by env
    expect(s.port).not.toBe(7000)
  })

  test('env overrides defaults when no settings file', () => {
    const s = loadSettings({ env: { ZIPTASK_DB: '/tmp/no-file.db', ZIPTASK_PORT: '1234' }, argv: [] })
    expect(s.dbPath).toBe('/tmp/no-file.db')
    expect(s.port).toBe(1234)
    expect(s.host).toBe(DEFAULTS.host)
  })

  test('ZIPTASK_MAX_ATTEMPTS env var overrides default maxAttempts', () => {
    const s = loadSettings({ env: { ZIPTASK_MAX_ATTEMPTS: '7' }, argv: [] })
    expect(s.maxAttempts).toBe(7)
  })

  test('all nested ENV_MAPPINGS entries override via env', () => {
    const s = loadSettings({
      env: {
        ZIPTASK_HTTP_MAX_SESSIONS: '200',
        ZIPTASK_HTTP_SESSION_TTL_MS: '1800000',
        ZIPTASK_DEFAULTS_PRIORITY: 'p0',
        ZIPTASK_DEFAULTS_REPORTER: 'human',
        ZIPTASK_DEFAULTS_LIST_LIMIT: '10',
        ZIPTASK_DEFAULTS_TIMELINE_LIMIT: '20',
        ZIPTASK_DEFAULTS_QUEUE_LIMIT: '5'
      },
      argv: []
    })
    expect(s.http.maxSessions).toBe(200)
    expect(s.http.sessionTtlMs).toBe(1_800_000)
    expect(s.defaults.priority).toBe('p0')
    expect(s.defaults.reporter).toBe('human')
    expect(s.defaults.listLimit).toBe(10)
    expect(s.defaults.timelineLimit).toBe(20)
    expect(s.defaults.queueLimit).toBe(5)
  })

  test('invalid int env value is skipped (NaN)', () => {
    const s = loadSettings({ env: { ZIPTASK_PORT: 'not-a-number' }, argv: [] })
    expect(s.port).toBe(DEFAULTS.port)
  })

  test('ZIPTASK_LOG_LEVEL overrides logging level (error/warn/debug/off)', () => {
    expect(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'error' }, argv: [] }).logging.level).toBe('error')
    expect(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'warn' }, argv: [] }).logging.level).toBe('warn')
    expect(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'debug' }, argv: [] }).logging.level).toBe('debug')
    expect(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'off' }, argv: [] }).logging.level).toBe('off')
  })

  test('ZIPTASK_LOG_LEVEL is passed through raw, neither validated nor normalized', () => {
    // Level parsing lives in the logger (parseLogLevel in src/logger.ts): config hands the
    // env value over untouched, so an unknown level can reach createLogger and its warn,
    // and case handling stays the logger's business (pinned in src/logger.test.ts).
    expect(rawLevel(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'warn' }, argv: [] }))).toBe('warn')
    expect(rawLevel(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'verbose' }, argv: [] }))).toBe('verbose')
    expect(rawLevel(loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'WARN' }, argv: [] }))).toBe('WARN')
    // unset stays at the default, the only normalization left here
    expect(rawLevel(loadSettings({ env: {}, argv: [] }))).toBe('info')
  })

  test('an unknown ZIPTASK_LOG_LEVEL still overrides settings.json rather than being skipped', () => {
    // unlike an invalid int (skipped), any level string is applied as given — whether it
    // is a level at all is decided by the logger, not by config
    const settingsPath = writeSettingsJson(testDir, { logging: { level: 'debug' } })
    const s = loadSettings({ path: settingsPath, env: { ZIPTASK_LOG_LEVEL: 'verbose' }, argv: [] })
    expect(rawLevel(s)).toBe('verbose')
  })

  test('env overrides settings.json for logging.level', () => {
    const settingsPath = writeSettingsJson(testDir, { logging: { level: 'debug' } })
    const s = loadSettings({ path: settingsPath, env: { ZIPTASK_LOG_LEVEL: 'warn' }, argv: [] })
    expect(s.logging.level).toBe('warn')
  })

  test('legacy ZIPTASK_LOGGING_LEVEL is ignored', () => {
    const s = loadSettings({ env: { ZIPTASK_LOGGING_LEVEL: 'debug' }, argv: [] })
    expect(s.logging.level).toBe('info')
  })

  test('env overrides settings.json for nested keys', () => {
    const settingsPath = writeSettingsJson(testDir, {
      http: { maxSessions: 50, sessionTtlMs: 600_000 },
      defaults: { priority: 'p3', reporter: 'system', listLimit: 99, timelineLimit: 99, queueLimit: 99 }
    })
    const s = loadSettings({
      path: settingsPath,
      env: {
        ZIPTASK_HTTP_MAX_SESSIONS: '1',
        ZIPTASK_DEFAULTS_PRIORITY: 'p1'
      },
      argv: []
    })
    expect(s.http.maxSessions).toBe(1)
    expect(s.http.sessionTtlMs).toBe(600_000) // not overridden
    expect(s.defaults.priority).toBe('p1')
    expect(s.defaults.reporter).toBe('system') // not overridden
  })
})

describe('ZIPTASK_LOG_LEVEL hand-off to the logger', () => {
  test('the raw invalid value reaches createLogger, which warns once and then gates at info', () => {
    const chunks: string[] = []
    const writeSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      if (typeof chunk === 'string') chunks.push(chunk)
      return true
    })
    const records = (): Record<string, unknown>[] =>
      chunks.map(line => JSON.parse(line) as Record<string, unknown>)

    try {
      const settings = loadSettings({ env: { ZIPTASK_LOG_LEVEL: 'verbose' }, argv: [] })
      const log = createLogger('app', settings.logging.level)

      // the warn about the unparsable level is emitted at construction, exactly once
      expect(records().map(r => ({ level: r.level, logger: r.logger, msg: r.msg, requested: r.requested })))
        .toEqual([{
          level: 'warn',
          logger: 'app',
          msg: 'unknown log level requested, falling back to info',
          requested: 'verbose'
        }])

      // ...and the fallback is the real info gate, not an open level
      chunks.length = 0
      log.info('kept')
      log.debug('suppressed')
      expect(records().map(r => ({ level: r.level, msg: r.msg })))
        .toEqual([{ level: 'info', msg: 'kept' }])
    } finally {
      writeSpy.mockRestore()
    }
  })
})

describe('loadSettings CLI flag', () => {
  test('--settings flag overrides env ZIPTASK_SETTINGS', () => {
    const cliPath = writeSettingsJson(testDir, { dbPath: '/tmp/cli.db' })
    const envPath = join(testDir, 'env-settings.json')
    writeFileSync(envPath, JSON.stringify({ dbPath: '/tmp/env-file.db' }))
    const env = { ZIPTASK_SETTINGS: envPath }
    const s = loadSettings({ env, argv: ['node', '--settings', cliPath] })
    expect(s.dbPath).toBe('/tmp/cli.db')
  })

  test('--settings takes precedence over env ZIPTASK_SETTINGS for port', () => {
    const cliPath = writeSettingsJson(testDir, { port: 5555 })
    const envFile = join(testDir, 'env-settings.json')
    writeFileSync(envFile, JSON.stringify({ port: 6666 }))
    const env = { ZIPTASK_SETTINGS: envFile }
    const s = loadSettings({ env, argv: ['node', '--settings', cliPath] })
    expect(s.port).toBe(5555)
  })
})

describe('loadSettings error cases', () => {
  test('invalid JSON throws clear error', () => {
    const badPath = join(testDir, 'bad.json')
    writeFileSync(badPath, '{ not valid json }}}')
    expect(() => loadSettings({ path: badPath, env: {}, argv: [] }))
      .toThrow(/Invalid JSON in settings file/)
  })

  test('invalid schema shape throws clear zod validation error', () => {
    const badPath = writeSettingsJson(testDir, { port: -1 })
    expect(() => loadSettings({ path: badPath, env: {}, argv: [] }))
      .toThrow(/Invalid settings.json/)
  })

  test('non-integer port in settings.json is rejected', () => {
    const badPath = writeSettingsJson(testDir, { port: 3.5 })
    expect(() => loadSettings({ path: badPath, env: {}, argv: [] }))
      .toThrow(/Invalid settings.json/)
  })

  test('invalid priority enum in settings.json is rejected', () => {
    const badPath = writeSettingsJson(testDir, { defaults: { priority: 'p99' } })
    expect(() => loadSettings({ path: badPath, env: {}, argv: [] }))
      .toThrow(/Invalid settings.json/)
  })

  test('an unknown logging.level in settings.json is rejected (no silent info fallback)', () => {
    // the file keeps the closed enum even though the env var is passed through raw:
    // 'verbose' is accepted verbatim from the env and still fails startup from the file
    for (const level of ['warning', 'verbose']) {
      const badPath = writeSettingsJson(testDir, { logging: { level } })
      expect(() => loadSettings({ path: badPath, env: {}, argv: [] }))
        .toThrow(/Invalid settings.json/)
    }
  })
})

describe('maxAttempts flow', () => {
  test('loadSettings returns configured maxAttempts from settings.json', () => {
    const settingsPath = writeSettingsJson(testDir, { maxAttempts: 7 })
    const s = loadSettings({ path: settingsPath, env: {}, argv: [] })
    expect(s.maxAttempts).toBe(7)
  })

  test('maxAttempts from settings flows into TaskService insertTask', () => {
    const settingsPath = writeSettingsJson(testDir, { maxAttempts: 5 })
    const s = loadSettings({ path: settingsPath, env: {}, argv: [] })
    // Build a minimal in-memory service to verify the value propagates
    const svc = new TaskService({
      getTaskRow: () => null,
      insertTask: (t) => {
        expect(t.maxAttempts).toBe(5)
        return 1
      },
      deleteTask: () => {},
      listTasks: () => ({ rows: [], total: 0 }),
      queuedCandidates: () => [],
      depsOf: () => null,
      statusesOf: () => new Map(),
      batchTasks: () => new Map(),
      markClaimed: () => 0,
      transitionStatus: () => 0,
      transaction: <T>(fn: () => T) => fn(),
      expiredLeases: () => [],
      reapTransition: () => 0,
       insertComment: () => 1,
       auditAppend: () => {},
        timelineEntries: () => [],
        commentsOf: () => [],
        nonTerminalChildCount: () => 0,
       childStatusCounts: () => ({ total: 0, open: 0, done: 0, failed: 0, canceled: 0 }),
        promoteEpicWithMirror: () => {},
       appendEpicAuditMirror: () => {}
     }, { leaseTtlMin: s.leaseTtlMin, maxAttempts: s.maxAttempts })

    const result = svc.createTask({ title: 'Flow test', reporter: 'tester' })
    expect(result.ok).toBe(true)
  })

  test('default maxAttempts is 3 when not configured', () => {
    const s = loadSettings({ env: {}, argv: [] })
    expect(s.maxAttempts).toBe(3)
    const svc = new TaskService({
      getTaskRow: () => null,
      insertTask: (t) => {
        expect(t.maxAttempts).toBe(3)
        return 1
      },
      deleteTask: () => {},
      listTasks: () => ({ rows: [], total: 0 }),
      queuedCandidates: () => [],
      depsOf: () => null,
      statusesOf: () => new Map(),
      batchTasks: () => new Map(),
      markClaimed: () => 0,
      transitionStatus: () => 0,
      transaction: <T>(fn: () => T) => fn(),
      expiredLeases: () => [],
      reapTransition: () => 0,
       insertComment: () => 1,
       auditAppend: () => {},
        timelineEntries: () => [],
        commentsOf: () => [],
        nonTerminalChildCount: () => 0,
       childStatusCounts: () => ({ total: 0, open: 0, done: 0, failed: 0, canceled: 0 }),
        promoteEpicWithMirror: () => {},
       appendEpicAuditMirror: () => {}
     }, { leaseTtlMin: s.leaseTtlMin, maxAttempts: s.maxAttempts })

    const result = svc.createTask({ title: 'Default flow', reporter: 'tester' })
    expect(result.ok).toBe(true)
  })
})
