import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { ok } from './core/result'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { handleClaimTask, handleListQueue } from './mcp/task-tools'
import { createTestDb, closeTestDb, json, text, testProjectId } from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
let projectId: number

beforeEach(() => {
  db = createTestDb()
  repo = new TaskRepo(db)
  svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' })
  projectId = testProjectId(repo)
})
afterEach(() => {
  closeTestDb(db)
})

const CREATED_AT = '2026-01-01T00:00:00.000Z'
const CREATED_AT_LATER = '2026-01-01T00:00:01.000Z'

function seedQueued(
  title: string,
  opts: { dependsOn?: number[]; createdAt?: string } = {}
): number {
  return repo.insertTask({
    title,
    description: null,
    priority: 'p2',
    reporter: 'dev',
    depends_on: JSON.stringify(opts.dependsOn ?? []),
    now: opts.createdAt ?? CREATED_AT,
    projectId
  }).id
}

function queueIds(): number[] {
  return text(handleListQueue(svc, {}))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => Number(line.split('|')[0]))
}

describe('candidate pagination past the clamped offset (#1847)', () => {
  test('list_queue reaches a ready row behind 1100 queued rows', () => {
    const blocker = seedQueued('blocker', { createdAt: CREATED_AT_LATER })
    repo.transaction(() => {
      for (let i = 0; i < 1100; i++) seedQueued(`dependent ${i}`, { dependsOn: [blocker] })
      return ok(undefined)
    })

    expect(queueIds()).toEqual([blocker])
  })

  test('claim_task auto-pick claims a ready row behind 1100 queued rows', () => {
    const blocker = seedQueued('blocker', { createdAt: CREATED_AT_LATER })
    repo.transaction(() => {
      for (let i = 0; i < 1100; i++) seedQueued(`dependent ${i}`, { dependsOn: [blocker] })
      return ok(undefined)
    })

    const claim = handleClaimTask(svc, { agent: 'agent-1' })
    expect(claim.isError).toBeFalsy()
    expect(json(claim).id).toBe(blocker)
  })

  test('list_queue lists a ready row inside the 1000-1099 window exactly once', () => {
    const ready = seedQueued('ready', { createdAt: CREATED_AT_LATER })
    const blocker = seedQueued('blocker', { dependsOn: [ready] })
    repo.transaction(() => {
      for (let i = 0; i < 1000; i++) seedQueued(`dependent ${i}`, { dependsOn: [blocker] })
      return ok(undefined)
    })

    const ids = queueIds()
    expect([...new Set(ids)]).toEqual([ready])
    expect(ids).toEqual([ready])
  })

  test('queuedCandidates reads past the 1000-row result ceiling', () => {
    const ids: number[] = []
    repo.transaction(() => {
      for (let i = 0; i < 1101; i++) ids.push(seedQueued(`task ${i}`))
      return ok(undefined)
    })

    const tail = repo.queuedCandidates(100, projectId, 1100)
    expect(tail.map((task) => task.id)).toEqual([ids[1100]])
  })
})
