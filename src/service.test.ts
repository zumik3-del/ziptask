import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { nowIso, clampLimit, MAX_RESULT_LIMIT, MAX_AGENT_LENGTH, MAX_CONTENT_LENGTH } from './core/tasks'
import type { TaskStore } from './core/types'
import { TaskRepo } from './db/repo'
import { MetricsRepo } from './db/metrics-repo'
import { TaskService } from './core/service'
import { computeMetrics } from './core/metrics'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus,
  handleAddComment, handleListQueue, handleGetTimeline
} from './mcp/tools'
import {
  createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text, driveToDone,
  type CreateTaskRowOpts
} from './test-context'

let db: Database
let repo: TaskRepo
let metrics: MetricsRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); metrics = new MetricsRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })
const createTaskRow = (opts: CreateTaskRowOpts) => insertTaskRow(repo, opts)

describe('audit_log toggle', () => {
  function makeAuditSvc(auditLog: boolean): { db: Database; repo: TaskRepo; svc: TaskService } {
    const d = createTestDb()
    const r = new TaskRepo(d)
    const s = new TaskService(r, { leaseTtlMin: 15, auditLog })
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

describe('reap cooldown (#104)', () => {
  function fakeStore(reapCb?: () => void): TaskStore {
    return {
      getTaskRow: () => null,
      insertTask: () => 1,
      deleteTask: () => {},
      listTasks: () => ({ rows: [], total: 0 }),
      queuedCandidates: () => [],
      depsOf: () => null,
      statusesOf: () => new Map(),
      batchTasks: () => new Map(),
      markClaimed: () => 0,
      transitionStatus: () => 0,
      transaction: <T>(fn: () => T) => fn(),
      expiredLeases: () => { reapCb?.(); return [] },
      reapSettle: () => 0,
      insertComment: () => 1,
      auditAppend: () => {},
       timelineEntries: () => [],
       commentsOf: () => [],
       nonTerminalChildCount: () => 0,
      childStatusCounts: () => ({ total: 0, open: 0, done: 0, failed: 0, canceled: 0 }),
      promoteEpicWithMirror: () => {},
      appendEpicAuditMirror: () => {}
    }
  }

  test('first read call reaps (lastReapAt=0), second read within cooldown skips', () => {
    let reapCallCount = 0
    const svc = new TaskService(fakeStore(() => { reapCallCount++ }), { reapCooldownSec: 3600 })

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
    const svc = new TaskService(fakeStore(() => { reapCallCount++ }), { reapCooldownSec: 0 })

    svc.getTaskView(1)
    expect(reapCallCount).toBe(1)
    svc.getTaskView(2)
    expect(reapCallCount).toBe(2)
    svc.claimTask({ agent: 'test' })
    expect(reapCallCount).toBe(3)
  })

  test('public reapExpiredLeases always forces regardless of cooldown', () => {
    let reapCallCount = 0
    const svc = new TaskService(fakeStore(() => { reapCallCount++ }), { reapCooldownSec: 3600 })

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
    const svc2 = new TaskService(repo2, { leaseTtlMin: 15, autoClaimCeiling: 100 })

    for (let i = 0; i < 150; i++) {
      repo2.insertTask({
        title: `Blocked ${i}`,
        description: null,
        priority: 'p2',
        assignee: null,
        reporter: 'dev',
        depends_on: JSON.stringify([999]),
        now: nowIso()
      })
    }
    const _freeId = repo2.insertTask({
      title: 'Free',
      description: null,
      priority: 'p2',
      assignee: null,
      reporter: 'dev',
      depends_on: '[]',
      now: nowIso()
    })

    const res = handleClaimTask(svc2, { agent: 'agent-1' })
    expect(text(res)).toContain('EMPTY')

    closeTestDb(db2)
  })

  test('default ceiling finds free task beyond 100 blocked tasks', () => {
    const db2 = createTestDb()
    const repo2 = new TaskRepo(db2)
    const svc2 = new TaskService(repo2, { leaseTtlMin: 15 })

    for (let i = 0; i < 150; i++) {
      repo2.insertTask({
        title: `Blocked ${i}`,
        description: null,
        priority: 'p2',
        assignee: null,
        reporter: 'dev',
        depends_on: JSON.stringify([999]),
        now: nowIso()
      })
    }
    const _freeId = repo2.insertTask({
      title: 'Free',
      description: null,
      priority: 'p2',
      assignee: null,
      reporter: 'dev',
      depends_on: '[]',
      now: nowIso()
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
    const configured = new TaskService(repo, { defaultPriority: 'p0', defaultReporter: 'human' })
    const id = json(handleCreateTask(configured, { title: 'C' })).id
    const row = getTaskRow(db, id)
    expect(row.priority).toBe('p0')
    expect(row.reporter).toBe('human')
  })
})

describe('metrics exclude epics (#2)', () => {
  function driveEpicToDone(id: number) {
    let v = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'in_progress', version: v })
    v = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: v })
    v = json(handleGetTask(svc, { id, fields: ['version'] })).version
    handleUpdateStatus(svc, { id, agent: 'dev', status: 'done', version: v })
  }

  test('done_count excludes closed epics', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    const plainId = json(handleCreateTask(svc, { title: 'Plain', reporter: 'dev' })).id
    driveToDone(svc, subId, 'dev')
    driveToDone(svc, plainId, 'dev')
    driveEpicToDone(epicId)

    expect(metrics.doneCount('0001-01-01T00:00:00.000Z')).toBe(2)
    expect(computeMetrics(metrics, 'all').doneCount).toBe(2)
  })

  test('statusDurations computes clamped segment minutes and ignores epics', () => {
    const ins = (id: number, action: string, nv: string, at: string) =>
      db.run("INSERT INTO audit_log (task_id,agent,action,old_value,new_value,created_at) VALUES (?,?,?,?,?,?)", [id, 'dev', action, null, nv, at])

    const id = repo.insertTask({ title: 'T', description: null, priority: 'p2', assignee: null, reporter: 'dev', depends_on: '[]', now: '2020-01-01T00:00:00.000Z' })
    db.run("UPDATE tasks SET created_at=?, updated_at=?, status='done', completed_at=? WHERE id=?", ['2020-01-01T00:00:00.000Z', '2020-01-01T00:30:00.000Z', '2020-01-01T00:30:00.000Z', id])
    ins(id, 'claim', 'in_progress', '2020-01-01T00:10:00.000Z')
    ins(id, 'update_status', 'review', '2020-01-01T00:20:00.000Z')
    ins(id, 'update_status', 'done', '2020-01-01T00:30:00.000Z')

    const epicId = repo.insertTask({ title: 'E', description: null, priority: 'p2', assignee: null, reporter: 'dev', depends_on: '[]', now: '2020-01-01T00:00:00.000Z', isEpic: 1 })
    db.run('UPDATE tasks SET created_at=? WHERE id=?', ['2020-01-01T00:00:00.000Z', epicId])

    const map = Object.fromEntries(metrics.statusDurations('0001-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z').map(r => [r.status, r.minutes]))
    expect(Math.round(map.queued)).toBe(10)
    expect(Math.round(map.in_progress)).toBe(10)
    expect(Math.round(map.review)).toBe(10)
    expect(map.done ?? 0).toBe(0)
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
