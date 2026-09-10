import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { nowIso, clampLimit, MAX_RESULT_LIMIT } from './core/tasks'
import type { TaskStore } from './core/service'
import { TaskRepo } from './db/repo'
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
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
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
      statusOf: () => null,
      statusesOf: () => new Map(),
      batchTasks: () => new Map(),
      markClaimed: () => 0,
      transitionStatus: () => {},
      expiredLeases: () => { reapCb?.(); return [] },
      reapSettle: () => 0,
      insertComment: () => 1,
      auditAppend: () => {},
      timelineEntries: () => [],
      nonTerminalChildCount: () => 0,
      childStatusCounts: () => ({ total: 0, open: 0, done: 0, failed: 0 }),
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

    expect(repo.doneCount('0001-01-01T00:00:00.000Z')).toBe(2)
    expect(computeMetrics(repo, 'all').doneCount).toBe(2)
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

    const map = Object.fromEntries(repo.statusDurations('0001-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z').map(r => [r.status, r.minutes]))
    expect(Math.round(map.queued)).toBe(10)
    expect(Math.round(map.in_progress)).toBe(10)
    expect(Math.round(map.review)).toBe(10)
    expect(map.done ?? 0).toBe(0)
  })
})
