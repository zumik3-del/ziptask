import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
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
afterEach(() => { closeTestDb(db) })

// The queue order is (priority, created_at ASC, id ASC): one shared timestamp makes the seeded
// order the queue order, so the position of a row is the offset it is reached at.
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const CREATED_AT_LATER = '2026-01-01T00:00:01.000Z'

function seedQueued(title: string, opts: { dependsOn?: number[]; createdAt?: string } = {}): number {
  return repo.insertTask({
    title,
    description: null,
    priority: 'p2',
    assignee: null,
    reporter: 'dev',
    depends_on: JSON.stringify(opts.dependsOn ?? []),
    now: opts.createdAt ?? CREATED_AT,
    projectId
  })
}

// The ids of the listed queue rows, in listing order.
function queueIds(): number[] {
  return text(handleListQueue(svc, {}))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => Number(line.split('|')[0]))
}

// The candidate scan is paged (CANDIDATES_PAGE_SIZE rows per page) and the page cursor must not be
// bounded by the result ceiling: a queue longer than MAX_RESULT_LIMIT (1000) hides its tail
// otherwise, and a clamped cursor re-reads the same page, so one task is listed over and over.
describe('candidate pagination past the clamped offset (#1847)', () => {
  test('list_queue reaches a ready row behind 1100 queued rows', () => {
    // The blocker sorts last, so it is the only ready row and it sits behind 1100 queued rows.
    const blocker = seedQueued('blocker', { createdAt: CREATED_AT_LATER })
    repo.transaction(() => {
      for (let i = 0; i < 1100; i++) seedQueued(`dependent ${i}`, { dependsOn: [blocker] })
    })

    expect(queueIds()).toEqual([blocker])
  }, 30000)

  test('claim_task auto-pick claims a ready row behind 1100 queued rows', () => {
    const blocker = seedQueued('blocker', { createdAt: CREATED_AT_LATER })
    repo.transaction(() => {
      for (let i = 0; i < 1100; i++) seedQueued(`dependent ${i}`, { dependsOn: [blocker] })
    })

    const claim = handleClaimTask(svc, { agent: 'agent-1' })
    expect(claim.isError).toBeFalsy()
    expect(json(claim).id).toBe(blocker)
  }, 30000)

  test('list_queue lists a ready row inside the 1000-1099 window exactly once', () => {
    // The ready row has no deps and sorts last. The blocker depends on it, so the blocker is not
    // ready either, and the 1000 dependents depend on the blocker: the ready row is the only ready
    // row and it sits at queue position 1002 - inside the page the clamped cursor re-read forever.
    const ready = seedQueued('ready', { createdAt: CREATED_AT_LATER })
    const blocker = seedQueued('blocker', { dependsOn: [ready] })
    repo.transaction(() => {
      for (let i = 0; i < 1000; i++) seedQueued(`dependent ${i}`, { dependsOn: [blocker] })
    })

    const ids = queueIds()
    // The distinct ids are the assertion: a re-read page must not list the same task twice.
    expect([...new Set(ids)]).toEqual([ready])
    expect(ids).toEqual([ready])
  }, 30000)

  test('queuedCandidates reads past the 1000-row result ceiling', () => {
    const ids: number[] = []
    repo.transaction(() => {
      for (let i = 0; i < 1101; i++) ids.push(seedQueued(`task ${i}`))
    })

    // The offset is an internal scan cursor, not a result limit: it must not be clamped to
    // MAX_RESULT_LIMIT (1000), or the tail of a long queue is unreachable.
    const tail = repo.queuedCandidates(100, projectId, 1100)
    expect(tail.map((task) => task.id)).toEqual([ids[1100]])
  }, 30000)
})
