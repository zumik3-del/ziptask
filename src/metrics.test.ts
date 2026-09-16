import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { computeMetrics } from './core/metrics'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus
} from './mcp/tools'
import { createTestDb, closeTestDb, json } from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
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
    expect(repo.doneCount(allSince)).toBe(1)
    expect(repo.canceledCount(allSince)).toBe(1)

    const m = computeMetrics(repo, 'all')
    expect(m.doneCount).toBe(1)
    expect(m.canceledCount).toBe(1)
  })

  test('canceled_count excludes canceled epics', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'canceled', version: versionOf(epicId) })

    expect(repo.canceledCount('0001-01-01T00:00:00.000Z')).toBe(0)
    expect(computeMetrics(repo, 'all').canceledCount).toBe(0)
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
    expect(() => computeMetrics(repo, 0)).toThrow(/period must be a positive number/)
  })

  test('period=negative throws RangeError', () => {
    expect(() => computeMetrics(repo, -1)).toThrow(/period must be a positive number/)
  })

  test('period=NaN throws RangeError', () => {
    expect(() => computeMetrics(repo, Number.NaN)).toThrow(/period must be a positive number/)
  })

  test('period=Infinity throws RangeError', () => {
    expect(() => computeMetrics(repo, Number.POSITIVE_INFINITY)).toThrow(/period must be a positive number/)
  })

  test('period="all" works', () => {
    const m = computeMetrics(repo, 'all')
    expect(m).toHaveProperty('doneCount')
    expect(m).toHaveProperty('canceledCount')
  })

  test('period=positive number works', () => {
    const m = computeMetrics(repo, 24)
    expect(m).toHaveProperty('doneCount')
    expect(m).toHaveProperty('canceledCount')
  })

  test('period=undefined uses default 24h', () => {
    const m = computeMetrics(repo)
    expect(m).toHaveProperty('doneCount')
  })
})

describe('auditLogCount (#431)', () => {
  test('returns 0 for empty audit_log', () => {
    expect(repo.auditLogCount()).toBe(0)
  })

  test('returns correct count after operations', () => {
    json(handleCreateTask(svc, { title: 'Count1', reporter: 'dev' }))
    json(handleCreateTask(svc, { title: 'Count2', reporter: 'dev' }))
    expect(repo.auditLogCount()).toBe(2)
    handleClaimTask(svc, { agent: 'dev', task_id: 1 })
    expect(repo.auditLogCount()).toBe(3)
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
