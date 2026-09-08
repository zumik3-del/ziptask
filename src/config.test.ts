import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings, DEFAULTS } from './config'
import { TaskService } from './core/service'

const TMP = '/tmp/opencode'

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
      http: { ...DEFAULTS.http },
      defaults: { ...DEFAULTS.defaults }
    })
  })

  test('returns all defaults with empty env and empty argv', () => {
    const s = loadSettings({ env: {}, argv: [] })
    expect(s.dbPath).toBe('./data/ziptask.db')
    expect(s.host).toBe('127.0.0.1')
    expect(s.port).toBe(0)
    expect(s.leaseTtlMin).toBe(15)
    expect(s.maxAttempts).toBe(3)
    expect(s.http.maxSessions).toBe(100)
    expect(s.http.sessionTtlMs).toBe(3_600_000)
    expect(s.defaults.priority).toBe('p2')
    expect(s.defaults.reporter).toBe('system')
    expect(s.defaults.listLimit).toBe(50)
    expect(s.defaults.timelineLimit).toBe(50)
    expect(s.defaults.queueLimit).toBe(100)
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
      statusOf: () => null,
      statusesOf: () => new Map(),
      batchTasks: () => new Map(),
      markClaimed: () => 0,
      transitionStatus: () => {},
      expiredLeases: () => [],
      reapSettle: () => 0,
      insertComment: () => 1,
      auditAppend: () => {},
      timelineEntries: () => [],
      doneCount: () => 0,
      taskSummaries: () => [],
      auditTransitionsForTasks: () => []
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
      statusOf: () => null,
      statusesOf: () => new Map(),
      batchTasks: () => new Map(),
      markClaimed: () => 0,
      transitionStatus: () => {},
      expiredLeases: () => [],
      reapSettle: () => 0,
      insertComment: () => 1,
      auditAppend: () => {},
      timelineEntries: () => [],
      doneCount: () => 0,
      taskSummaries: () => [],
      auditTransitionsForTasks: () => []
    }, { leaseTtlMin: s.leaseTtlMin, maxAttempts: s.maxAttempts })

    const result = svc.createTask({ title: 'Default flow', reporter: 'tester' })
    expect(result.ok).toBe(true)
  })
})
