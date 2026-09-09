import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isValidTransition, nowIso } from './core/tasks'
import { checkCycles, depsSatisfied } from './core/service'
import { openDatabase } from './db/db'
import { MIGRATIONS } from './db/migrations'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleListTasks, handleClaimTask,
  handleUpdateStatus, handleListQueue,
  handleAddComment, handleGetTimeline, handleMetrics
} from './mcp/tools'

function createTestDb(): Database {
  const dir = '/tmp/opencode'
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `ziptask-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = openDatabase(path)
  ;(db as any).__path = path
  return db
}

function closeTestDb(db: Database) {
  const path = (db as any).__path as string
  db.close()
  try { rmSync(path) } catch {}
  try { rmSync(path + '-wal') } catch {}
  try { rmSync(path + '-shm') } catch {}
}

function createTaskRow(opts: { title: string; reporter: string; priority?: string; depends_on?: number[] }): number {
  const deps = opts.depends_on ?? []
  const now = nowIso()
  const id = repo.insertTask({
    title: opts.title,
    description: null,
    priority: opts.priority ?? 'p2',
    assignee: null,
    reporter: opts.reporter,
    depends_on: JSON.stringify(deps),
    now
  })
  return id
}

function getTaskRow(db: Database, id: number) {
  return db.query('SELECT * FROM tasks WHERE id = ?').get(id) as any
}

function json(res: any): any {
  return JSON.parse(res.content[0].text)
}

function text(res: any): string {
  return res.content[0].text
}

function driveToDone(svc: TaskService, id: number, agent: string) {
  handleClaimTask(svc, { agent, task_id: id })
  const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
  handleUpdateStatus(svc, { id, agent, status: 'review', version: v1 })
  const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
  return handleUpdateStatus(svc, { id, agent, status: 'done', version: v2 })
}

let db: Database
let repo: TaskRepo
let svc: TaskService

beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })

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

describe('checkCycles', () => {
  test('self-dependency rejected', () => {
    const id = createTaskRow({ title: 'Self', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id]), id])
    expect(checkCycles((id) => repo.depsOf(id), id, [id])).toBe(true)
  })

  test('simple 2-node cycle rejected', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id2]), id1])
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id1]), id2])
    expect(checkCycles((id) => repo.depsOf(id), id1, [id2])).toBe(true)
  })

  test('3+ node cycle rejected', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    const id3 = createTaskRow({ title: 'C', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id2]), id1])
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id3]), id2])
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id1]), id3])
    expect(checkCycles((id) => repo.depsOf(id), id1, [id3])).toBe(true)
  })

  test('valid DAG accepted (diamond)', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    const id3 = createTaskRow({ title: 'C', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id1, id2]), id3])
    expect(checkCycles((id) => repo.depsOf(id), id3, [id1, id2])).toBe(false)
  })

  test('cycle attempt via multiple parents rejected', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    const id3 = createTaskRow({ title: 'C', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id2]), id1])
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id3]), id2])
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [JSON.stringify([id1, id2]), id3])
    expect(checkCycles((id) => repo.depsOf(id), id1, [id2, id3])).toBe(true)
  })
})

describe('deps', () => {
  test('deps satisfied when all done', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    handleUpdateStatus(svc, { id: id1, agent: 'dev', status: 'in_progress', version: 1 })
    handleUpdateStatus(svc, { id: id1, agent: 'dev', status: 'review', version: 2 })
    handleUpdateStatus(svc, { id: id1, agent: 'dev', status: 'done', version: 3 })
    expect(depsSatisfied((id) => repo.statusOf(id), [id1])).toBe(true)
  })

  test('deps not satisfied when pending', () => {
    const id = createTaskRow({ title: 'Pending', reporter: 'dev' })
    expect(depsSatisfied((id) => repo.statusOf(id), [id])).toBe(false)
  })

  test('queue hides tasks with unsatisfied deps', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    createTaskRow({ title: 'B', reporter: 'dev', depends_on: [id1] })
    const res = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res).id).toBe(id1)
  })

  test('auto-claim skips dep-blocked tasks beyond window of 10', () => {
    // Create 10 dep-blocked tasks (each depends on non-existent task 999)
    for (let i = 0; i < 10; i++) {
      createTaskRow({ title: `Blocked ${i}`, reporter: 'dev', depends_on: [999] })
    }
    // Task 11 has no deps — should be picked despite being 11th in queue
    const freeId = createTaskRow({ title: 'Free', reporter: 'dev' })
    const res = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res).id).toBe(freeId)
  })

  test('auto-claim pages through >100 dep-blocked tasks to find free one', () => {
    // 101 dep-blocked tasks force the batch loop past the first page
    for (let i = 0; i < 101; i++) {
      createTaskRow({ title: `Blocked ${i}`, reporter: 'dev', depends_on: [999] })
    }
    const freeId = createTaskRow({ title: 'FreeBeyondBatch', reporter: 'dev' })
    const res = handleClaimTask(svc, { agent: 'agent-2' })
    expect(json(res).id).toBe(freeId)
  }, 20000)

  test('list_queue pipe hides dep-pending task even though queued (v2)', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [a] })).id
    const queue = text(handleListQueue(svc, {}))
    expect(queue).toBe(`${a}|p2|A`)
    const ids = queue.split('\n').map(line => Number(line.split('|')[0]))
    expect(ids).not.toContain(b)
  })

  test('list_queue shows dep task after dep done (v2)', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [a] })).id
    driveToDone(svc, a, 'agent-1')
    const queue = text(handleListQueue(svc, {}))
    expect(queue).toBe(`${b}|p2|B`)
  })
})

describe('pipe formats (v2)', () => {
  test('list_tasks ids pipe default id|code, unknown id → |0', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    driveToDone(svc, a, 'agent-1')
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    const out = text(handleListTasks(svc, { ids: [a, b, 999] }))
    expect(out).toBe(`${a}|4\n${b}|1\n999|0`)
  })

  test('list_tasks ids pipe with fields assignee: null → -', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'worker-1' })
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    const out = text(handleListTasks(svc, { ids: [a, b, 999], fields: ['assignee'] }))
    expect(out).toBe(`${a}|2|worker-1\n${b}|1|-\n999|0|-`)
  })

  test('list_queue pipe sanitizes | in title', () => {
    json(handleCreateTask(svc, { title: 'Fix | bug | now', reporter: 'dev' }))
    const out = text(handleListQueue(svc, {}))
    expect(out).toBe('1|p2|Fix / bug / now')
  })

  test('list_queue pipe orders by priority', () => {
    json(handleCreateTask(svc, { title: 'P2', reporter: 'dev', priority: 'p2' }))
    json(handleCreateTask(svc, { title: 'P0', reporter: 'dev', priority: 'p0' }))
    json(handleCreateTask(svc, { title: 'P1', reporter: 'dev', priority: 'p1' }))
    const out = text(handleListQueue(svc, {}))
    const ids = out.split('\n').map(line => Number(line.split('|')[0]))
    const p0 = out.split('\n').findIndex(l => l.includes('|p0|'))
    const p1 = out.split('\n').findIndex(l => l.includes('|p1|'))
    const p2 = out.split('\n').findIndex(l => l.includes('|p2|'))
    expect(p0).toBeLessThan(p1)
    expect(p1).toBeLessThan(p2)
    expect(ids.length).toBe(3)
  })

  test('STATUS_CODES legend', async () => {
    const { STATUS_CODES } = await import('./core/tasks')
    expect(STATUS_CODES).toEqual({
      not_found: 0, queued: 1, in_progress: 2, review: 3, done: 4, failed: 5, blocked: 6
    })
  })
})

describe('get_task / list_tasks fields (v2)', () => {
  test('brief default excludes description', () => {
    const id = json(handleCreateTask(svc, { title: 'Brief', reporter: 'dev', description: 'secret content' })).id
    const brief = json(handleGetTask(svc, { id }))
    expect('description' in brief).toBe(false)
    expect(brief.title).toBe('Brief')
    expect(brief.status).toBe('queued')
  })

  test('description only via explicit fields', () => {
    const id = json(handleCreateTask(svc, { title: 'Explicit', reporter: 'dev', description: 'full text' })).id
    const full = json(handleGetTask(svc, { id, fields: ['id', 'description'] }))
    expect(full.description).toBe('full text')
  })

  test('removed fields are absent even when requested', () => {
    const id = json(handleCreateTask(svc, { title: 'No paths', reporter: 'dev' })).id
    const res = json(handleGetTask(svc, { id, fields: ['task_path', 'result_path', 'parent_id', 'status'] }))
    expect(res).toEqual({ status: 'queued' })
  })

  test('omit-null in get_task', () => {
    const id = json(handleCreateTask(svc, { title: 'Nulls', reporter: 'dev' })).id
    const res = json(handleGetTask(svc, { id, fields: ['assignee', 'completed_at', 'lease_expires_at', 'status'] }))
    expect(res).toEqual({ status: 'queued' })
  })

  test('list_tasks default fields, omit-null', () => {
    json(handleCreateTask(svc, { title: 'L1', reporter: 'dev' }))
    const res = json(handleListTasks(svc, {}))
    expect(res.total).toBe(1)
    expect(res.tasks[0]).toEqual({ id: 1, title: 'L1', status: 'queued', priority: 'p2' })
  })

  test('list_tasks description only via explicit fields', () => {
    json(handleCreateTask(svc, { title: 'L2', reporter: 'dev', description: 'desc text' }))
    const def = json(handleListTasks(svc, {}))
    expect('description' in def.tasks[0]).toBe(false)
    const withDesc = json(handleListTasks(svc, { fields: ['id', 'description'] }))
    expect(withDesc.tasks[0].description).toBe('desc text')
  })

  test('updated_since filters by updated_at (v2)', async () => {
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    const cutoff = Date.now() + 1
    await Bun.sleep(3)
    handleClaimTask(svc, { agent: 'agent-1', task_id: a })
    const res = json(handleListTasks(svc, { updated_since: cutoff }))
    expect(res.total).toBe(1)
    expect(res.tasks[0].id).toBe(a)
    expect(res.tasks.map((t: any) => t.id)).not.toContain(b)
    const all = json(handleListTasks(svc, { updated_since: 0 }))
    expect(all.total).toBe(2)
    const none = json(handleListTasks(svc, { updated_since: Date.now() + 60_000 }))
    expect(none.total).toBe(0)
  })
})

describe('schema migration (v2)', () => {
  test('fresh db has correct tables', () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain('tasks')
    expect(names).toContain('comments')
    expect(names).toContain('audit_log')
    expect(names).toContain('schema_version')
  })

  test('tasks table has no removed columns, no parent_id index (v2)', () => {
    const cols = db.query('PRAGMA table_info(tasks)').all() as any[]
    const names = cols.map(c => c.name)
    expect(names).not.toContain('task_path')
    expect(names).not.toContain('result_path')
    expect(names).not.toContain('parent_id')
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    expect(indexes.map(i => i.name)).not.toContain('idx_tasks_parent_id')
  })

  test('comments table has type column default comment (v2)', () => {
    const cols = db.query('PRAGMA table_info(comments)').all() as any[]
    const typeCol = cols.find(c => c.name === 'type')
    expect(typeCol).toBeDefined()
    expect(typeCol.notnull).toBe(1)
    expect(typeCol.dflt_value).toBe("'comment'")
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

describe('audit_log', () => {
  test('audit entries created on state operations', () => {
    const id = createTaskRow({ title: 'Audit', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version })
    const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
    expect(logs.length).toBeGreaterThanOrEqual(2)
    const actions = logs.map((l: any) => l.action)
    expect(actions).toContain('claim')
    expect(actions).toContain('update_status')
  })

  test('create_task audits queued status (v2)', () => {
    const id = json(handleCreateTask(svc, { title: 'Audit v2', reporter: 'dev' })).id
    const logs = db.query("SELECT * FROM audit_log WHERE task_id = ? AND action = 'create'").all(id) as any[]
    expect(logs.length).toBe(1)
    expect(logs[0].new_value).toBe('queued')
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

describe('add_comment', () => {
  test('happy path returns comment_id', () => {
    const id = json(handleCreateTask(svc, { title: 'Comment', reporter: 'dev' })).id
    const res = json(handleAddComment(svc, { id, agent: 'dev', content: 'hello' }))
    expect(res.comment_id).toBeGreaterThan(0)
    const row = db.query('SELECT * FROM comments WHERE id = ?').get(res.comment_id) as any
    expect(row.task_id).toBe(id)
    expect(row.agent).toBe('dev')
    expect(row.content).toBe('hello')
    expect(row.type).toBe('comment')
  })

  test('unknown id returns NOT_FOUND', () => {
    const res = handleAddComment(svc, { id: 9999, agent: 'dev', content: 'x' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('NOT_FOUND')
  })

  test('empty agent rejected', () => {
    const id = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id
    const res = handleAddComment(svc, { id, agent: '', content: 'x' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('EMPTY')
  })

  test('empty content rejected', () => {
    const id = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id
    const res = handleAddComment(svc, { id, agent: 'dev', content: '' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('EMPTY')
  })

  test('no audit_log row for plain comment', () => {
    const id = json(handleCreateTask(svc, { title: 'NoAudit', reporter: 'dev' })).id
    handleAddComment(svc, { id, agent: 'dev', content: 'note' })
    const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
    expect(logs.length).toBe(1)
    expect(logs[0].action).toBe('create')
  })
})

describe('get_timeline', () => {
  test('merged feed sorted by created_at with seq|type|agent|at|text', () => {
    const id = json(handleCreateTask(svc, { title: 'TL', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v, comment: 'check | this' })
    handleAddComment(svc, { id, agent: 'other', content: 'side note' })
    const out = text(handleGetTimeline(svc, { id }))
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(0)
    const first = lines[0].split('|')
    expect(first[0]).toBe('1')
    expect(first[1]).toBe('action')
    const last = lines[lines.length - 1].split('|')
    expect(last[1]).toBe('comment')
    expect(last[4]).toContain('side note')
    const reviewLine = lines.find(l => l.includes('check / this'))
    expect(reviewLine).toBeDefined()
  })

  test('unknown id returns NOT_FOUND', () => {
    const res = handleGetTimeline(svc, { id: 9999 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('NOT_FOUND')
  })

  test('limit trims result set', () => {
    const id = json(handleCreateTask(svc, { title: 'Lim', reporter: 'dev' })).id
    handleAddComment(svc, { id, agent: 'a', content: 'c1' })
    handleAddComment(svc, { id, agent: 'a', content: 'c2' })
    handleAddComment(svc, { id, agent: 'a', content: 'c3' })
    const out = text(handleGetTimeline(svc, { id, limit: 2 }))
    const lines = out.split('\n')
    expect(lines.length).toBe(2)
    expect(lines[1].split('|')[0]).toBe('2')
  })

  test('default limit caps results when many entries exist', () => {
    const id = json(handleCreateTask(svc, { title: 'DfltLim', reporter: 'dev' })).id
    for (let i = 0; i < 52; i++) {
      repo.insertComment(id, 'a', `c${i}`)
    }
    const out = text(handleGetTimeline(svc, { id }))
    const lines = out.split('\n')
    expect(lines.length).toBeLessThanOrEqual(50)
  })

  test('empty timeline for fresh task (only create audit)', () => {
    const id = json(handleCreateTask(svc, { title: 'Fresh', reporter: 'dev' })).id
    const out = text(handleGetTimeline(svc, { id }))
    const lines = out.split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0].split('|')[1]).toBe('action')
  })
})

describe('metrics', () => {
  test('basic shape with empty DB', () => {
    const out = text(handleMetrics(svc, {}))
    expect(out).toContain('done_count|0')
  })

  test('done_count increases after done transition', () => {
    const id = json(handleCreateTask(svc, { title: 'M', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v1 })
    const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: v2 })
    const out = text(handleMetrics(svc, { period: 'all' }))
    expect(out).toContain('done_count|1')
    expect(out).toContain('status_time|')
  })

  test('period=all includes all data', () => {
    const id = json(handleCreateTask(svc, { title: 'MA', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: v1 })
    const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: v2 })
    const outAll = text(handleMetrics(svc, { period: 'all' }))
    const out24 = text(handleMetrics(svc, { period: 24 }))
    expect(outAll).toContain('done_count|1')
    expect(out24).toContain('done_count|1')
  })

  test('status_time reflects queued time for fresh task', async () => {
    json(handleCreateTask(svc, { title: 'Fresh', reporter: 'dev' }))
    await Bun.sleep(2)
    const out = text(handleMetrics(svc, { period: 'all' }))
    expect(out).toContain('status_time|queued:')
  })

  test('multi-task metrics aggregates status_time across tasks', () => {
    const id1 = json(handleCreateTask(svc, { title: 'M1', reporter: 'dev' })).id
    const id2 = json(handleCreateTask(svc, { title: 'M2', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id1 })
    const v1 = json(handleGetTask(svc, { id: id1, fields: ['version'] })).version
    handleUpdateStatus(svc, { id: id1, agent: 'agent-1', status: 'review', version: v1 })
    const v2 = json(handleGetTask(svc, { id: id1, fields: ['version'] })).version
    handleUpdateStatus(svc, { id: id1, agent: 'agent-1', status: 'done', version: v2 })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id2 })
    const out = text(handleMetrics(svc, { period: 'all' }))
    expect(out).toContain('done_count|1')
    expect(out).toContain('status_time|')
    expect(out).toContain('bottleneck|')
    const lines = out.split('\n')
    const statusTimeLine = lines.find(l => l.startsWith('status_time|'))
    expect(statusTimeLine).toBeDefined()
    const bottleneckLine = lines.find(l => l.startsWith('bottleneck|'))
    expect(bottleneckLine).toBeDefined()
  })

  test('period=0 is rejected', () => {
    const res = handleMetrics(svc, { period: 0 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID')
  })

  test('svc.metrics(0) returns SvcResult error directly', () => {
    const r = svc.metrics(0)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; error: string }).error).toContain('INVALID')
  })
})

describe('epic creation', () => {
  test('epic: true creates non-claimable task with is_epic=1', () => {
    const res = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    expect(res.status).toBe('queued')
    const task = getTaskRow(db, res.id)
    expect(task.is_epic).toBe(1)
    expect(task.epic_id).toBeNull()
  })

  test('epic is excluded from list_queue', () => {
    json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' }))
    const out = text(handleListQueue(svc, {}))
    expect(out).not.toContain('Epic')
    expect(out).toContain('Regular')
  })

  test('claim_task rejects epic (not claimable)', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const res = handleClaimTask(svc, { agent: 'dev', task_id: epicId })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('epic')
  })

  test('auto-claim picks regular tasks, skips epic', () => {
    json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    const regularId = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    const res = json(handleClaimTask(svc, { agent: 'dev' }))
    expect(res.id).toBe(regularId)
  })

  test('epic row has no depends_on leak', () => {
    const id = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const task = getTaskRow(db, id)
    expect(JSON.parse(task.depends_on)).toEqual([])
  })
})

describe('epic constraints', () => {
  test('epic + epic_id rejected (cannot have parent epic)', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const res = handleCreateTask(svc, { title: 'Bad', reporter: 'dev', epic: true, epic_id: epicId })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('parent epic')
  })

  test('epic + depends_on rejected', () => {
    const depId = json(handleCreateTask(svc, { title: 'Dep', reporter: 'dev' })).id
    const res = handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true, depends_on: [depId] })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('depends_on')
  })

  test('depends_on pointing at epic rejected', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const res = handleCreateTask(svc, { title: 'Bad', reporter: 'dev', depends_on: [epicId] })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('dependencies on epic')
  })

  test('epic_id target not found → NOT_FOUND', () => {
    const res = handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: 9999 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('NOT_FOUND')
  })

  test('epic_id on terminal task rejected', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    driveToDone(svc, epicId, 'dev')
    const res = handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('terminal')
  })

  test('epic_id on sub-task (nesting) rejected', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    const res = handleCreateTask(svc, { title: 'Nested', reporter: 'dev', epic_id: subId })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('no nesting')
  })
})

describe('auto-promote', () => {
  test('first sub-task attach promotes target to epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    const task = getTaskRow(db, epicId)
    expect(task.is_epic).toBe(0)
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const promoted = getTaskRow(db, epicId)
    expect(promoted.is_epic).toBe(1)
    expect(promoted.epic_id).toBeNull()
  })

  test('second sub-task does not re-promote (idempotent)', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub1', reporter: 'dev', epic_id: epicId }))
    json(handleCreateTask(svc, { title: 'Sub2', reporter: 'dev', epic_id: epicId }))
    const task = getTaskRow(db, epicId)
    expect(task.is_epic).toBe(1)
  })
})

describe('subtask_add mirror', () => {
  test('attach sub-task creates subtask_add mirror on epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subRes = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const mirrors = db.query(
      "SELECT action, new_value FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
    expect(mirrors[0].new_value).toContain(`#${subRes.id}`)
    expect(mirrors[0].new_value).toContain('Sub')
  })

  test('mirror uses sanitized pipe in title', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Fix | bug', reporter: 'dev', epic_id: epicId }))
    const mirrors = db.query(
      "SELECT new_value FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(epicId) as any[]
    expect(mirrors[0].new_value).toContain('Fix / bug')
    expect(mirrors[0].new_value).not.toContain('|')
  })
})

describe('epic terminal guard', () => {
  // Epics are not claimable, but updateStatus allows non-terminal transitions.
  // We drive the epic: queued → in_progress → review → attempt terminal.
  function driveEpicToReview(svc: TaskService, epicId: number, agent: string) {
    const t1 = getTaskRow(db, epicId)
    handleUpdateStatus(svc, { id: epicId, agent, status: 'in_progress', version: t1.version })
    const t2 = getTaskRow(db, epicId)
    handleUpdateStatus(svc, { id: epicId, agent, status: 'review', version: t2.version })
    return getTaskRow(db, epicId)
  }

  test('epic with open children cannot go done', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    driveEpicToReview(svc, epicId, 'dev')
    const epicTask = getTaskRow(db, epicId)
    const guard = handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'done', version: epicTask.version })
    expect(guard.isError).toBe(true)
    expect(text(guard)).toContain('CHILDREN')
  })

  test('epic with open children cannot go failed', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    driveEpicToReview(svc, epicId, 'dev')
    const epicTask = getTaskRow(db, epicId)
    const guard = handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'failed', version: epicTask.version })
    expect(guard.isError).toBe(true)
    expect(text(guard)).toContain('CHILDREN')
  })

  test('epic without children can go done', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    driveEpicToReview(svc, epicId, 'dev')
    const epicTask = getTaskRow(db, epicId)
    const done = json(handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'done', version: epicTask.version }))
    expect(done.status).toBe('done')
    expect(done.version).toBe(epicTask.version + 1)
  })

  test('child going done does not auto-close epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    // Drive sub to done
    handleClaimTask(svc, { agent: 'dev', task_id: subId })
    const subTask = getTaskRow(db, subId)
    handleUpdateStatus(svc, { id: subId, agent: 'dev', status: 'review', version: subTask.version })
    const v = json(handleGetTask(svc, { id: subId, fields: ['version'] })).version
    handleUpdateStatus(svc, { id: subId, agent: 'dev', status: 'done', version: v })
    // Epic should still be queued (not auto-promoted to done)
    const epic = getTaskRow(db, epicId)
    expect(epic.status).toBe('queued')
    expect(epic.is_epic).toBe(1)
  })
})

describe('subtask_done / subtask_failed mirrors', () => {
  test('subtask going done creates subtask_done mirror on epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    driveToDone(svc, subId, 'dev')
    const mirrors = db.query(
      "SELECT action FROM audit_log WHERE task_id = ? AND action = 'subtask_done'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
  })

  test('subtask going failed creates subtask_failed mirror on epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    handleClaimTask(svc, { agent: 'dev', task_id: subId })
    const subTask = getTaskRow(db, subId)
    handleUpdateStatus(svc, { id: subId, agent: 'dev', status: 'failed', version: subTask.version })
    const mirrors = db.query(
      "SELECT action FROM audit_log WHERE task_id = ? AND action = 'subtask_failed'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
  })

  test('mirror includes task id and subtask title', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Big Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Small Sub', reporter: 'dev', epic_id: epicId })).id
    driveToDone(svc, subId, 'dev')
    const mirrors = db.query(
      "SELECT new_value FROM audit_log WHERE task_id = ? AND action = 'subtask_done'"
    ).all(epicId) as any[]
    expect(mirrors[0].new_value).toContain(`#${subId}`)
    expect(mirrors[0].new_value).toContain('Small Sub')
    expect(mirrors[0].new_value).not.toContain('Big Epic')
  })
})

describe('derived roll-up (subtasks field)', () => {
  test('get_task with subtasks field returns roll-up for epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const sub1 = json(handleCreateTask(svc, { title: 'Sub1', reporter: 'dev', epic_id: epicId })).id
    json(handleCreateTask(svc, { title: 'Sub2', reporter: 'dev', epic_id: epicId }))
    driveToDone(svc, sub1, 'dev')
    // sub2 still queued
    const view = json(handleGetTask(svc, { id: epicId, fields: ['id', 'title', 'status', 'subtasks'] }))
    expect(view.subtasks).toBeDefined()
    expect(view.subtasks.total).toBe(2)
    expect(view.subtasks.done).toBe(1)
    expect(view.subtasks.open).toBe(1)
    expect(view.subtasks.failed).toBe(0)
  })

  test('get_task without subtasks field omits it for epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const view = json(handleGetTask(svc, { id: epicId, fields: ['id', 'title', 'status'] }))
    expect('subtasks' in view).toBe(false)
  })

  test('get_task on non-epic never returns subtasks', () => {
    const id = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    const view = json(handleGetTask(svc, { id, fields: ['id', 'subtasks'] }))
    expect('subtasks' in view).toBe(false)
  })
})

describe('list_tasks epic_id filter', () => {
  test('epic_id filter returns only children of epic', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const sub1 = json(handleCreateTask(svc, { title: 'Sub1', reporter: 'dev', epic_id: epicId })).id
    const sub2 = json(handleCreateTask(svc, { title: 'Sub2', reporter: 'dev', epic_id: epicId })).id
    json(handleCreateTask(svc, { title: 'Orphan', reporter: 'dev' }))
    const result = json(handleListTasks(svc, { epic_id: epicId }))
    expect(result.total).toBe(2)
    const ids = result.tasks.map((t: any) => t.id)
    expect(ids).toContain(sub1)
    expect(ids).toContain(sub2)
    expect(ids).not.toContain(epicId)
  })

  test('epic_id filter excludes the epic itself', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const result = json(handleListTasks(svc, { epic_id: epicId }))
    expect(result.tasks.some((t: any) => t.id === epicId)).toBe(false)
  })
})

describe('metrics exclusion of epics', () => {
  test('epic tasks are excluded from metrics', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' }))
    driveToDone(svc, epicId, 'dev')
    const out = text(handleMetrics(svc, { period: 'all' }))
    // Epic's done should not count; only the regular task would if it was driven done
    expect(out).toContain('done_count|0')
  })

  test('regular task done counts, epic done does not', () => {
    json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    const regId = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    driveToDone(svc, regId, 'dev')
    const out = text(handleMetrics(svc, { period: 'all' }))
    expect(out).toContain('done_count|1')
  })
})

describe('schema guard (v1.6)', () => {
  function makeTempDbPath(): string {
    const dir = '/tmp/opencode'
    mkdirSync(dir, { recursive: true })
    return join(dir, `ziptask-schema-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  }

  function openAndClose(path: string) {
    const db = openDatabase(path)
    db.close()
  }

  function rmTempDb(path: string) {
    try { rmSync(path) } catch {}
    try { rmSync(path + '-wal') } catch {}
    try { rmSync(path + '-shm') } catch {}
  }

  test('fresh empty DB opens and stamps MIGRATIONS.length', () => {
    const path = makeTempDbPath()
    try {
      const db = openDatabase(path)
      const row = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(row?.version).toBe(MIGRATIONS.length)
      db.close()
    } finally { rmTempDb(path) }
  })

  test('V < L upgrades: applies missing migrations and stamps L', () => {
    const path = makeTempDbPath()
    try {
      const db = openDatabase(path)
      db.close()
      const db2 = openDatabase(path)
      db2.run('DROP INDEX IF EXISTS idx_tasks_epic_id')
      db2.run('ALTER TABLE tasks DROP COLUMN epic_id')
      db2.run('ALTER TABLE tasks DROP COLUMN is_epic')
      db2.run('DELETE FROM schema_version')
      db2.run('INSERT INTO schema_version (version) VALUES (?)', [2])
      db2.close()
      const db3 = openDatabase(path)
      const row = db3.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(row?.version).toBe(MIGRATIONS.length)
      const cols = db3.query('PRAGMA table_info(tasks)').all() as any[]
      expect(cols.map(c => c.name)).toContain('is_epic')
      db3.close()
    } finally { rmTempDb(path) }
  })

  test('V > L throws exact R4 message, DB unchanged', () => {
    const path = makeTempDbPath()
    try {
      openAndClose(path)
      const db = openDatabase(path)
      db.run('DELETE FROM schema_version')
      db.run('INSERT INTO schema_version (version) VALUES (?)', [99])
      db.close()
      let thrown: Error | null = null
      try { openDatabase(path) } catch (err) { thrown = err as Error }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown!.message).toBe(
        `SCHEMA: database schema version 99 is newer than this binary supports (${MIGRATIONS.length}); upgrade ziptask or restore the database from backup`
      )
      const raw = new Database(path)
      const ver = raw.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(ver?.version).toBe(99)
      const int = raw.query('SELECT * FROM sqlite_master').all() as { type: string; name: string }[]
      expect(int.some(r => r.type === 'table' && r.name === 'tasks')).toBe(true)
      raw.close()
    } finally { rmTempDb(path) }
  })

  test('divergent DB stamps a lower version on full schema fires R5', () => {
    const path = makeTempDbPath()
    try {
      openAndClose(path)
      const db = openDatabase(path)
      db.run('DELETE FROM schema_version')
      db.run('INSERT INTO schema_version (version) VALUES (?)', [2])
      db.close()
      let thrown: Error | null = null
      try { openDatabase(path) } catch (err) { thrown = err as Error }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown!.message).toMatch(/^SCHEMA: migration failed; database does not match/)
      expect(thrown!.message).toMatch(/original: /)
      const raw = new Database(path)
      const ver = raw.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(ver?.version).toBe(2)
      raw.close()
    } finally { rmTempDb(path) }
  })
})
