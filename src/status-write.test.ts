import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import {
  STATUS,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  createdStatus,
  statusWrite,
  type CreatedTaskStatus,
  type StatusWrite,
  type TaskStatus
} from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { DEFAULT_MAX_ATTEMPTS } from './defaults'
import { handleCreateTask } from './mcp/task-tools'
import {
  createTestDb,
  closeTestDb,
  insertTaskRow,
  getTaskRow,
  json,
  testProjectId
} from './test-context'

// #2724: core computes the status-write column values, the repo applies them verbatim. Pinned from
// both ends so the rules cannot drift back into db/.

const NOW = '2031-01-01T00:00:00.000Z'
const HOLDER = 'agent-w'
const LEASE = '2031-01-01T00:15:00.000Z'
const NEXT_LEASE = '2031-01-01T00:30:00.000Z'
const PRIOR_STAMP = '2030-12-31T00:00:00.000Z'

type NonInProgressStatus = Exclude<TaskStatus, typeof STATUS.in_progress>

// Derived from the status vocabulary, not hand-written, so a new status cannot slip past the
// coverage below: every status is either in_progress or in this list.
const NON_IN_PROGRESS: readonly NonInProgressStatus[] = TASK_STATUSES.filter(
  (status): status is NonInProgressStatus => status !== STATUS.in_progress
)

const progressWrite = (resetAttempts?: boolean): StatusWrite =>
  statusWrite(
    { status: STATUS.in_progress, lease: { holder: HOLDER, expiresAt: LEASE }, resetAttempts },
    NOW
  )

const otherWrite = (status: NonInProgressStatus, resetAttempts?: boolean): StatusWrite =>
  statusWrite({ status, resetAttempts }, NOW)

const writeFor = (status: TaskStatus): StatusWrite =>
  status === STATUS.in_progress ? progressWrite() : otherWrite(status)

describe('statusWrite mapping (#2724)', () => {
  test('in_progress keeps the holder and its deadline', () => {
    expect(progressWrite()).toEqual({
      status: 'in_progress',
      assignee: HOLDER,
      leaseExpiresAt: LEASE,
      completedAt: null
    })
  })

  test('every other target clears the holder and the deadline', () => {
    const writes = NON_IN_PROGRESS.map((status) => {
      const write = otherWrite(status)
      return [write.status, write.assignee, write.leaseExpiresAt]
    })
    expect(writes).toEqual(NON_IN_PROGRESS.map((status) => [status, null, null]))
  })

  test('the holder is non-NULL exactly while the status is in_progress', () => {
    expect(TASK_STATUSES.map((status) => writeFor(status).assignee === null)).toEqual(
      TASK_STATUSES.map((status) => status !== STATUS.in_progress)
    )
  })

  test('completed_at is stamped exactly for the closed-for-work statuses', () => {
    expect(TASK_STATUSES.map((status) => [status, writeFor(status).completedAt])).toEqual(
      TASK_STATUSES.map((status) => [status, TERMINAL_STATUSES.includes(status) ? NOW : null])
    )
    expect([...TERMINAL_STATUSES]).toEqual(['done', 'failed', 'canceled'])
  })

  test('attempts is written only on a refund, and then it is zero', () => {
    expect('attempts' in progressWrite()).toBe(false)
    expect('attempts' in otherWrite(STATUS.queued, false)).toBe(false)
    expect(progressWrite(true).attempts).toBe(0)
    expect(otherWrite(STATUS.queued, true).attempts).toBe(0)
    expect(otherWrite(STATUS.done, true).attempts).toBe(0)
  })
})

describe('createdStatus (#2724)', () => {
  test('an epic is born open and a regular task queued (ADR 0002)', () => {
    expect(createdStatus(true)).toBe('open')
    expect(createdStatus(false)).toBe('queued')
  })
})

// tsc covers test files, so these two declarations are the assertion: the union admits no half
// lease, so a store can persist the fields as they are without re-deciding who may hold one.
// @ts-expect-error in_progress always carries the holder that renews the lease
const ILLEGAL_PROGRESS: StatusWrite = {
  status: STATUS.in_progress,
  assignee: null,
  leaseExpiresAt: LEASE,
  completedAt: null
}

// @ts-expect-error only in_progress carries a holder, every other target clears it
const ILLEGAL_CLOSE: StatusWrite = {
  status: STATUS.done,
  assignee: HOLDER,
  leaseExpiresAt: null,
  completedAt: NOW
}

describe('the StatusWrite union (#2724)', () => {
  test('each illegal literal differs from the produced write in the pinned field only', () => {
    const legalProgress = progressWrite()
    const legalDone = otherWrite(STATUS.done)
    expect([legalProgress.assignee, ILLEGAL_PROGRESS.assignee]).toEqual([HOLDER, null])
    expect([legalDone.assignee, ILLEGAL_CLOSE.assignee]).toEqual([null, HOLDER])
    expect(ILLEGAL_PROGRESS.leaseExpiresAt).toBe(legalProgress.leaseExpiresAt)
    expect(ILLEGAL_CLOSE.completedAt).toBe(legalDone.completedAt)
  })
})

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => {
  db = createTestDb()
  repo = new TaskRepo(db)
  svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' })
})
afterEach(() => {
  closeTestDb(db)
})

type RowColumns = {
  status: TaskStatus
  assignee: string | null
  lease_expires_at: string | null
  completed_at: string | null
  attempts: number
  max_attempts: number
  version: number
  updated_at: string
  is_epic: boolean
}

const rowColumns = (id: number): RowColumns => {
  const row = getTaskRow(db, id)!
  return {
    status: row.status,
    assignee: row.assignee,
    lease_expires_at: row.lease_expires_at,
    completed_at: row.completed_at,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    updated_at: row.updated_at,
    version: row.version,
    is_epic: row.is_epic
  }
}

// A leased row seeded through markClaimed, so holder and deadline are the constants, not a stamp.
const claimed = (title: string): number => {
  const id = insertTaskRow(repo, { title, reporter: 'dev' })
  const row = getTaskRow(db, id)!
  expect(repo.markClaimed(id, row.version, HOLDER, LEASE, NOW)).toBe(1)
  return id
}

describe('repo.transitionStatus applies a StatusWrite verbatim (#2724)', () => {
  test('every target stores exactly the columns core computed', () => {
    const outcomes = TASK_STATUSES.map((status) => {
      const id = claimed(`verbatim ${status}`)
      const before = rowColumns(id)
      const write = writeFor(status)
      const changes = repo.transitionStatus(id, before.version, write, NOW)
      return { status, changes, after: rowColumns(id), before, write }
    })
    for (const { status, changes, after, before, write } of outcomes) {
      expect({ status, changes, after }).toEqual({
        status,
        changes: 1,
        after: {
          status: write.status,
          assignee: write.assignee,
          lease_expires_at: write.leaseExpiresAt,
          completed_at: write.completedAt,
          attempts: before.attempts,
          max_attempts: before.max_attempts,
          version: before.version + 1,
          updated_at: NOW,
          is_epic: false
        }
      })
    }
  })

  test('an in_progress write keeps a live holder and deadline', () => {
    const id = claimed('renew')
    const before = rowColumns(id)
    const write = statusWrite(
      { status: STATUS.in_progress, lease: { holder: 'agent-next', expiresAt: NEXT_LEASE } },
      NOW
    )
    expect(repo.transitionStatus(id, before.version, write, NOW)).toBe(1)
    const after = rowColumns(id)
    expect(after.assignee).toBe('agent-next')
    expect(after.lease_expires_at).toBe(NEXT_LEASE)
    expect(after.status).toBe('in_progress')
  })

  // COALESCE in the statement means "null leaves the stamp alone", so a write that names no
  // completion time can never erase one — and a terminal write still overrides an older stamp.
  test('a null completed_at leaves an existing stamp alone, a stamped one overwrites it', () => {
    const id = claimed('coalesce')
    db.run('UPDATE tasks SET completed_at = ? WHERE id = ?', [PRIOR_STAMP, id])
    const blocked = otherWrite(STATUS.blocked)
    expect(blocked.completedAt).toBeNull()
    expect(repo.transitionStatus(id, rowColumns(id).version, blocked, NOW)).toBe(1)
    expect(rowColumns(id).completed_at).toBe(PRIOR_STAMP)

    const done = otherWrite(STATUS.done)
    expect(done.completedAt).toBe(NOW)
    expect(repo.transitionStatus(id, rowColumns(id).version, done, NOW)).toBe(1)
    expect(rowColumns(id).completed_at).toBe(NOW)
  })

  test('attempts moves only when the write carries it, and a refund carries zero', () => {
    const id = claimed('attempts')
    db.run('UPDATE tasks SET attempts = 2 WHERE id = ?', [id])

    expect(repo.transitionStatus(id, rowColumns(id).version, otherWrite(STATUS.blocked), NOW)).toBe(
      1
    )
    expect(rowColumns(id).attempts).toBe(2)

    const refund = otherWrite(STATUS.queued, true)
    expect(refund.attempts).toBe(0)
    expect(repo.transitionStatus(id, rowColumns(id).version, refund, NOW)).toBe(1)
    expect(rowColumns(id).attempts).toBe(0)
  })

  test('a stale version is refused and the row is untouched', () => {
    const id = claimed('stale')
    const before = rowColumns(id)
    expect(repo.transitionStatus(id, before.version - 1, otherWrite(STATUS.done), NOW)).toBe(0)
    expect(rowColumns(id)).toEqual(before)
  })
})

describe('repo.reapTransition applies the completion core computed (#2724)', () => {
  test('a requeue carries no completion stamp and clears the lease', () => {
    const id = claimed('reap queued')
    db.run('UPDATE tasks SET attempts = 1 WHERE id = ?', [id])
    const before = rowColumns(id)
    expect(repo.reapTransition(id, before.version, STATUS.queued, 2, NOW, null)).toBe(1)
    expect(rowColumns(id)).toEqual({
      ...before,
      status: 'queued',
      assignee: null,
      lease_expires_at: null,
      completed_at: null,
      attempts: 2,
      version: before.version + 1,
      updated_at: NOW
    })
  })

  test('a failed reap carries the completion stamp core passed in', () => {
    const id = claimed('reap failed')
    const before = rowColumns(id)
    expect(repo.reapTransition(id, before.version, STATUS.failed, 4, NOW, NOW)).toBe(1)
    expect(rowColumns(id)).toEqual({
      ...before,
      status: 'failed',
      assignee: null,
      lease_expires_at: null,
      completed_at: NOW,
      attempts: 4,
      version: before.version + 1,
      updated_at: NOW
    })
  })

  test('a stale version is refused and the row is untouched', () => {
    const id = claimed('reap stale')
    const before = rowColumns(id)
    expect(repo.reapTransition(id, before.version - 1, STATUS.failed, 4, NOW, NOW)).toBe(0)
    expect(rowColumns(id)).toEqual(before)
  })
})

describe('creation stores the status and max_attempts core resolved (#2724)', () => {
  const insert = (status: CreatedTaskStatus, maxAttempts: number, isEpic = false) =>
    repo.insertTask({
      title: `${status} ${maxAttempts}`,
      description: null,
      status,
      priority: 'p2',
      reporter: 'dev',
      depends_on: '[]',
      now: NOW,
      maxAttempts,
      isEpic,
      projectId: testProjectId(repo)
    })

  test('insertTask stores exactly the status and max_attempts it is given', () => {
    const open = insert(STATUS.open, 7, true)
    expect(open.status).toBe('open')
    expect(rowColumns(open.id)).toEqual({
      status: 'open',
      assignee: null,
      lease_expires_at: null,
      completed_at: null,
      attempts: 0,
      max_attempts: 7,
      version: 1,
      updated_at: NOW,
      is_epic: true
    })

    const queued = insert(STATUS.queued, 2)
    expect(queued.status).toBe('queued')
    expect(rowColumns(queued.id)).toEqual({
      status: 'queued',
      assignee: null,
      lease_expires_at: null,
      completed_at: null,
      attempts: 0,
      max_attempts: 2,
      version: 1,
      updated_at: NOW,
      is_epic: false
    })
  })

  test('a task is born queued with the resolved default max_attempts', () => {
    const res = json(handleCreateTask(svc, { title: 'Task', reporter: 'dev' }))
    expect(res.status).toBe('queued')
    expect(rowColumns(res.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      is_epic: false
    })
  })

  test('an epic is born open, also with the resolved default max_attempts', () => {
    const res = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    expect(res.status).toBe('open')
    expect(rowColumns(res.id)).toMatchObject({
      status: 'open',
      attempts: 0,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      is_epic: true
    })
  })

  test('a configured max_attempts reaches the row: the store has no fallback of its own', () => {
    const custom = new TaskService(repo, { leaseTtlMin: 15, maxAttempts: 5, scope: 'test' })
    const res = json(handleCreateTask(custom, { title: 'Custom', reporter: 'dev' }))
    expect(rowColumns(res.id).max_attempts).toBe(5)
  })
})
