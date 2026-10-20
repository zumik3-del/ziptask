import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { isValidTransition, STATUS_CODES, TASK_STATUSES, TERMINAL_STATUSES, nowIso, codePointLength } from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { TERMINAL_STATUSES_SQL } from './db/sql'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus, handleListTasks
} from './mcp/task-tools'
import {
  createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text, testProjectId, driveToDone,
  type CreateTaskRowOpts
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' }) })
afterEach(() => { closeTestDb(db) })
const createTaskRow = (opts: CreateTaskRowOpts) => insertTaskRow(repo, opts)

describe('create_task', () => {
  test('creates task with defaults', () => {
    const id = createTaskRow({ title: 'Test task', reporter: 'dev' })
    expect(id).toBeGreaterThan(0)
    const task = getTaskRow(db, id)
    expect(task.title).toBe('Test task')
    expect(task.status).toBe('queued')
    expect(task.priority).toBe('p2')
    expect(task.reporter).toBe('dev')
  })

  test('creates queued even with unsatisfied deps (v2)', () => {
    const res = json(handleCreateTask(svc, { title: 'Dependent', reporter: 'dev', depends_on: [999] }))
    expect(res.status).toBe('queued')
    const task = getTaskRow(db, res.id)
    expect(task.status).toBe('queued')
  })

  test('rejects forward-reference cycle pair', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev', depends_on: [2] })).id
    const cycle = handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [a] })
    expect(text(cycle)).toContain('CYCLE')
    expect(getTaskRow(db, a).title).toBe('A')
    expect(getTaskRow(db, 2)).toBeNull()
  })

  test('cycle rejection leaks no audit or comment rows', () => {
    handleCreateTask(svc, { title: 'A', reporter: 'dev', depends_on: [2] })
    handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [1], description: 'leak check' })
    const audit = db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = 2').get() as { n: number }
    const comments = db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = 2').get() as { n: number }
    expect(audit.n).toBe(0)
    expect(comments.n).toBe(0)
  })

  test('manual blocked and back to queued (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'Manual', reporter: 'dev' })).id
    const blocked = json(handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 }))
    expect(blocked.status).toBe('blocked')
    const unblocked = json(handleUpdateStatus(svc, { id, agent: 'dev', status: 'queued', version: 2 }))
    expect(unblocked.status).toBe('queued')
  })

  test('tool create_task stores no removed fields (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'Clean', reporter: 'dev' })).id
    const row = getTaskRow(db, id)
    expect(row.task_path).toBeUndefined()
    expect(row.result_path).toBeUndefined()
    expect(row.parent_id).toBeUndefined()
  })
})

describe('claim_task', () => {
  test('claims a queued task', () => {
    const id = createTaskRow({ title: 'Claim me', reporter: 'dev' })
    const res = handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const result = json(res)
    expect(result.id).toBe(id)
    const task = getTaskRow(db, id)
    expect(task.status).toBe('in_progress')
    expect(task.assignee).toBe('agent-1')
  })

  test('picks best priority from queue', () => {
    createTaskRow({ title: 'P2', reporter: 'dev', priority: 'p2' })
    const p0id = createTaskRow({ title: 'P0', reporter: 'dev', priority: 'p0' })
    createTaskRow({ title: 'P1', reporter: 'dev', priority: 'p1' })
    const res = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res).id).toBe(p0id)
  })

  test('include returns requested fields with lease_ttl_min (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'With desc', reporter: 'dev', description: 'Do the thing' })).id
    const res = json(handleClaimTask(svc, { agent: 'agent-1', task_id: id, include: ['description'] }))
    expect(res.id).toBe(id)
    expect(res.lease_ttl_min).toBe(15)
    expect(res.lease_until).toBeUndefined()
    expect(res.description).toBe('Do the thing')
  })

  test('include omits null fields (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'No desc', reporter: 'dev' })).id
    const res = json(handleClaimTask(svc, { agent: 'agent-1', task_id: id, include: ['description'] }))
    expect('description' in res).toBe(false)
    expect(res.lease_ttl_min).toBe(15)
  })

  test('claims a blocked task and transitions to in_progress with lease', () => {
    const id = createTaskRow({ title: 'BlockClaim', reporter: 'dev' })
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 })
    const taskBefore = getTaskRow(db, id)
    expect(taskBefore.status).toBe('blocked')
    const res = handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const result = json(res)
    expect(result.id).toBe(id)
    const taskAfter = getTaskRow(db, id)
    expect(taskAfter.status).toBe('in_progress')
    expect(taskAfter.assignee).toBe('agent-1')
    expect(taskAfter.lease_expires_at).not.toBeNull()
    const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
    expect(logs.map((l: any) => l.action)).toContain('claim')
  })

  test('blocked task: claim-first path to review', () => {
    const id = createTaskRow({ title: 'BlockReview', reporter: 'dev' })
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version })
    expect(json(res).status).toBe('review')
    const after = getTaskRow(db, id)
    expect(after.status).toBe('review')
    // `assignee` is the lease holder: the row left in_progress, so the holder is cleared.
    expect(after.assignee).toBeNull()
  })

  test('blocked→review without claim is valid transition (no assignee guard)', () => {
    const id = createTaskRow({ title: 'BlockNoClaim', reporter: 'dev' })
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'other-agent', status: 'review', version: task.version })
    expect(json(res).status).toBe('review')
  })
})

describe('update_status', () => {
  test('valid transition', () => {
    const id = createTaskRow({ title: 'Transition', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const updateRes = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version })
    expect(json(updateRes).status).toBe('review')
  })

  test('rejects invalid transition', () => {
    const id = createTaskRow({ title: 'Bad', reporter: 'dev' })
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: 1 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID')
  })

  test('version conflict', () => {
    const id = createTaskRow({ title: 'Conflict', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    // After claim, version bumped to 2
    expect(task.version).toBe(2)
    // Update with correct (fresh) version succeeds
    const updateRes = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version })
    expect(json(updateRes).status).toBe('review')
    // Stale version conflicts
    const conflictRes = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: 1 })
    expect(conflictRes.isError).toBe(true)
    expect(text(conflictRes)).toContain('CONFLICT')
  })

  test('comment typed comment on non-terminal, resolution on terminal (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'Typed', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1' })
    const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v1, comment: 'check please' })
    const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: v2, comment: 'result at result-x.md' })
    const rows = db.query('SELECT type, content FROM comments WHERE task_id = ? ORDER BY id').all(id) as any[]
    expect(rows.length).toBe(2)
    expect(rows[0].type).toBe('comment')
    expect(rows[0].content).toBe('check please')
    expect(rows[1].type).toBe('resolution')
    expect(rows[1].content).toBe('result at result-x.md')
  })

  test('failed status produces resolution comment (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'Fail', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1' })
    const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'failed', version: v1, comment: 'broken' })
    const rows = db.query('SELECT type FROM comments WHERE task_id = ?').all(id) as any[]
    expect(rows[0].type).toBe('resolution')
  })

  test('addComment defaults to comment type (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id
    repo.insertComment(id, 'dev', 'plain note')
    const row = db.query('SELECT type FROM comments WHERE task_id = ?').get(id) as any
    expect(row.type).toBe('comment')
  })
})

describe('lease expiry', () => {
  test('expired lease returns to queued', () => {
    const id = createTaskRow({ title: 'Lease', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    svc.reapExpiredLeases()
    const task = getTaskRow(db, id)
    expect(task.status).toBe('queued')
    expect(task.attempts).toBe(1)
    expect(task.lease_expires_at).toBeNull()
    const auditRows = db.query('SELECT * FROM audit_log WHERE task_id = ? AND action = ?').all(id, 'lease_expired') as any[]
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].old_value).toBe('in_progress')
    expect(auditRows[0].new_value).toBe('queued')
  })

  test('max attempts leads to failed', () => {
    const id = createTaskRow({ title: 'Max attempts', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour'), attempts = 3 WHERE id = ?", [id])
    svc.reapExpiredLeases()
    const task = getTaskRow(db, id)
    expect(task.status).toBe('failed')
    expect(task.attempts).toBe(4)
    expect(task.lease_expires_at).toBeNull()
    expect(task.completed_at).not.toBeNull()
    const auditRows = db.query('SELECT * FROM audit_log WHERE task_id = ? AND action = ?').all(id, 'lease_expired') as any[]
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].new_value).toBe('failed')
  })
})

describe('version bump on claim and reap', () => {
  test('claim bumps version from 1 to 2', () => {
    const id = createTaskRow({ title: 'Bump', reporter: 'dev' })
    const res = json(handleClaimTask(svc, { agent: 'agent-1', task_id: id }))
    expect(res.version).toBe(2)
    const task = getTaskRow(db, id)
    expect(task.version).toBe(2)
  })

  test('claim response carries version at tools level', () => {
    const id = json(handleCreateTask(svc, { title: 'ToolVer', reporter: 'dev' })).id
    const res = json(handleClaimTask(svc, { agent: 'agent-1', task_id: id }))
    expect(res.id).toBe(id)
    expect(res.version).toBe(2)
    expect(res.lease_ttl_min).toBe(15)
  })

  test('reap bumps version', () => {
    const id = createTaskRow({ title: 'ReapBump', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const taskBeforeReap = getTaskRow(db, id)
    expect(taskBeforeReap.version).toBe(2)
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    svc.reapExpiredLeases()
    const taskAfterReap = getTaskRow(db, id)
    expect(taskAfterReap.status).toBe('queued')
    expect(taskAfterReap.version).toBe(3)
  })
})

describe('version race regression', () => {
  test('regression S1: stale-version update after reap+re-claim conflicts', () => {
    const id = createTaskRow({ title: 'S1', reporter: 'dev' })
    // Step 1: agent-1 claims (v1→v2)
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    // Step 2: expire and reap (v2→v3, status→queued)
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    svc.reapExpiredLeases()
    // Step 3: agent-2 re-claims (v3→v4)
    handleClaimTask(svc, { agent: 'agent-2', task_id: id })
    const task = getTaskRow(db, id)
    expect(task.version).toBe(4)
    expect(task.assignee).toBe('agent-2')
    // Step 4: orchestrator (holding stale v1 from before any claim) tries update_status
    const conflictRes = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: 1 })
    expect(conflictRes.isError).toBe(true)
    expect(text(conflictRes)).toContain('expected version')
  })

  test('double-claim CAS: second claim returns 0 changes', () => {
    const id = createTaskRow({ title: 'DoubleClaim', reporter: 'dev' })
    const row = getTaskRow(db, id)
    expect(row.version).toBe(1)
    // First claim succeeds (v1→v2)
    const c1 = repo.markClaimed(id, 1, 'agent-a', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
    expect(c1).toBe(1)
    // Second claim with same expected version fails (0 changes)
    const c2 = repo.markClaimed(id, 1, 'agent-b', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
    expect(c2).toBe(0)
    // Original assignee retained
    const final = getTaskRow(db, id)
    expect(final.assignee).toBe('agent-a')
    expect(final.version).toBe(2)
  })

  test('reap guard: concurrent holder write defeats reap', () => {
    const id = createTaskRow({ title: 'ReapGuard', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    // v2 after claim
    const task = getTaskRow(db, id)
    expect(task.version).toBe(2)
    // Force-expire the lease
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    // Simulate holder's concurrent write bumping version (but not changing status)
    db.run("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), id])
    // Reap with original expectedVersion=2; DB now has 3 → 0 changes
    const changes = repo.reapTransition(id, 2, 'queued', 2, new Date().toISOString())
    expect(changes).toBe(0)
    // Status stays in_progress
    const final = getTaskRow(db, id)
    expect(final.status).toBe('in_progress')
    expect(final.version).toBe(3)
    // No lease_expired audit row
    const audits = db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = ?').get(id, 'lease_expired') as { n: number }
    expect(audits.n).toBe(0)
  })
})

describe('priority ordering', () => {
  test('list_queue returns p0 before p1 before p2', () => {
    createTaskRow({ title: 'P2', reporter: 'dev', priority: 'p2' })
    createTaskRow({ title: 'P3', reporter: 'dev', priority: 'p3' })
    const p1id = createTaskRow({ title: 'P1', reporter: 'dev', priority: 'p1' })
    const p0id = createTaskRow({ title: 'P0', reporter: 'dev', priority: 'p0' })
    const res1 = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res1).id).toBe(p0id)
    const res2 = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res2).id).toBe(p1id)
  })
})

describe('terminal status', () => {
  test('done is terminal', () => {
    expect(isValidTransition('done', 'queued')).toBe(false)
    expect(isValidTransition('done', 'in_progress')).toBe(false)
  })
  test('failed is terminal', () => {
    expect(isValidTransition('failed', 'queued')).toBe(false)
  })
  test('canceled is in TASK_STATUSES and STATUS_CODES maps to 7', () => {
    expect(TASK_STATUSES).toContain('canceled')
    expect(STATUS_CODES.canceled).toBe(7)
  })
  test('canceled is terminal: no out-transitions for any status', () => {
    for (const to of TASK_STATUSES) {
      expect(isValidTransition('canceled', to)).toBe(false)
    }
  })
})

describe('terminal-status single source (#1445)', () => {
  test('TERMINAL_STATUSES (TS) and TERMINAL_STATUSES_SQL (SQL) describe the same set', () => {
    const parsedSql = TERMINAL_STATUSES_SQL.replace(/[()']/g, '').split(', ')
    expect(parsedSql).toEqual([...TERMINAL_STATUSES])
  })

  test('TERMINAL_STATUSES is exactly the set of statuses with no outgoing transition', () => {
    for (const status of TASK_STATUSES) {
      const isTerminalByTransitions = TASK_STATUSES.every(to => !isValidTransition(status, to))
      expect(`${status}:${TERMINAL_STATUSES.includes(status)}`).toBe(`${status}:${isTerminalByTransitions}`)
    }
  })
})

describe('listTasks deterministic ordering (#1445)', () => {
  const TIE_NOW = '2026-01-01T00:00:00.000Z'
  const insertAt = (title: string, now: string) => repo.insertTask({
    title, description: null, priority: 'p2', assignee: null, reporter: 'dev', depends_on: '[]', now, projectId: testProjectId(repo)
  }).id

  test('same-millisecond created_at ties break by id DESC, not by scan order', () => {
    const ids = [insertAt('tie-1', TIE_NOW), insertAt('tie-2', TIE_NOW), insertAt('tie-3', TIE_NOW)]
    const { rows, total } = repo.listTasks({ limit: 50 })
    expect(total).toBe(3)
    expect(rows.map(r => r.id)).toEqual([...ids].reverse())
    expect(rows.map(r => r.created_at)).toEqual(ids.map(() => TIE_NOW))
  })

  test('created_at DESC dominates: an older row never precedes a newer one regardless of id', () => {
    const older = insertAt('older', '2026-01-01T00:00:00.000Z')
    const newer = insertAt('newer', '2026-01-01T00:00:01.000Z')
    const { rows } = repo.listTasks({ limit: 50 })
    expect(rows.map(r => r.id)).toEqual([newer, older])
  })

  test('the deterministic order surfaces through the list_tasks tool', () => {
    const ids = [insertAt('a', TIE_NOW), insertAt('b', TIE_NOW), insertAt('c', TIE_NOW)]
    const res = json(handleListTasks(svc, {}))
    expect(res.tasks.map((t: { id: number }) => t.id)).toEqual([...ids].reverse())
  })
})

describe('canceled transitions (#112)', () => {
  const cancel = (id: number, version: number) =>
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'canceled', version })

  test('queued → canceled accepted, sets completed_at', () => {
    const id = json(handleCreateTask(svc, { title: 'Q', reporter: 'dev' })).id
    expect(json(cancel(id, 1)).status).toBe('canceled')
    const row = getTaskRow(db, id)
    expect(row.status).toBe('canceled')
    expect(row.completed_at).not.toBeNull()
  })

  test('in_progress → canceled accepted and clears lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'IP', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const claimed = getTaskRow(db, id)
    expect(claimed.lease_expires_at).not.toBeNull()
    expect(json(cancel(id, claimed.version)).status).toBe('canceled')
    const row = getTaskRow(db, id)
    expect(row.status).toBe('canceled')
    expect(row.lease_expires_at).toBeNull()
    expect(row.completed_at).not.toBeNull()
  })

  test('review → canceled accepted', () => {
    const id = json(handleCreateTask(svc, { title: 'R', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v1 = getTaskRow(db, id).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v1 })
    const v2 = getTaskRow(db, id).version
    expect(json(cancel(id, v2)).status).toBe('canceled')
  })

  test('blocked → canceled accepted', () => {
    const id = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 })
    expect(json(cancel(id, 2)).status).toBe('canceled')
  })

  test('done → canceled rejected with INVALID', () => {
    const id = json(handleCreateTask(svc, { title: 'D', reporter: 'dev' })).id
    driveToDone(svc, id, 'dev')
    const v = json(handleGetTask(svc, { id, fields: ['version'] })).version
    const res = cancel(id, v)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: done → canceled')
  })

  test('failed → canceled rejected with INVALID', () => {
    const id = json(handleCreateTask(svc, { title: 'F', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v1 = getTaskRow(db, id).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'failed', version: v1 })
    const v2 = getTaskRow(db, id).version
    const res = cancel(id, v2)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: failed → canceled')
  })
})

describe('lease refresh on reopen (#431)', () => {
  test('blocked → in_progress via update_status sets future lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'ReopenLease', reporter: 'dev' })).id
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 })
    const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'in_progress', version: v2 })
    const task = getTaskRow(db, id)
    expect(task.status).toBe('in_progress')
    expect(task.lease_expires_at).not.toBeNull()
    // Should be in the future (leaseTtlMin = 15 min)
    const expires = new Date(task.lease_expires_at!).getTime()
    expect(expires).toBeGreaterThan(Date.now())
  })

  test('review → in_progress via update_status sets future lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'ReviewReopen', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v1 })
    const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'in_progress', version: v2 })
    const task = getTaskRow(db, id)
    expect(task.status).toBe('in_progress')
    expect(task.lease_expires_at).not.toBeNull()
    expect(new Date(task.lease_expires_at!).getTime()).toBeGreaterThan(Date.now())
  })

  test('regression: freshly reopened task is NOT requeued by subsequent reap (stale-lease instant re-reap)', () => {
    const id = json(handleCreateTask(svc, { title: 'NoReReap', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v1 })
    const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'in_progress', version: v2 })
    // Reap should not touch the freshly reopened task
    svc.reapExpiredLeases()
    const task = getTaskRow(db, id)
    expect(task.status).toBe('in_progress')
    expect(task.lease_expires_at).not.toBeNull()
  })
})

describe('assignee release on reap and cancel (#431)', () => {
  test('reap → queued clears assignee', () => {
    const id = createTaskRow({ title: 'ReapClear', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-a', task_id: id })
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    svc.reapExpiredLeases()
    const task = getTaskRow(db, id)
    expect(task.status).toBe('queued')
    expect(task.assignee).toBeNull()
  })

  test('reap → failed clears assignee', () => {
    const id = createTaskRow({ title: 'ReapKeep', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-a', task_id: id })
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour'), attempts = 3 WHERE id = ?", [id])
    svc.reapExpiredLeases()
    const task = getTaskRow(db, id)
    expect(task.status).toBe('failed')
    expect(task.assignee).toBeNull()
  })

  test('canceled clears assignee', () => {
    const id = json(handleCreateTask(svc, { title: 'CancelClear', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-a', task_id: id })
    const task = getTaskRow(db, id)
    expect(task.assignee).toBe('agent-a')
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'canceled', version: task.version })
    const canceled = getTaskRow(db, id)
    expect(canceled.assignee).toBeNull()
  })
})

describe('assignee is the lease holder (#1857)', () => {
  // `assignee` means exactly "lease holder": it is written on in_progress and cleared on every
  // other status. The refund path (blocked → queued) used to keep the previous holder, so a task
  // that came back into the queue still carried a holder nobody could renew. Task #1872 removed the
  // last exception: a task is born `queued` without a holder, so creation refuses an assignee.
  const HOLDER = 'agent-a'

  function claimed(title: string): number {
    const id = json(handleCreateTask(svc, { title, reporter: 'dev' })).id
    handleClaimTask(svc, { agent: HOLDER, task_id: id })
    return id
  }

  // A blocked row that still carries a holder is what the pre-fix code wrote (only the terminal
  // statuses cleared it), so the refund starts from the state the leak lived in.
  function parkBlockedWithHolder(id: number): void {
    db.run("UPDATE tasks SET status = 'blocked', lease_expires_at = NULL WHERE id = ?", [id])
  }

  test('a claimed task records the holder as assignee', () => {
    const id = claimed('Holder')
    const row = getTaskRow(db, id)
    expect(row.assignee).toBe(HOLDER)
    expect(row.lease_expires_at).not.toBeNull()
  })

  test('the blocked → queued refund path leaves the row without a holder', () => {
    const id = claimed('Refund')
    parkBlockedWithHolder(id)
    const before = getTaskRow(db, id)
    expect(before.assignee).toBe(HOLDER)

    const res = handleUpdateStatus(svc, {
      id, agent: 'dev', status: 'queued', version: before.version,
      reset_attempts: true, comment: 'spent on accidental claims'
    })
    expect(res.isError).toBeUndefined()
    expect(json(res).attempts).toBe(0)

    const after = getTaskRow(db, id)
    expect(after.status).toBe('queued')
    expect(after.assignee).toBeNull()
  })

  test('the refund path and the reap path agree: both leave the row without a holder', () => {
    const refunded = claimed('RefundParity')
    parkBlockedWithHolder(refunded)
    handleUpdateStatus(svc, {
      id: refunded, agent: 'dev', status: 'queued', version: getTaskRow(db, refunded).version,
      reset_attempts: true, comment: 'spent on accidental claims'
    })

    const reaped = claimed('ReapParity')
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [reaped])
    svc.reapExpiredLeases()

    expect(getTaskRow(db, refunded).assignee).toBeNull()
    expect(getTaskRow(db, reaped).status).toBe('queued')
    expect(getTaskRow(db, reaped).assignee).toBeNull()
  })

  test('in_progress still records the holder: the fix must not clear a live lease', () => {
    const id = claimed('Reopened')
    const v1 = getTaskRow(db, id).version
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'review', version: v1 })
    const v2 = getTaskRow(db, id).version
    const res = handleUpdateStatus(svc, { id, agent: HOLDER, status: 'in_progress', version: v2 })
    expect(res.isError).toBeUndefined()

    const row = getTaskRow(db, id)
    expect(row.status).toBe('in_progress')
    expect(row.assignee).toBe(HOLDER)
    expect(row.lease_expires_at).not.toBeNull()
  })

  test('the holder is non-NULL exactly while the task is in_progress', () => {
    // The invariant, walked end to end: `assignee` is the lease holder, so it is present in exactly
    // one status. The birth, a review, a park, a refund and a terminal close all carry no holder -
    // only in_progress does. The creation-time exception is gone (#1872), so the birth is in here.
    const id = json(handleCreateTask(svc, { title: 'Invariant', reporter: 'dev' })).id
    const holders: Array<[string, string | null]> = []
    const observe = (label: string) => {
      const row = getTaskRow(db, id)!
      holders.push([label, row.assignee])
      expect(`${label}: ${row.status} carries ${row.assignee ?? 'no holder'}`)
        .toBe(`${label}: ${row.status} carries ${row.status === 'in_progress' ? HOLDER : 'no holder'}`)
    }
    const version = () => getTaskRow(db, id).version

    observe('born')
    handleClaimTask(svc, { agent: HOLDER, task_id: id })
    observe('claimed')
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'review', version: version() })
    observe('review')
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'in_progress', version: version() })
    observe('sent back')
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'blocked', version: version() })
    observe('blocked')
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'queued', version: version(), reset_attempts: true, comment: 'spent on accidents' })
    observe('refunded')
    handleClaimTask(svc, { agent: HOLDER, task_id: id })
    observe('claimed again')
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'review', version: version() })
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'done', version: version(), comment: 'shipped' })
    observe('done')

    expect(holders).toEqual([
      ['born', null],
      ['claimed', HOLDER],
      ['review', null],
      ['sent back', HOLDER],
      ['blocked', null],
      ['refunded', null],
      ['claimed again', HOLDER],
      ['done', null]
    ])
  })

  test('no queued row carries a holder: the creation path cannot produce one', () => {
    // The invariant, globally: `assignee` is the lease holder, so a queued row - a task nobody works
    // on - must never carry one. A creation that names a holder is refused (#1872), so the only
    // way in leaves the column NULL; the old contract wrote it straight through.
    const refused = handleCreateTask(svc, { title: 'NeverBorn', reporter: 'dev', assignee: HOLDER })
    expect(refused.isError).toBe(true)

    const queued = db.query('SELECT COUNT(*) AS n FROM tasks WHERE status = ? AND assignee IS NOT NULL').get('queued') as { n: number }
    expect(queued.n).toBe(0)
  })

  test('the reap is the other way out of in_progress: the holder goes with the lease', () => {
    const id = claimed('Reaped')
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    svc.reapExpiredLeases()

    const row = getTaskRow(db, id)!
    expect(row.status).toBe('queued')
    expect(row.assignee).toBeNull()
    expect(row.lease_expires_at).toBeNull()
  })
})

describe('title validation (#431)', () => {
  test('empty title rejected', () => {
    const res = handleCreateTask(svc, { title: '', reporter: 'dev' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: title required')
  })

  test('whitespace-only title rejected', () => {
    const res = handleCreateTask(svc, { title: '   ', reporter: 'dev' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: title required')
  })

  test('title >200 chars rejected', () => {
    const res = handleCreateTask(svc, { title: 'a'.repeat(201), reporter: 'dev' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: title too long')
  })

  test('title exactly 200 chars accepted', () => {
    const id = json(handleCreateTask(svc, { title: 'a'.repeat(200), reporter: 'dev' })).id
    expect(id).toBeGreaterThan(0)
  })
})

describe('update_status agent validation (#431)', () => {
  test('empty agent rejected', () => {
    const id = json(handleCreateTask(svc, { title: 'AgentTest', reporter: 'dev' })).id
    const res = handleUpdateStatus(svc, { id, agent: '', status: 'review', version: 1 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent required')
  })

  test('whitespace-only agent rejected', () => {
    const id = json(handleCreateTask(svc, { title: 'AgentTest2', reporter: 'dev' })).id
    const res = handleUpdateStatus(svc, { id, agent: '   ', status: 'review', version: 1 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent required')
  })
})

describe('brief default', () => {
  test('returns brief fields by default', () => {
    const id = createTaskRow({ title: 'Brief', reporter: 'dev' })
    const task = getTaskRow(db, id)
    expect(task).not.toBeNull()
    expect(task.title).toBe('Brief')
    expect(task.status).toBe('queued')
    expect(task.priority).toBe('p2')
  })
})

describe('lease_expires_at cleared on exit from in_progress (#767)', () => {
  function claimAndTransition(id: number, toStatus: string, agent: string): number {
    handleClaimTask(svc, { agent, task_id: id })
    const task = getTaskRow(db, id)
    handleUpdateStatus(svc, { id, agent, status: toStatus as any, version: task.version })
    return getTaskRow(db, id)!.version
  }

  test('in_progress → review clears lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'LeaseClear', reporter: 'dev' })).id
    claimAndTransition(id, 'review', 'agent-1')
    const task = getTaskRow(db, id)
    expect(task.status).toBe('review')
    expect(task.lease_expires_at).toBeNull()
  })

  test('in_progress → done clears lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'LeaseDone', reporter: 'dev' })).id
    claimAndTransition(id, 'review', 'agent-1')
    const v = getTaskRow(db, id)!.version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: v })
    const task = getTaskRow(db, id)
    expect(task.lease_expires_at).toBeNull()
  })

  test('in_progress → failed clears lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'LeaseFail', reporter: 'dev' })).id
    claimAndTransition(id, 'review', 'agent-1')
    const v = getTaskRow(db, id)!.version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'failed', version: v })
    const task = getTaskRow(db, id)
    expect(task.lease_expires_at).toBeNull()
  })

  test('in_progress → canceled clears lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'LeaseCancel', reporter: 'dev' })).id
    claimAndTransition(id, 'review', 'agent-1')
    const v = getTaskRow(db, id)!.version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'canceled', version: v })
    const task = getTaskRow(db, id)
    expect(task.lease_expires_at).toBeNull()
  })

  test('in_progress → blocked clears lease_expires_at', () => {
    const id = json(handleCreateTask(svc, { title: 'LeaseBlock', reporter: 'dev' })).id
    claimAndTransition(id, 'review', 'agent-1')
    const v = getTaskRow(db, id)!.version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'blocked', version: v })
    const task = getTaskRow(db, id)
    expect(task.lease_expires_at).toBeNull()
  })

  test('in_progress → queued (via reap) clears lease_expires_at', () => {
    const id = createTaskRow({ title: 'LeaseReap', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    db.run("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?", [id])
    svc.reapExpiredLeases()
    const task = getTaskRow(db, id)
    expect(task.status).toBe('queued')
    expect(task.lease_expires_at).toBeNull()
  })
})

describe('monotonicIso process-wide (#1608 supersedes #795)', () => {
  test('two TaskRepo instances share one monotonic clock, so repo B inherits repo A\'s advance', () => {
    const dbA = createTestDb()
    const repoA = new TaskRepo(dbA)
    const dbB = createTestDb()
    const repoB = new TaskRepo(dbB)
    try {
      const idA = repoA.insertTask({ title: 'A', description: null, priority: 'p2', assignee: null, reporter: 'dev', depends_on: '[]', now: '2020-01-01T00:00:00.000Z' }).id
      const idB = repoB.insertTask({ title: 'B', description: null, priority: 'p2', assignee: null, reporter: 'dev', depends_on: '[]', now: '2020-01-01T00:00:00.000Z' }).id
      // Inject 5 comments into both repos to establish baseline monotonicity.
      // One transaction per repo: the burst below is 500 rows, and one WAL commit per row is what
      // made this fixture the slowest test in the suite (a per-row commit, not a per-row clock tick).
      repoA.transaction(() => {
        for (let i = 0; i < 5; i++) repoA.insertComment(idA, 'a', `ca${i}`)
      })
      repoB.transaction(() => {
        for (let i = 0; i < 5; i++) repoB.insertComment(idB, 'b', `cb${i}`)
      })
      // Advance the shared clock far ahead (≈500ms) with a burst through repoA
      repoA.transaction(() => {
        for (let i = 0; i < 500; i++) repoA.insertComment(idA, 'a', `ca-adv${i}`)
      })
      // Shipped contract (#1608): every stamp comes from one process-wide monotonic clock
      // (monotonicNowMs in src/core/tasks.ts), so the two repos are NOT independent — repoB
      // inherits repoA's advance. This supersedes the per-instance independence that #795
      // pinned when TaskRepo still owned its own clock.
      // Hence this probe through repoB must be stamped AFTER repoA's last burst stamp, not at
      // an independent wall clock ~500 ms behind it. Reading the stored created_at keeps this a
      // black-box check of the same property.
      repoB.insertComment(idB, 'b', 'cb-probe')
      // Verify repo A's entries are internally monotonic
      const rowsA = dbA.query('SELECT created_at FROM comments WHERE task_id = ? ORDER BY id ASC').all(idA) as any[]
      for (let i = 1; i < rowsA.length; i++) {
        expect(rowsA[i].created_at > rowsA[i - 1].created_at).toBe(true)
      }
      // Verify repo B's entries are internally monotonic
      const rowsB = dbB.query('SELECT created_at, content FROM comments WHERE task_id = ? ORDER BY id ASC').all(idB) as any[]
      for (let i = 1; i < rowsB.length; i++) {
        expect(rowsB[i].created_at > rowsB[i - 1].created_at).toBe(true)
      }
      expect(rowsB.at(-1)!.content).toBe('cb-probe')
      // The shared-clock probe: the counter is strictly increasing process-wide, so repoB's
      // last stamp lands strictly after repoA's last burst stamp (a per-instance clock would
      // put it ~500 ms earlier here).
      const bMinusA = new Date(rowsB.at(-1)!.created_at).getTime() - new Date(rowsA.at(-1)!.created_at).getTime()
      expect(bMinusA).toBeGreaterThan(0)
    } finally {
      closeTestDb(dbA)
      closeTestDb(dbB)
    }
  })
})

describe('TaskRepo port conformance (#812)', () => {
  test('TaskRepo implements all TaskStore methods', () => {
    // Compile-time: this file imports TaskRepo and TaskStore; if TaskRepo did not
    // implement TaskStore, tsc would fail. Runtime verification: call every method.
    const db3 = createTestDb()
    try {
      const repo3 = new TaskRepo(db3)
      // All these calls must not throw — verifies method signatures match TaskStore
      expect(typeof repo3.getTaskRow).toBe('function')
      expect(typeof repo3.insertTask).toBe('function')
      expect(typeof repo3.deleteTask).toBe('function')
      expect(typeof repo3.listTasks).toBe('function')
      expect(typeof repo3.queuedCandidates).toBe('function')
      expect(typeof repo3.depsOf).toBe('function')
      expect(typeof repo3.statusesOf).toBe('function')
      expect(typeof repo3.batchTasks).toBe('function')
      expect(typeof repo3.markClaimed).toBe('function')
      expect(typeof repo3.transitionStatus).toBe('function')
      expect(typeof repo3.transaction).toBe('function')
      expect(typeof repo3.expiredLeases).toBe('function')
      expect(typeof repo3.reapTransition).toBe('function')
      expect(typeof repo3.insertComment).toBe('function')
      expect(typeof repo3.auditAppend).toBe('function')
      expect(typeof repo3.timelineEntries).toBe('function')
      expect(typeof repo3.commentsOf).toBe('function')
      expect(typeof repo3.nonTerminalChildCount).toBe('function')
      expect(typeof repo3.childStatusCounts).toBe('function')
      expect(typeof repo3.promoteEpicWithMirror).toBe('function')
      expect(typeof repo3.appendEpicAuditMirror).toBe('function')

      // Verify each method actually works
      const id = repo3.insertTask({
        title: 'PortTest', description: null, priority: 'p2',
        assignee: null, reporter: 'dev', depends_on: '[]', now: nowIso()
      }).id
      expect(repo3.getTaskRow(id)!.title).toBe('PortTest')
      expect(repo3.depsOf(id)).toBe('[]')
      expect(repo3.statusesOf([id]).get(id)).toBe('queued')
      expect(repo3.batchTasks([id]).get(id)?.title).toBe('PortTest')
      expect(repo3.insertComment(id, 'dev', 'hello')).toBeGreaterThan(0)
      repo3.auditAppend(id, 'dev', 'test_action', undefined, 'test_value')
      expect(repo3.timelineEntries(id, 10).length).toBeGreaterThan(0)
      expect(repo3.commentsOf(id).length).toBeGreaterThan(0)
      expect(repo3.nonTerminalChildCount(id)).toBe(0)
      const counts = repo3.childStatusCounts(id)
      expect(counts.total).toBe(0)
      expect(counts.open ?? 0).toBe(0)
      expect(counts.done ?? 0).toBe(0)
      expect(counts.failed ?? 0).toBe(0)
      expect(counts.canceled ?? 0).toBe(0)
      expect(repo3.transaction(() => 42)).toBe(42)
      expect(repo3.expiredLeases(nowIso())).toEqual([])
      repo3.deleteTask(id)
      expect(repo3.queuedCandidates(10, testProjectId(repo3), 0)).toHaveLength(0) // no queued tasks after delete
      expect(repo3.getTaskRow(id)).toBeNull()
    } finally {
      closeTestDb(db3)
    }
  })
})

// #1874: `codePointLength` is the ONE measurement every create_task string bound uses, and zod v4
// measures `maxLength` in the same unit. If the helper counted UTF-16 units instead of code
// points, the advertised schema and the service guard would drift apart at the boundary - which
// is exactly what happened before the fix.
describe('codePointLength (#1874)', () => {
  // U+1F600: one code point, two UTF-16 units.
  const EMOJI = '\u{1F600}'

  test('an ASCII string counts one code point per unit', () => {
    expect(codePointLength('')).toBe(0)
    expect(codePointLength('abc')).toBe(3)
  })

  test('an emoji counts as one code point, not two UTF-16 units', () => {
    expect(EMOJI.length).toBe(2)
    expect(codePointLength(EMOJI)).toBe(1)
    expect(codePointLength(EMOJI.repeat(200))).toBe(200)
  })

  test('a mixed string counts both kinds of character', () => {
    expect(codePointLength('a' + EMOJI)).toBe(2)
    expect(codePointLength('a'.repeat(100) + EMOJI.repeat(100))).toBe(200)
  })

  test('an unpaired surrogate counts as one code point, the way the schema layer counts it', () => {
    // A lone surrogate is one unit in a JS string and one element when the string is spread, so
    // the schema and the guard measure it the same way.
    expect(codePointLength('\uD800')).toBe(1)
    expect(codePointLength('\uD800\uD800')).toBe(2)
  })
})
