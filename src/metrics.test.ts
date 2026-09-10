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
