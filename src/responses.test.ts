import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleListTasks, handleClaimTask,
  handleListQueue, handleAddComment, handleGetTimeline, handleUpdateStatus
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
      not_found: 0, queued: 1, in_progress: 2, review: 3, done: 4, failed: 5, blocked: 6, canceled: 7
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
