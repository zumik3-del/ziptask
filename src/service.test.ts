import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { z } from 'zod/v4'
import {
  nowIso, clampLimit, TASK_STATUSES, MAX_RESULT_LIMIT, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH,
  MAX_DESCRIPTION_LENGTH, MAX_DEPENDS_ON, MAX_TITLE_LENGTH
} from './core/tasks'
import type { Store } from './core/types'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleClaimTask, handleUpdateStatus,
  handleListQueue, handleListTasks
} from './mcp/task-tools'
import { handleAddComment, handleGetTimeline } from './mcp/comment-tools'
import { registerAllTools } from './mcp/tools'
import {
  createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text, taskStoreStubs, testProjectId,
  type CreateTaskRowOpts
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' }) })
afterEach(() => { closeTestDb(db) })
const createTaskRow = (opts: CreateTaskRowOpts) => insertTaskRow(repo, opts)

// The row counts a refusal must not move: a refused call writes no task row, no audit row and no
// comment, so the three counts are the evidence that nothing was written.
function storeCounts(): { tasks: number; audit: number; comments: number } {
  const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { tasks: count('tasks'), audit: count('audit_log'), comments: count('comments') }
}

describe('audit_log toggle', () => {
  function makeAuditSvc(auditLog: boolean): { db: Database; repo: TaskRepo; svc: TaskService } {
    const d = createTestDb()
    const r = new TaskRepo(d)
    const s = new TaskService(r, { leaseTtlMin: 15, auditLog, scope: 'test' })
    return { db: d, repo: r, svc: s }
  }

  test('auditLog=false: create does not write audit row', () => {
    const { db, svc } = makeAuditSvc(false)
    try {
      const id = json(handleCreateTask(svc, { title: 'NoAudit', reporter: 'dev' })).id
      const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
      expect(logs.length).toBe(0)
    } finally { closeTestDb(db) }
  })

  test('auditLog=false: claim does not write audit row', () => {
    const { db, svc } = makeAuditSvc(false)
    try {
      const id = json(handleCreateTask(svc, { title: 'NoClaim', reporter: 'dev' })).id
      handleClaimTask(svc, { agent: 'agent-1', task_id: id })
      const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
      expect(logs.length).toBe(0)
    } finally { closeTestDb(db) }
  })

  test('auditLog=false: update_status does not write audit row', () => {
    const { db, svc } = makeAuditSvc(false)
    try {
      const id = json(handleCreateTask(svc, { title: 'NoUpdate', reporter: 'dev' })).id
      handleClaimTask(svc, { agent: 'agent-1', task_id: id })
      const task = getTaskRow(db, id)
      handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version })
      const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
      expect(logs.length).toBe(0)
    } finally { closeTestDb(db) }
  })

  test('auditLog=false: comments still insert', () => {
    const { db, svc } = makeAuditSvc(false)
    try {
      const id = json(handleCreateTask(svc, { title: 'NoCommentAudit', reporter: 'dev' })).id
      handleAddComment(svc, { id, agent: 'dev', content: 'hello' })
      const comments = db.query('SELECT * FROM comments WHERE task_id = ?').all(id) as any[]
      expect(comments.length).toBe(1)
      expect(comments[0].content).toBe('hello')
      const audit = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
      expect(audit.length).toBe(0)
    } finally { closeTestDb(db) }
  })

  test('auditLog=true (default): audit rows written on create/claim/update (v2)', () => {
    const { db, svc } = makeAuditSvc(true)
    try {
      const id = json(handleCreateTask(svc, { title: 'AuditOn', reporter: 'dev' })).id
      handleClaimTask(svc, { agent: 'agent-1', task_id: id })
      const task = getTaskRow(db, id)
      handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version })
      const logs = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(id) as any[]
      expect(logs.length).toBeGreaterThanOrEqual(3)
      const actions = logs.map((l: any) => l.action)
      expect(actions).toContain('create')
      expect(actions).toContain('claim')
      expect(actions).toContain('update_status')
    } finally { closeTestDb(db) }
  })
})

describe('claimTask atomic transaction (#1705)', () => {
  test('claimTask executes markClaimed and auditAppend inside store.transaction', () => {
    let txCalled = false
    const origTx = repo.transaction.bind(repo)
    repo.transaction = <T>(fn: () => T): T => {
      txCalled = true
      return origTx(fn)
    }

    const id = json(handleCreateTask(svc, { title: 'TxClaim', reporter: 'dev' })).id
    txCalled = false
    const res = svc.claimTask({ agent: 'dev', taskId: id })
    expect(res.ok).toBe(true)
    expect(txCalled).toBe(true)
  })

  test('claimTask rolls back status update if auditAppend throws', () => {
    const id = json(handleCreateTask(svc, { title: 'RollbackClaim', reporter: 'dev' })).id
    const origAuditAppend = repo.auditAppend.bind(repo)
    repo.auditAppend = () => {
      throw new Error('audit append simulated error')
    }

    try {
      expect(() => svc.claimTask({ agent: 'dev', taskId: id })).toThrow('audit append simulated error')
    } finally {
      repo.auditAppend = origAuditAppend
    }

    const task = repo.getTaskRow(id)
    expect(task?.status).toBe('queued')
    expect(task?.assignee).toBeNull()
  })
})

describe('reap cooldown (#104)', () => {
  function fakeStore(reapCb?: () => void): Store {
    return taskStoreStubs({ expiredLeases: () => { reapCb?.(); return [] } })
  }

  test('first read call reaps (lastReapAt=0), second read within cooldown skips', () => {
    let reapCallCount = 0
    const svc = new TaskService(fakeStore(() => { reapCallCount++ }), { reapCooldownSec: 3600, scope: 'test' })

    svc.getTaskView(1)
    expect(reapCallCount).toBe(1)

    // Second read within cooldown window → skip
    svc.listTasks({})
    expect(reapCallCount).toBe(1)

    svc.addComment({ id: 1, agent: 'a', content: 'x' })
    expect(reapCallCount).toBe(1)

    svc.getTimeline(1)
    expect(reapCallCount).toBe(1)

    // Write path always forces reap
    svc.claimTask({ agent: 'test' })
    expect(reapCallCount).toBe(2)

    svc.updateStatus({ id: 1, agent: 'test', status: 'review', version: 1 })
    expect(reapCallCount).toBe(3)

    // Public reap always forces
    svc.reapExpiredLeases()
    expect(reapCallCount).toBe(4)
  })

  test('reapCooldownSec=0 reaps on every call (no caching)', () => {
    let reapCallCount = 0
    const svc = new TaskService(fakeStore(() => { reapCallCount++ }), { reapCooldownSec: 0, scope: 'test' })

    svc.getTaskView(1)
    expect(reapCallCount).toBe(1)
    svc.getTaskView(2)
    expect(reapCallCount).toBe(2)
    svc.claimTask({ agent: 'test' })
    expect(reapCallCount).toBe(3)
  })

  test('public reapExpiredLeases always forces regardless of cooldown', () => {
    let reapCallCount = 0
    const svc = new TaskService(fakeStore(() => { reapCallCount++ }), { reapCooldownSec: 3600, scope: 'test' })

    svc.getTaskView(1)
    expect(reapCallCount).toBe(1)
    svc.reapExpiredLeases()
    expect(reapCallCount).toBe(2)
    svc.reapExpiredLeases()
    expect(reapCallCount).toBe(3)
  })
})

describe('auto-claim ceiling (#105)', () => {
  test('low ceiling stops scan early, returns EMPTY when free task is beyond ceiling', () => {
    const db2 = createTestDb()
    const repo2 = new TaskRepo(db2)
    const svc2 = new TaskService(repo2, { leaseTtlMin: 15, autoClaimCeiling: 100, scope: 'test' })

    // One transaction for the whole fixture: 150 rows, one WAL commit instead of 150.
    repo2.transaction(() => {
      for (let i = 0; i < 150; i++) {
        repo2.insertTask({
          title: `Blocked ${i}`,
          description: null,
          priority: 'p2',
          assignee: null,
          reporter: 'dev',
          depends_on: JSON.stringify([999]),
          now: nowIso(),
          projectId: testProjectId(repo2)
        })
      }
    })
    const _freeId = repo2.insertTask({
      title: 'Free',
      description: null,
      priority: 'p2',
      assignee: null,
      reporter: 'dev',
      depends_on: '[]',
      now: nowIso(),
      projectId: testProjectId(repo2)
    }).id

    const res = handleClaimTask(svc2, { agent: 'agent-1' })
    expect(text(res)).toContain('EMPTY')

    closeTestDb(db2)
  })

  test('default ceiling finds free task beyond 100 blocked tasks', () => {
    const db2 = createTestDb()
    const repo2 = new TaskRepo(db2)
    const svc2 = new TaskService(repo2, { leaseTtlMin: 15, scope: 'test' })

    // One transaction for the whole fixture: 150 rows, one WAL commit instead of 150.
    repo2.transaction(() => {
      for (let i = 0; i < 150; i++) {
        repo2.insertTask({
          title: `Blocked ${i}`,
          description: null,
          priority: 'p2',
          assignee: null,
          reporter: 'dev',
          depends_on: JSON.stringify([999]),
          now: nowIso(),
          projectId: testProjectId(repo2)
        })
      }
    })
    const _freeId = repo2.insertTask({
      title: 'Free',
      description: null,
      priority: 'p2',
      assignee: null,
      reporter: 'dev',
      depends_on: '[]',
      now: nowIso(),
      projectId: testProjectId(repo2)
    }).id

    const res = handleClaimTask(svc2, { agent: 'agent-1' })
    expect(json(res).id).toBe(_freeId)

    closeTestDb(db2)
  })

  test('parse-once cache: auto-claim with many dep-blocked tasks finds free one', () => {
    // Regression: parse-once refactor must not change behavior for the common case
    // One transaction for the fixture rows: one WAL commit instead of one per row.
    repo.transaction(() => {
      for (let i = 0; i < 10; i++) {
        createTaskRow({ title: `Blocked ${i}`, reporter: 'dev', depends_on: [999] })
      }
    })
    const freeId = createTaskRow({ title: 'Free', reporter: 'dev' })
    const res = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res).id).toBe(freeId)
  })
})

describe('limit guards (#3)', () => {
  test('undefined → fallback', () => {
    expect(clampLimit(undefined, 50)).toBe(50)
  })

  test('positive within range is preserved (floored)', () => {
    expect(clampLimit(10, 50)).toBe(10)
    expect(clampLimit(10.9, 50)).toBe(10)
  })

  test('zero and negative → fallback (never unbounded)', () => {
    expect(clampLimit(0, 50)).toBe(50)
    expect(clampLimit(-1, 50)).toBe(50)
    expect(clampLimit(-9999, 50)).toBe(50)
  })

  test('huge values are capped', () => {
    expect(clampLimit(1_000_000, 50)).toBe(MAX_RESULT_LIMIT)
  })

  test('NaN/Infinity → fallback', () => {
    expect(clampLimit(Number.NaN, 50)).toBe(50)
    expect(clampLimit(Number.POSITIVE_INFINITY, 50)).toBe(50)
  })

  test('list_queue with negative limit falls back, not unbounded', () => {
    for (let i = 0; i < 3; i++) handleCreateTask(svc, { title: `Q${i}`, reporter: 'dev' })
    const out = text(handleListQueue(svc, { limit: -1 }))
    expect(out.split('\n').length).toBe(3)
  })

  test('get_timeline with negative limit falls back to default, not unbounded', () => {
    const id = json(handleCreateTask(svc, { title: 'TL', reporter: 'dev' })).id
    const out = text(handleGetTimeline(svc, { id, limit: -1 }))
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('service defaults from config (#6)', () => {
  test('defaultPriority/defaultReporter are honoured when args omit them', () => {
    const configured = new TaskService(repo, { defaultPriority: 'p0', defaultReporter: 'human', scope: 'test' })
    const id = json(handleCreateTask(configured, { title: 'C' })).id
    const row = getTaskRow(db, id)
    expect(row.priority).toBe('p0')
    expect(row.reporter).toBe('human')
  })
})

describe('atomicity: createTask cycle path (#767)', () => {
  test('cycle rejection leaves no partial row or audit for the failed task', () => {
    const createResult = handleCreateTask(svc, { title: 'A', reporter: 'dev', depends_on: [2] })
    const parsed = json(createResult)
    const a = parsed.id
    handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [a] })
    // Task B (id=2) should not exist (cycle rejected)
    expect(getTaskRow(db, 2)).toBeNull()
    // No audit row for B
    const auditB = db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = 2').get() as { n: number }
    expect(auditB.n).toBe(0)
    // Task A exists and has its own create audit
    const taskA = getTaskRow(db, a)
    expect(taskA).not.toBeNull()
    expect(taskA.title).toBe('A')
    // Query audit using correct bun:sqlite pattern (query().all(variadic))
    const auditARaw = db.query('SELECT * FROM audit_log WHERE task_id = ?').all(a) as any[]
    expect(auditARaw.length).toBeGreaterThan(0)
    expect(auditARaw.some((r: any) => r.action === 'create')).toBe(true)
  })
})

describe('atomicity: updateStatus transaction (#767)', () => {
  test('successful updateStatus writes audit row and optional comment in one transaction', () => {
    const id = json(handleCreateTask(svc, { title: 'Atomic', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version, comment: 'atomic note' })
    expect(json(res).status).toBe('review')
    // Audit row written
    const audits = db.query("SELECT * FROM audit_log WHERE task_id = ? AND action = 'update_status'").all(id) as any[]
    expect(audits.length).toBe(1)
    expect(audits[0].new_value).toBe('review')
    // Comment written
    const comments = db.query("SELECT * FROM comments WHERE task_id = ?").all(id) as any[]
    expect(comments.length).toBe(1)
    expect(comments[0].content).toBe('atomic note')
    expect(comments[0].type).toBe('comment')
  })

  test('updateStatus with version mismatch writes no audit or comment', () => {
    const id = json(handleCreateTask(svc, { title: 'NoAudit', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    // Use stale version (1 instead of current)
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: 1, comment: 'should not appear' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('CONFLICT')
    // No audit row
    const audits = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = 'update_status'").get(id) as { n: number }
    expect(audits.n).toBe(0)
    // No comment
    const comments = db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id) as { n: number }
    expect(comments.n).toBe(0)
  })

  test('updateStatus to terminal with comment writes resolution type', () => {
    const id = json(handleCreateTask(svc, { title: 'Terminal', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const t1 = getTaskRow(db, id)
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: t1.version })
    const t2 = getTaskRow(db, id)
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'done', version: t2.version, comment: 'all good' })
    const comment = db.query('SELECT type FROM comments WHERE task_id = ?').get(id) as any
    expect(comment.type).toBe('resolution')
  })
})

describe('CAS: transitionStatus returns changes (#767)', () => {
  test('transitionStatus returns 1 on successful version-matched transition', () => {
    const id = createTaskRow({ title: 'CAS', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    // transitionStatus is on the repo; call it directly
    const changes = repo.transitionStatus(id, task.version, 'review', new Date().toISOString(), null, null)
    expect(changes).toBe(1)
  })

  test('transitionStatus returns 0 on version mismatch', () => {
    const id = createTaskRow({ title: 'CAS2', reporter: 'dev' })
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    // Use wrong version
    const changes = repo.transitionStatus(id, task.version + 999, 'review', new Date().toISOString(), null, null)
    expect(changes).toBe(0)
    // Task status unchanged
    const still = getTaskRow(db, id)
    expect(still.status).toBe('in_progress')
  })

  test('updateStatus returns CONFLICT when transitionStatus returns 0', () => {
    const id = json(handleCreateTask(svc, { title: 'CAS3', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version + 999 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('CONFLICT')
  })
})

describe('deleteTask cascade (#795)', () => {
  test('deleteTask removes comments and audit_log rows for the task', () => {
    const id = json(handleCreateTask(svc, { title: 'DeleteMe', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task.version, comment: 'pre-delete note' })
    handleAddComment(svc, { id, agent: 'dev', content: 'extra comment' })

    const beforeComments = db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id) as { n: number }
    const beforeAudit = db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ?').get(id) as { n: number }
    expect(beforeComments.n).toBeGreaterThan(0)
    expect(beforeAudit.n).toBeGreaterThan(0)

    repo.deleteTask(id)

    expect(getTaskRow(db, id)).toBeNull()
    const afterComments = db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id) as { n: number }
    const afterAudit = db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ?').get(id) as { n: number }
    expect(afterComments.n).toBe(0)
    expect(afterAudit.n).toBe(0)
  })

  test('deleteTask on unknown id is a no-op (no error)', () => {
    expect(() => repo.deleteTask(99999)).not.toThrow()
    const audit = db.query('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }
    expect(audit.n).toBe(0)
  })

  test('a raw task delete cascades to comments and audit_log (schema v4)', () => {
    const id = json(handleCreateTask(svc, { title: 'CascadeMe', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    handleAddComment(svc, { id, agent: 'dev', content: 'note' })
    expect((db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id) as { n: number }).n).toBeGreaterThan(0)
    expect((db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ?').get(id) as { n: number }).n).toBeGreaterThan(0)

    // bypass deleteTask entirely: only the ON DELETE CASCADE can clean the children
    db.run('DELETE FROM tasks WHERE id = ?', [id])

    expect((db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id) as { n: number }).n).toBe(0)
    expect((db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ?').get(id) as { n: number }).n).toBe(0)
  })
})

describe('length limits: agent and content (#795)', () => {
  const LONG_AGENT = 'a'.repeat(MAX_AGENT_LENGTH + 1)
  const LONG_CONTENT = 'c'.repeat(MAX_CONTENT_LENGTH + 1)
  const OK_AGENT = 'a'.repeat(MAX_AGENT_LENGTH)
  const OK_CONTENT = 'c'.repeat(MAX_CONTENT_LENGTH)

  test('claimTask rejects agent > MAX_AGENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'LongAgent', reporter: 'dev' })).id
    const res = handleClaimTask(svc, { agent: LONG_AGENT, task_id: id })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent too long')
  })

  test('claimTask accepts agent == MAX_AGENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'OkAgent', reporter: 'dev' })).id
    const res = json(handleClaimTask(svc, { agent: OK_AGENT, task_id: id }))
    expect(res.id).toBe(id)
  })

  test('updateStatus rejects agent > MAX_AGENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'UpdLongAgent', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'ok', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: LONG_AGENT, status: 'review', version: task!.version })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent too long')
  })

  test('updateStatus rejects comment > MAX_CONTENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'UpdLongComment', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'ok', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'ok', status: 'review', version: task!.version, comment: LONG_CONTENT })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: content too long')
  })

  test('updateStatus accepts comment == MAX_CONTENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'UpdOkComment', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'ok', task_id: id })
    const task = getTaskRow(db, id)
    const res = json(handleUpdateStatus(svc, { id, agent: 'ok', status: 'review', version: task!.version, comment: OK_CONTENT }))
    expect(res.status).toBe('review')
    const comments = db.query('SELECT content FROM comments WHERE task_id = ?').all(id) as any[]
    expect(comments.length).toBe(1)
    expect(comments[0].content).toBe(OK_CONTENT)
  })

  test('addComment rejects agent > MAX_AGENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'CmtLongAgent', reporter: 'dev' })).id
    const res = handleAddComment(svc, { id, agent: LONG_AGENT, content: 'short' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent too long')
  })

  test('addComment rejects content > MAX_CONTENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'CmtLongContent', reporter: 'dev' })).id
    const res = handleAddComment(svc, { id, agent: 'ok', content: LONG_CONTENT })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: content too long')
  })

  test('addComment accepts agent/content at exact MAX boundary', () => {
    const id = json(handleCreateTask(svc, { title: 'CmtOk', reporter: 'dev' })).id
    const res = json(handleAddComment(svc, { id, agent: OK_AGENT, content: OK_CONTENT }))
    expect(res.comment_id).toBeGreaterThan(0)
    const row = db.query('SELECT agent, content FROM comments WHERE id = ?').get(res.comment_id) as any
    expect(row.agent).toBe(OK_AGENT)
    expect(row.content).toBe(OK_CONTENT)
  })
})

describe('empty/whitespace comment rejection in updateStatus (#810)', () => {
  test('updateStatus rejects empty string comment', () => {
    const id = json(handleCreateTask(svc, { title: 'EmptyComment', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task!.version, comment: '' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: content required')
  })

  test('updateStatus rejects whitespace-only comment', () => {
    const id = json(handleCreateTask(svc, { title: 'WsComment', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task!.version, comment: '   ' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: content required')
  })

  test('updateStatus accepts non-empty comment', () => {
    const id = json(handleCreateTask(svc, { title: 'OkComment', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = json(handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task!.version, comment: 'valid note' }))
    expect(res.status).toBe('review')
  })

  test('updateStatus without comment (undefined) still succeeds', () => {
    const id = json(handleCreateTask(svc, { title: 'NoComment', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'agent-1', task_id: id })
    const task = getTaskRow(db, id)
    const res = json(handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: task!.version }))
    expect(res.status).toBe('review')
    const comments = db.query('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?').get(id) as { n: number }
    expect(comments.n).toBe(0)
  })
})

describe('reporter/assignee length guards in createTask (#811)', () => {
  const LONG_AGENT = 'a'.repeat(MAX_AGENT_LENGTH + 1)
  const OK_AGENT = 'a'.repeat(MAX_AGENT_LENGTH)

  test('createTask rejects reporter > MAX_AGENT_LENGTH', () => {
    const res = handleCreateTask(svc, { title: 'LongReporter', reporter: LONG_AGENT })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: reporter too long')
  })

  test('createTask accepts reporter == MAX_AGENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'OkReporter', reporter: OK_AGENT })).id
    const row = getTaskRow(db, id)
    expect(row.reporter).toBe(OK_AGENT)
  })

  test('createTask rejects assignee > MAX_AGENT_LENGTH', () => {
    const res = handleCreateTask(svc, { title: 'LongAssignee', reporter: 'dev', assignee: LONG_AGENT })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: assignee too long')
  })

  test('createTask refuses assignee == MAX_AGENT_LENGTH: the length is in bounds, the creation is not', () => {
    // The length guard runs first, so an in-bounds name reaches the creation refusal (#1872)
    // instead of the length error: a name that is legal as a holder is still not a holder at birth.
    const res = handleCreateTask(svc, { title: 'OkAssignee', reporter: 'dev', assignee: OK_AGENT })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: assignee is refused at creation: a task holds a lease only from in_progress')
  })
})

// #1872: `assignee` means exactly "lease holder", and a task is born `queued` without a lease, so
// a creation-time assignee would be a holder without a lease - a holder nothing would honour (the
// queue is shared, the auto-pick is not assignee-aware, the first claim overwrites the column).
// The value is refused at creation, and the store hard-writes NULL behind that guard.
describe('a creation-time assignee is refused (#1872)', () => {
  const REFUSAL = 'INVALID: assignee is refused at creation: a task holds a lease only from in_progress'

  test('createTask refuses an assignee with the documented INVALID string', () => {
    const res = handleCreateTask(svc, { title: 'Leased', reporter: 'dev', assignee: 'worker' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(REFUSAL)
  })

  test('the refusal writes no task row, no audit row and no comment', () => {
    const before = storeCounts()
    handleCreateTask(svc, { title: 'Leased', reporter: 'dev', assignee: 'worker' })
    expect(storeCounts()).toEqual(before)
  })

  test('a task created without an assignee has no holder and no lease', () => {
    const id = json(handleCreateTask(svc, { title: 'Born', reporter: 'dev' })).id
    const row = getTaskRow(db, id)!
    expect(row.status).toBe('queued')
    expect(row.assignee).toBeNull()
    expect(row.lease_expires_at).toBeNull()
  })

  test('the epic rule is still checked first and keeps its own message', () => {
    const res = handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true, assignee: 'boss' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: an epic takes no assignee: it holds no lease')
  })

  test('the length guard still runs first: an over-long assignee is refused as too long', () => {
    const res = handleCreateTask(svc, { title: 'LongAssignee', reporter: 'dev', assignee: 'a'.repeat(MAX_AGENT_LENGTH + 1) })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: assignee too long')
  })

  test('the store hard-writes a NULL assignee even when a bypass hands one in', () => {
    // The guard is the first line of defence; the repo is the last one. A bypass or a cross-process
    // race that reaches the store with a value in hand must not leave a holder without a lease.
    const id = repo.insertTask({
      title: 'Bypass', description: null, priority: 'p2', assignee: 'boss', reporter: 'dev',
      depends_on: '[]', now: nowIso(), projectId: testProjectId(repo)
    }).id
    const row = getTaskRow(db, id)!
    expect(row.status).toBe('queued')
    expect(row.assignee).toBeNull()
    expect(row.lease_expires_at).toBeNull()
  })
})

describe('create_task input bounds (#1857)', () => {
  // Both inputs are stored verbatim, so both are bounded: the schema refuses them on the wire and
  // the create guard refuses them in the service, with the same two documented strings.
  const LONG_DESCRIPTION = 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1)
  const OK_DESCRIPTION = 'd'.repeat(MAX_DESCRIPTION_LENGTH)
  const TOO_MANY_DEPS = Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => 9000 + i)
  const MAX_DEPS = Array.from({ length: MAX_DEPENDS_ON }, (_, i) => 9000 + i)

  test('createTask refuses a description over the limit with the documented INVALID string', () => {
    const res = handleCreateTask(svc, { title: 'LongDescription', reporter: 'dev', description: LONG_DESCRIPTION })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: description too long')
  })

  test('the description refusal writes no task row, no audit row and no comment', () => {
    const before = storeCounts()
    handleCreateTask(svc, { title: 'LongDescription', reporter: 'dev', description: LONG_DESCRIPTION })
    expect(storeCounts()).toEqual(before)
  })

  test('createTask accepts a description exactly at the limit and stores it verbatim', () => {
    const id = json(handleCreateTask(svc, { title: 'OkDescription', reporter: 'dev', description: OK_DESCRIPTION })).id
    expect(getTaskRow(db, id).description).toBe(OK_DESCRIPTION)
  })

  test('createTask refuses a depends_on array over the limit with the documented INVALID string', () => {
    const res = handleCreateTask(svc, { title: 'TooManyDeps', reporter: 'dev', depends_on: TOO_MANY_DEPS })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: depends_on too long')
  })

  test('the depends_on refusal writes no task row, no audit row and no comment', () => {
    const before = storeCounts()
    handleCreateTask(svc, { title: 'TooManyDeps', reporter: 'dev', depends_on: TOO_MANY_DEPS })
    expect(storeCounts()).toEqual(before)
  })

  test('createTask accepts a depends_on array exactly at the limit and stores every id', () => {
    const id = json(handleCreateTask(svc, { title: 'MaxDeps', reporter: 'dev', depends_on: MAX_DEPS })).id
    expect(JSON.parse(getTaskRow(db, id).depends_on)).toEqual(MAX_DEPS)
  })
})

// #1874: every create_task string bound means ONE thing in both layers - Unicode code points.
// zod v4 measures `maxLength` in code points and the guard measures the same way
// (`codePointLength`), so the advertised schema and the service guard refuse the same strings.
// Before the fix the guard counted UTF-16 units, so a multi-byte description was ACCEPTED by the
// schema and REFUSED by the guard: the two layers disagreed exactly at the boundary.
describe('the create_task string bounds count code points (#1874)', () => {
  // U+1F600: one code point, two UTF-16 units. A bound measured in the wrong unit misses it.
  const EMOJI = '\u{1F600}'
  const multiByte = (n: number): string => EMOJI.repeat(n)
  // A string of exactly n code points, half ASCII and half multi-byte: a counter that measures
  // only one kind of character would miss the other.
  const mixed = (n: number): string => 'a'.repeat(Math.floor(n / 2)) + EMOJI.repeat(n - Math.floor(n / 2))
  // The code-point count of a string, measured independently of the production helper.
  const codePoints = (value: string): number => [...value].length

  // The advertised shape, exactly as the MCP layer registers it: the layer the wire validates
  // against, so a schema/guard disagreement shows up here and not only over the wire.
  function createTaskShape(): any {
    let shape: any
    registerAllTools({ registerTool: (name: string, cfg: any) => { if (name === 'create_task') shape = cfg.inputSchema } } as any, svc)
    return shape
  }

  describe('the schema and the guard agree at the boundary', () => {
    test('a description of exactly MAX_DESCRIPTION_LENGTH code points is accepted by both layers', () => {
      const description = multiByte(MAX_DESCRIPTION_LENGTH)
      expect(codePoints(description)).toBe(MAX_DESCRIPTION_LENGTH)
      expect(createTaskShape().safeParse({ title: 'Boundary', description }).success).toBe(true)
      const res = handleCreateTask(svc, { title: 'Boundary', reporter: 'dev', description })
      expect(res.isError).toBeUndefined()
      const id = json(res).id
      expect(codePoints(getTaskRow(db, id).description)).toBe(MAX_DESCRIPTION_LENGTH)
    })

    test('a description of MAX_DESCRIPTION_LENGTH + 1 code points is refused by both layers', () => {
      const description = multiByte(MAX_DESCRIPTION_LENGTH + 1)
      expect(codePoints(description)).toBe(MAX_DESCRIPTION_LENGTH + 1)
      expect(createTaskShape().safeParse({ title: 'Over', description }).success).toBe(false)
      const res = handleCreateTask(svc, { title: 'Over', reporter: 'dev', description })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: description too long')
    })

    test('a title of exactly MAX_TITLE_LENGTH code points is accepted by both layers', () => {
      const title = multiByte(MAX_TITLE_LENGTH)
      expect(codePoints(title)).toBe(MAX_TITLE_LENGTH)
      expect(createTaskShape().safeParse({ title }).success).toBe(true)
      const res = handleCreateTask(svc, { title, reporter: 'dev' })
      expect(res.isError).toBeUndefined()
      expect(codePoints(getTaskRow(db, json(res).id).title)).toBe(MAX_TITLE_LENGTH)
    })

    test('a title of MAX_TITLE_LENGTH + 1 code points is refused by both layers', () => {
      const title = multiByte(MAX_TITLE_LENGTH + 1)
      expect(codePoints(title)).toBe(MAX_TITLE_LENGTH + 1)
      expect(createTaskShape().safeParse({ title }).success).toBe(false)
      const res = handleCreateTask(svc, { title, reporter: 'dev' })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: title too long')
    })
  })

  describe('a mixed string is measured the same way', () => {
    test('a mixed description of exactly MAX_DESCRIPTION_LENGTH code points is accepted by both layers', () => {
      // Half ASCII, half multi-byte: 20000 code points in 30000 UTF-16 units. A guard that counts
      // units refuses it; a guard that counts code points accepts it.
      const description = mixed(MAX_DESCRIPTION_LENGTH)
      expect(codePoints(description)).toBe(MAX_DESCRIPTION_LENGTH)
      expect(description.length).toBeGreaterThan(MAX_DESCRIPTION_LENGTH)
      expect(createTaskShape().safeParse({ title: 'Mixed', description }).success).toBe(true)
      const res = handleCreateTask(svc, { title: 'Mixed', reporter: 'dev', description })
      expect(res.isError).toBeUndefined()
      expect(codePoints(getTaskRow(db, json(res).id).description)).toBe(MAX_DESCRIPTION_LENGTH)
    })

    test('a mixed description of MAX_DESCRIPTION_LENGTH + 1 code points is refused by both layers', () => {
      const description = mixed(MAX_DESCRIPTION_LENGTH + 1)
      expect(codePoints(description)).toBe(MAX_DESCRIPTION_LENGTH + 1)
      expect(createTaskShape().safeParse({ title: 'MixedOver', description }).success).toBe(false)
      const res = handleCreateTask(svc, { title: 'MixedOver', reporter: 'dev', description })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: description too long')
    })

    test('a mixed title of exactly MAX_TITLE_LENGTH code points is accepted by both layers', () => {
      const title = mixed(MAX_TITLE_LENGTH)
      expect(codePoints(title)).toBe(MAX_TITLE_LENGTH)
      expect(title.length).toBeGreaterThan(MAX_TITLE_LENGTH)
      expect(createTaskShape().safeParse({ title }).success).toBe(true)
      const res = handleCreateTask(svc, { title, reporter: 'dev' })
      expect(res.isError).toBeUndefined()
      expect(codePoints(getTaskRow(db, json(res).id).title)).toBe(MAX_TITLE_LENGTH)
    })

    test('a mixed title of MAX_TITLE_LENGTH + 1 code points is refused by both layers', () => {
      const title = mixed(MAX_TITLE_LENGTH + 1)
      expect(codePoints(title)).toBe(MAX_TITLE_LENGTH + 1)
      expect(createTaskShape().safeParse({ title }).success).toBe(false)
      const res = handleCreateTask(svc, { title, reporter: 'dev' })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: title too long')
    })
  })

  describe('the refusal strings are exact and write nothing', () => {
    test('the schema refuses a description with the exact documented string', () => {
      const parsed = createTaskShape().safeParse({ title: 'Schema', description: multiByte(MAX_DESCRIPTION_LENGTH + 1) })
      expect(parsed.success).toBe(false)
      const issues = (parsed as any).error.issues
      expect(issues[0].message).toBe('INVALID: description too long')
      expect(issues[0].path).toEqual(['description'])
    })

    test('the schema refuses a title with the exact documented string', () => {
      const parsed = createTaskShape().safeParse({ title: multiByte(MAX_TITLE_LENGTH + 1) })
      expect(parsed.success).toBe(false)
      const issues = (parsed as any).error.issues
      expect(issues[0].message).toBe('INVALID: title too long')
      expect(issues[0].path).toEqual(['title'])
    })

    test('the guard refuses a description with the exact documented string and writes nothing', () => {
      const before = storeCounts()
      const res = handleCreateTask(svc, { title: 'LongDescription', reporter: 'dev', description: multiByte(MAX_DESCRIPTION_LENGTH + 1) })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: description too long')
      expect(storeCounts()).toEqual(before)
    })

    test('the guard refuses a title with the exact documented string and writes nothing', () => {
      const before = storeCounts()
      const res = handleCreateTask(svc, { title: multiByte(MAX_TITLE_LENGTH + 1), reporter: 'dev' })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: title too long')
      expect(storeCounts()).toEqual(before)
    })

    test('the guard refuses a depends_on array with the exact documented string and writes nothing', () => {
      const deps = Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => 9000 + i)
      const before = storeCounts()
      const res = handleCreateTask(svc, { title: 'TooManyDeps', reporter: 'dev', depends_on: deps })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: depends_on too long')
      expect(storeCounts()).toEqual(before)
    })
  })

  describe('the unchanged paths stay pinned', () => {
    test('an epic still answers the epic refusal, not the creation refusal', () => {
      const res = handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true, assignee: 'boss' })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: an epic takes no assignee: it holds no lease')
    })

    test('the length guard runs before the creation refusal: an over-long assignee is refused as too long', () => {
      const res = handleCreateTask(svc, { title: 'LongAssignee', reporter: 'dev', assignee: multiByte(MAX_AGENT_LENGTH + 1) })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: assignee too long')
    })

    test('depends_on is counted as ids in both layers', () => {
      const maxDeps = Array.from({ length: MAX_DEPENDS_ON }, (_, i) => 9000 + i)
      const tooManyDeps = Array.from({ length: MAX_DEPENDS_ON + 1 }, (_, i) => 9000 + i)
      const shape = createTaskShape()
      expect(shape.safeParse({ title: 'MaxDeps', depends_on: maxDeps }).success).toBe(true)
      const ok = handleCreateTask(svc, { title: 'MaxDeps', reporter: 'dev', depends_on: maxDeps })
      expect(ok.isError).toBeUndefined()
      expect(JSON.parse(getTaskRow(db, json(ok).id).depends_on)).toEqual(maxDeps)

      const parsed = shape.safeParse({ title: 'TooManyDeps', depends_on: tooManyDeps })
      expect(parsed.success).toBe(false)
      expect((parsed as any).error.issues[0].message).toBe('INVALID: depends_on too long')
      const res = handleCreateTask(svc, { title: 'TooManyDeps', reporter: 'dev', depends_on: tooManyDeps })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: depends_on too long')
    })
  })

  // #1880: `reporter` and `assignee` are the last two string fields the create guard bounds, and
  // the advertised schema now carries their bound too (the guard always did). The SCHEMA is
  // asserted, not only the behaviour: a bound that lives in the guard alone is a schema that
  // understates what the service refuses, and the two layers drift apart at the boundary.
  describe('the actor names carry the advertised bound (#1880)', () => {
    // The registered create_task inputSchema, as JSON Schema: the shape the MCP layer validates
    // against and advertises, so a bound missing from it shows up here and not only over the wire.
    function advertisedSchema(): any {
      return z.toJSONSchema(createTaskShape())
    }

    test('the registered schema bounds every string field the guard bounds', () => {
      const schema = advertisedSchema()
      expect(schema.properties.title.maxLength).toBe(MAX_TITLE_LENGTH)
      expect(schema.properties.description.maxLength).toBe(MAX_DESCRIPTION_LENGTH)
      expect(schema.properties.reporter.maxLength).toBe(MAX_AGENT_LENGTH)
      expect(schema.properties.assignee.maxLength).toBe(MAX_AGENT_LENGTH)
      // The two layers must refuse the same strings, so the bounded set is the guard's set in BOTH
      // directions: a field the guard bounds but the schema does not advertise fails here, and so
      // does a field the schema bounds but the guard does not.
      const bounded = Object.entries(schema.properties)
        .filter(([, prop]: any) => prop.maxLength !== undefined)
        .map(([name]) => name)
        .sort()
      expect(bounded).toEqual(['assignee', 'description', 'reporter', 'title'])
      // The id count is an array bound, so it travels as maxItems - it stays where it was.
      expect(schema.properties.depends_on.maxItems).toBe(MAX_DEPENDS_ON)
    })

    test('a reporter of exactly MAX_AGENT_LENGTH code points is accepted by both layers', () => {
      const reporter = multiByte(MAX_AGENT_LENGTH)
      expect(codePoints(reporter)).toBe(MAX_AGENT_LENGTH)
      expect(createTaskShape().safeParse({ title: 'ReporterAtLimit', reporter }).success).toBe(true)
      const res = handleCreateTask(svc, { title: 'ReporterAtLimit', reporter })
      expect(res.isError).toBeUndefined()
      expect(codePoints(getTaskRow(db, json(res).id).reporter)).toBe(MAX_AGENT_LENGTH)
    })

    test('a reporter of MAX_AGENT_LENGTH + 1 code points is refused by both layers', () => {
      const reporter = multiByte(MAX_AGENT_LENGTH + 1)
      expect(codePoints(reporter)).toBe(MAX_AGENT_LENGTH + 1)
      const parsed = createTaskShape().safeParse({ title: 'ReporterOver', reporter })
      expect(parsed.success).toBe(false)
      expect((parsed as any).error.issues[0].message).toBe('INVALID: reporter too long')
      expect((parsed as any).error.issues[0].path).toEqual(['reporter'])
      const res = handleCreateTask(svc, { title: 'ReporterOver', reporter })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: reporter too long')
    })

    test('the reporter refusal writes no task row, no audit row and no comment', () => {
      const before = storeCounts()
      handleCreateTask(svc, { title: 'ReporterOver', reporter: multiByte(MAX_AGENT_LENGTH + 1) })
      expect(storeCounts()).toEqual(before)
    })

    test('the guard order is pinned: the length refusal comes before the creation refusal', () => {
      // An over-long assignee is too long FIRST; an in-bounds one reaches the creation refusal.
      // Both strings are unchanged - the order is what the test pins.
      const over = handleCreateTask(svc, { title: 'LongAssignee', reporter: 'dev', assignee: multiByte(MAX_AGENT_LENGTH + 1) })
      expect(over.isError).toBe(true)
      expect(text(over)).toBe('INVALID: assignee too long')
      const inBounds = handleCreateTask(svc, { title: 'Assignee', reporter: 'dev', assignee: 'boss' })
      expect(inBounds.isError).toBe(true)
      expect(text(inBounds)).toBe('INVALID: assignee is refused at creation: a task holds a lease only from in_progress')
    })

    test('the assignee length refusal writes no task row, no audit row and no comment', () => {
      const before = storeCounts()
      handleCreateTask(svc, { title: 'LongAssignee', reporter: 'dev', assignee: multiByte(MAX_AGENT_LENGTH + 1) })
      expect(storeCounts()).toEqual(before)
    })

    test('an assignee of exactly MAX_AGENT_LENGTH code points is not too long: it reaches the creation refusal', () => {
      // The boundary is exactly 200 code points: the schema accepts it, so the guard answers with
      // the creation refusal instead of the length one.
      const assignee = multiByte(MAX_AGENT_LENGTH)
      expect(codePoints(assignee)).toBe(MAX_AGENT_LENGTH)
      expect(createTaskShape().safeParse({ title: 'AssigneeAtLimit', assignee }).success).toBe(true)
      const res = handleCreateTask(svc, { title: 'AssigneeAtLimit', reporter: 'dev', assignee })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('INVALID: assignee is refused at creation: a task holds a lease only from in_progress')
    })
  })
})

describe('claimTask whitespace agent (#811)', () => {
  test('claimTask rejects whitespace-only agent via zod schema', () => {
    const id = json(handleCreateTask(svc, { title: 'WsAgent', reporter: 'dev' })).id
    const res = handleClaimTask(svc, { agent: '   ', task_id: id })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent required')
  })

  test('claimTask rejects empty agent via zod schema', () => {
    const id = json(handleCreateTask(svc, { title: 'EmptyAgent', reporter: 'dev' })).id
    const res = handleClaimTask(svc, { agent: '', task_id: id })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent required')
  })
})

describe('claimTask taskId branch (F1 #1040)', () => {
  test('claimTask with an explicit taskId claims that task, not the queue head', () => {
    const bait = json(handleCreateTask(svc, { title: 'Bait', reporter: 'dev', priority: 'p0' })).id
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev', priority: 'p3' })).id
    const res = svc.claimTask({ agent: 'test', taskId: target })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.id).toBe(target)
    expect(getTaskRow(db, bait).status).toBe('queued')
  })

  test('claimTask with taskId 0 → NOT_FOUND, never an auto-claim', () => {
    const bait = json(handleCreateTask(svc, { title: 'Bait', reporter: 'dev', priority: 'p0' })).id
    const res = svc.claimTask({ agent: 'test', taskId: 0 })
    expect(res).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '' } })
    expect(getTaskRow(db, bait).status).toBe('queued')
    expect(getTaskRow(db, bait).lease_expires_at).toBeNull()
  })

  test('claimTask with an omitted taskId still auto-picks (unchanged behaviour)', () => {
    const bait = json(handleCreateTask(svc, { title: 'Bait', reporter: 'dev', priority: 'p0' })).id
    const res = svc.claimTask({ agent: 'test' })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.id).toBe(bait)
  })

  test('the wire name task_id is not a core parameter: only taskId is honoured', () => {
    const bait = json(handleCreateTask(svc, { title: 'Bait', reporter: 'dev', priority: 'p0' })).id
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev', priority: 'p3' })).id
    // The wire-shaped {task_id} leaves core's taskId undefined, so the auto-pick branch
    // runs and takes the p0 bait. Proof the id/task_id resolution lives at the MCP edge.
    const res = svc.claimTask({ agent: 'test', task_id: target } as any)
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('unreachable')
    expect(res.data.id).toBe(bait)
    expect(getTaskRow(db, target).status).toBe('queued')
  })
})

describe('listTasks invalid status filter (#811)', () => {
  test('listTasks rejects an unknown status through the input schema enum', () => {
    let schema: any
    registerAllTools({ registerTool: (name: string, cfg: any) => { if (name === 'list_tasks') schema = cfg.inputSchema } } as any, svc)
    expect(schema.safeParse({ status: 'invalid_status' }).success).toBe(false)
    // the enum is sourced from TASK_STATUSES, so every status must pass and nothing else may
    for (const status of TASK_STATUSES) {
      expect(`${status}:${schema.safeParse({ status }).success}`).toBe(`${status}:true`)
    }
  })

  test('listTasks with valid status filter works', () => {
    const id = json(handleCreateTask(svc, { title: 'ValidStatus', reporter: 'dev' })).id
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: 1 })
    const res = json(handleListTasks(svc, { status: 'blocked' }))
    expect(res.tasks.some((t: any) => t.id === id)).toBe(true)
  })
})

describe('TaskService error contract after the hygiene refactor (#1445)', () => {
  test('claim: an unknown task id is NOT_FOUND:', () => {
    expect(svc.claimTask({ agent: 'a', taskId: 9999 })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '' } })
  })

  test('claim: an already-leased task is CONFLICT: status=<current>', () => {
    const id = json(handleCreateTask(svc, { title: 'Busy', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'a', task_id: id })
    expect(svc.claimTask({ agent: 'b', taskId: id })).toEqual({ ok: false, error: { code: 'CONFLICT', message: 'status=in_progress' } })
  })

  test('claim: an empty queue is EMPTY: no claimable tasks', () => {
    expect(svc.claimTask({ agent: 'a' })).toEqual({ ok: false, error: { code: 'EMPTY', message: 'no claimable tasks' } })
  })

  test('claim: a lost compare-and-swap is CONFLICT: version mismatch', () => {
    const id = json(handleCreateTask(svc, { title: 'LostRace', reporter: 'dev' })).id
    const raced = new TaskRepo(db)
    raced.markClaimed = () => 0
    expect(new TaskService(raced, { leaseTtlMin: 15, scope: 'test' }).claimTask({ agent: 'a', taskId: id }))
      .toEqual({ ok: false, error: { code: 'CONFLICT', message: 'version mismatch' } })
  })

  test('update_status: an unknown task id is NOT_FOUND:', () => {
    expect(svc.updateStatus({ id: 9999, agent: 'a', status: 'blocked', version: 1 }))
      .toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '' } })
  })

  test('update_status: a lost compare-and-swap is CONFLICT: concurrent modification', () => {
    const id = json(handleCreateTask(svc, { title: 'LostRace2', reporter: 'dev' })).id
    const raced = new TaskRepo(db)
    raced.transitionStatus = () => 0
    expect(new TaskService(raced, { leaseTtlMin: 15, scope: 'test' }).updateStatus({ id, agent: 'a', status: 'blocked', version: 1 }))
      .toEqual({ ok: false, error: { code: 'CONFLICT', message: 'concurrent modification' } })
  })

  test('add_comment: an unknown task id is NOT_FOUND:', () => {
    expect(svc.addComment({ id: 9999, agent: 'a', content: 'x' })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: '' } })
  })
})
