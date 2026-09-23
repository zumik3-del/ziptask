import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { TaskRepo } from './db/repo'
import { MetricsRepo } from './db/metrics-repo'
import { TaskService } from './core/service'
import { computeMetrics } from './core/metrics'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus
} from './mcp/tools'
import { createTestDb, closeTestDb, json, driveToDone } from './test-context'

let db: Database
let repo: TaskRepo
let metrics: MetricsRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); metrics = new MetricsRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })

function versionOf(id: number): number {
  return json(handleGetTask(svc, { id, fields: ['version'] })).version
}

function createCanceledTask(title: string): number {
  const id = json(handleCreateTask(svc, { title, reporter: 'dev' })).id
  handleUpdateStatus(svc, { id, agent: 'dev', status: 'canceled', version: versionOf(id) })
  return id
}

function createDoneTask(title: string): number {
  const id = json(handleCreateTask(svc, { title, reporter: 'dev' })).id
  handleClaimTask(svc, { agent: 'dev', task_id: id })
  handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: versionOf(id) })
  handleUpdateStatus(svc, { id, agent: 'dev', status: 'done', version: versionOf(id) })
  return id
}

describe('metrics canceled (#112)', () => {
  test('done_count excludes canceled tasks; canceled_count counts them', () => {
    createDoneTask('Done')
    createCanceledTask('Canceled')

    const allSince = '0001-01-01T00:00:00.000Z'
    expect(metrics.doneCount(allSince)).toBe(1)
    expect(metrics.canceledCount(allSince)).toBe(1)

    const m = computeMetrics(metrics, 'all')
    expect(m.doneCount).toBe(1)
    expect(m.canceledCount).toBe(1)
  })

  test('canceled_count excludes canceled epics', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'canceled', version: versionOf(epicId) })

    expect(metrics.canceledCount('0001-01-01T00:00:00.000Z')).toBe(0)
    expect(computeMetrics(metrics, 'all').canceledCount).toBe(0)
  })

  test('scripts/metrics.ts output surfaces canceled_count and done_count', () => {
    createDoneTask('Done')
    createCanceledTask('Canceled')
    const dbPath = (db as any).__path as string
    const script = join(import.meta.dir, '..', 'scripts', 'metrics.ts')

    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', script, '--db', dbPath, '--period', 'all'],
      cwd: join(import.meta.dir, '..')
    })
    const out = proc.stdout.toString()
    expect(proc.exitCode).toBe(0)
    expect(out).toContain('done_count|1')
    expect(out).toContain('canceled_count|1')
  })
})

describe('computeMetrics period validation (#431)', () => {
  test('period=0 throws RangeError', () => {
    expect(() => computeMetrics(metrics, 0)).toThrow(/period must be a positive number/)
  })

  test('period=negative throws RangeError', () => {
    expect(() => computeMetrics(metrics, -1)).toThrow(/period must be a positive number/)
  })

  test('period=NaN throws RangeError', () => {
    expect(() => computeMetrics(metrics, Number.NaN)).toThrow(/period must be a positive number/)
  })

  test('period=Infinity throws RangeError', () => {
    expect(() => computeMetrics(metrics, Number.POSITIVE_INFINITY)).toThrow(/period must be a positive number/)
  })

  test('period="all" works', () => {
    const m = computeMetrics(metrics, 'all')
    expect(m).toHaveProperty('doneCount')
    expect(m).toHaveProperty('canceledCount')
  })

  test('period=positive number works', () => {
    const m = computeMetrics(metrics, 24)
    expect(m).toHaveProperty('doneCount')
    expect(m).toHaveProperty('canceledCount')
  })

  test('period=undefined uses default 24h', () => {
    const m = computeMetrics(metrics)
    expect(m).toHaveProperty('doneCount')
  })
})

describe('auditLogCount (#431)', () => {
  test('returns 0 for empty audit_log', () => {
    expect(metrics.auditLogCount()).toBe(0)
  })

  test('returns correct count after operations', () => {
    json(handleCreateTask(svc, { title: 'Count1', reporter: 'dev' }))
    json(handleCreateTask(svc, { title: 'Count2', reporter: 'dev' }))
    expect(metrics.auditLogCount()).toBe(2)
    handleClaimTask(svc, { agent: 'dev', task_id: 1 })
    expect(metrics.auditLogCount()).toBe(3)
  })
})

describe('metrics CLI empty audit_log warning (#431)', () => {
  test('stderr warning when audit_log is empty', () => {
    const dbPath = (db as any).__path as string
    const script = join(import.meta.dir, '..', 'scripts', 'metrics.ts')
    const proc = Bun.spawnSync({
      cmd: ['bun', 'run', script, '--db', dbPath, '--period', 'all'],
      cwd: join(import.meta.dir, '..')
    })
    const err = proc.stderr.toString()
    expect(err).toContain('Warning: audit_log is empty')
    expect(proc.exitCode).toBe(0)
  })
})

describe('MetricsRepo focused tests (#767)', () => {
  test('doneCount returns 0 when no tasks exist', () => {
    expect(metrics.doneCount('0001-01-01T00:00:00.000Z')).toBe(0)
  })

  test('canceledCount returns 0 when no tasks exist', () => {
    expect(metrics.canceledCount('0001-01-01T00:00:00.000Z')).toBe(0)
  })

  test('auditLogCount returns 0 for empty audit_log', () => {
    expect(metrics.auditLogCount()).toBe(0)
  })

  test('statusDurations returns empty array when no tasks exist', () => {
    const durations = metrics.statusDurations('0001-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')
    expect(durations).toEqual([])
  })

  test('doneCount only counts non-epic done tasks', () => {
    const plainId = json(handleCreateTask(svc, { title: 'Plain', reporter: 'dev' })).id
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id

    driveToDone(svc, plainId, 'dev')
    handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'done', version: 1 })

    expect(metrics.doneCount('0001-01-01T00:00:00.000Z')).toBe(1)
  })

  test('canceledCount only counts non-epic canceled tasks', () => {
    const plainId = json(handleCreateTask(svc, { title: 'PlainCancel', reporter: 'dev' })).id
    const epicId = json(handleCreateTask(svc, { title: 'EpicCancel', reporter: 'dev', epic: true })).id

    handleUpdateStatus(svc, { id: plainId, agent: 'dev', status: 'canceled', version: 1 })
    handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'canceled', version: 1 })

    expect(metrics.canceledCount('0001-01-01T00:00:00.000Z')).toBe(1)
  })

  test('MetricsRepo implements MetricsStore interface correctly', () => {
    // Verify all required methods exist and have correct signatures
    expect(typeof metrics.doneCount).toBe('function')
    expect(typeof metrics.canceledCount).toBe('function')
    expect(typeof metrics.auditLogCount).toBe('function')
    expect(typeof metrics.statusDurations).toBe('function')
    // All return expected types
    expect(typeof metrics.doneCount('0001-01-01T00:00:00.000Z')).toBe('number')
    expect(typeof metrics.canceledCount('0001-01-01T00:00:00.000Z')).toBe('number')
    expect(typeof metrics.auditLogCount()).toBe('number')
    expect(Array.isArray(metrics.statusDurations('0001-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z'))).toBe(true)
  })
})
