import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { isValidTransition } from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus
} from './mcp/tools'
import {
  createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text,
  type CreateTaskRowOpts
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
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
    expect(after.assignee).toBe('agent-1')
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
    const changes = repo.reapSettle(id, 2, 'queued', 2, new Date().toISOString())
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
