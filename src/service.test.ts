import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { nowIso, clampLimit, TASK_STATUSES, MAX_RESULT_LIMIT, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH } from './core/tasks'
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
    const _freeId = repo2.insertTask({
      title: 'Free',
      description: null,
      priority: 'p2',
      assignee: null,
      reporter: 'dev',
      depends_on: '[]',
      now: nowIso(),
      projectId: testProjectId(repo2)
    })

    const res = handleClaimTask(svc2, { agent: 'agent-1' })
    expect(text(res)).toContain('EMPTY')

    closeTestDb(db2)
  })

  test('default ceiling finds free task beyond 100 blocked tasks', () => {
    const db2 = createTestDb()
    const repo2 = new TaskRepo(db2)
    const svc2 = new TaskService(repo2, { leaseTtlMin: 15, scope: 'test' })

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
    const _freeId = repo2.insertTask({
      title: 'Free',
      description: null,
      priority: 'p2',
      assignee: null,
      reporter: 'dev',
      depends_on: '[]',
      now: nowIso(),
      projectId: testProjectId(repo2)
    })

    const res = handleClaimTask(svc2, { agent: 'agent-1' })
    expect(json(res).id).toBe(_freeId)

    closeTestDb(db2)
  })

  test('parse-once cache: auto-claim with many dep-blocked tasks finds free one', () => {
    // Regression: parse-once refactor must not change behavior for the common case
    for (let i = 0; i < 10; i++) {
      createTaskRow({ title: `Blocked ${i}`, reporter: 'dev', depends_on: [999] })
    }
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

  test('createTask accepts assignee == MAX_AGENT_LENGTH', () => {
    const id = json(handleCreateTask(svc, { title: 'OkAssignee', reporter: 'dev', assignee: OK_AGENT })).id
    const row = getTaskRow(db, id)
    expect(row.assignee).toBe(OK_AGENT)
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
