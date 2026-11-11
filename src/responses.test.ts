import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask,
  handleGetTask,
  handleListTasks,
  handleClaimTask,
  handleListQueue,
  handleUpdateStatus
} from './mcp/task-tools'
import { handleAddComment, handleGetTimeline } from './mcp/comment-tools'
import {
  createTestDb,
  closeTestDb,
  insertTaskRow,
  getTaskRow,
  json,
  text,
  driveToDone,
  type CreateTaskRowOpts
} from './test-context'

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
const createTaskRow = (opts: CreateTaskRowOpts) => insertTaskRow(repo, opts)

describe('pipe formats (v2)', () => {
  test('list_tasks ids pipe default id|code, unknown id → |0', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    driveToDone(svc, a, 'agent-1')
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    const out = text(handleListTasks(svc, { ids: [a, b, 999] }))
    expect(out).toBe(`${a}|4\n${b}|1\n999|0`)
  })

  test('list_tasks ids pipe with assignee field uses narrowing (not cast) for both present and null assignees', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'worker-1', task_id: a })
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    const c = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id
    const out = text(handleListTasks(svc, { ids: [a, b, c, 999], fields: ['assignee'] }))
    expect(out).toBe(`${a}|2|worker-1\n${b}|1|-\n${c}|1|-\n999|0|-`)
  })

  test('list_tasks ids pipe with fields assignee: null → -', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    handleClaimTask(svc, { agent: 'worker-1' })
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev' })).id
    const out = text(handleListTasks(svc, { ids: [a, b, 999], fields: ['assignee'] }))
    expect(out).toBe(`${a}|2|worker-1\n${b}|1|-\n999|0|-`)
  })

  test('list_tasks ids pipe renders any requested field in request order', () => {
    const a = json(
      handleCreateTask(svc, { title: 'Fix | me', reporter: 'dev', description: 'the contract' })
    ).id
    const out = text(
      handleListTasks(svc, { ids: [a, 999], fields: ['title', 'description', 'priority'] })
    )
    expect(out).toBe(`${a}|1|Fix / me|the contract|p2\n999|0|-|-|-`)
  })

  test('list_tasks ids json mode returns selected fields and code 0 for an unknown id', () => {
    const a = json(
      handleCreateTask(svc, { title: 'Json', reporter: 'dev', description: 'a|b\nc' })
    ).id
    const res = json(
      handleListTasks(svc, { ids: [a, 999], fields: ['title', 'description'], format: 'json' })
    )
    expect(res.total).toBe(2)
    expect(res.tasks[0]).toEqual({ id: a, code: 1, title: 'Json', description: 'a|b\nc' })
    expect(res.tasks[1]).toEqual({ id: 999, code: 0 })
  })

  test('format is ignored when filters are used (the filter mode is always json)', () => {
    json(handleCreateTask(svc, { title: 'Filtered', reporter: 'dev' }))
    const res = json(handleListTasks(svc, { format: 'pipe' }))
    expect(res.total).toBe(1)
    expect(res.tasks[0].title).toBe('Filtered')
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
    const ids = out.split('\n').map((line) => Number(line.split('|')[0]))
    const p0 = out.split('\n').findIndex((l) => l.includes('|p0|'))
    const p1 = out.split('\n').findIndex((l) => l.includes('|p1|'))
    const p2 = out.split('\n').findIndex((l) => l.includes('|p2|'))
    expect(p0).toBeLessThan(p1)
    expect(p1).toBeLessThan(p2)
    expect(ids.length).toBe(3)
  })

  test('STATUS_CODES legend', async () => {
    const { STATUS_CODES } = await import('./core/tasks')
    expect(STATUS_CODES).toEqual({
      not_found: 0,
      queued: 1,
      in_progress: 2,
      review: 3,
      done: 4,
      failed: 5,
      blocked: 6,
      canceled: 7,
      open: 8
    })
  })
})

describe('get_task / list_tasks fields (v2)', () => {
  test('brief default excludes description', () => {
    const id = json(
      handleCreateTask(svc, { title: 'Brief', reporter: 'dev', description: 'secret content' })
    ).id
    const brief = json(handleGetTask(svc, { id }))
    expect('description' in brief).toBe(false)
    expect(brief.title).toBe('Brief')
    expect(brief.status).toBe('queued')
  })

  test('description only via explicit fields', () => {
    const id = json(
      handleCreateTask(svc, { title: 'Explicit', reporter: 'dev', description: 'full text' })
    ).id
    const full = json(handleGetTask(svc, { id, fields: ['id', 'description'] }))
    expect(full.description).toBe('full text')
  })

  test('removed fields are absent even when requested', () => {
    const id = json(handleCreateTask(svc, { title: 'No paths', reporter: 'dev' })).id
    const res = json(
      handleGetTask(svc, { id, fields: ['task_path', 'result_path', 'parent_id', 'status'] })
    )
    expect(res).toEqual({ status: 'queued' })
  })

  test('omit-null in get_task', () => {
    const id = json(handleCreateTask(svc, { title: 'Nulls', reporter: 'dev' })).id
    const res = json(
      handleGetTask(svc, { id, fields: ['assignee', 'completed_at', 'lease_expires_at', 'status'] })
    )
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

  test('updated_since accepts 0 and future within range', () => {
    json(handleCreateTask(svc, { title: 'SinceZero', reporter: 'dev' }))
    const all = json(handleListTasks(svc, { updated_since: 0 }))
    expect(all.total).toBeGreaterThan(0)
    const future = json(handleListTasks(svc, { updated_since: Date.now() + 60_000 }))
    expect(future.total).toBe(0)
  })
})

describe('max_field_chars (result size cap)', () => {
  test('get_task truncates a long field and reports the remainder', () => {
    const id = json(
      handleCreateTask(svc, { title: 'Cap', reporter: 'dev', description: 'abcdefghij' })
    ).id
    const res = json(handleGetTask(svc, { id, fields: ['id', 'description'], max_field_chars: 4 }))
    expect(res.description).toBe('abcd…(+6 chars)')
  })

  test('omitting max_field_chars keeps the full text', () => {
    const id = json(
      handleCreateTask(svc, { title: 'Full', reporter: 'dev', description: 'abcdefghij' })
    ).id
    const res = json(handleGetTask(svc, { id, fields: ['description'] }))
    expect(res.description).toBe('abcdefghij')
  })

  test('the cap counts code points, so a surrogate pair is not split', () => {
    const id = json(
      handleCreateTask(svc, { title: 'Emoji', reporter: 'dev', description: '😀😀😀😀😀' })
    ).id
    const res = json(handleGetTask(svc, { id, fields: ['description'], max_field_chars: 2 }))
    expect(res.description).toBe('😀😀…(+3 chars)')
  })

  test('list_tasks json mode applies the cap', () => {
    json(handleCreateTask(svc, { title: 'ListCap', reporter: 'dev', description: 'abcdefghij' }))
    const res = json(handleListTasks(svc, { fields: ['id', 'description'], max_field_chars: 3 }))
    expect(res.tasks[0].description).toBe('abc…(+7 chars)')
  })

  test('list_tasks ids pipe mode applies the cap', () => {
    const id = json(
      handleCreateTask(svc, { title: 'IdsCap', reporter: 'dev', description: 'abcdefghij' })
    ).id
    const out = text(
      handleListTasks(svc, { ids: [id], fields: ['description'], max_field_chars: 3 })
    )
    expect(out).toBe(`${id}|1|abc…(+7 chars)`)
  })

  test('claim_task applies the cap to the requested fields', () => {
    const id = json(
      handleCreateTask(svc, { title: 'ClaimCap', reporter: 'dev', description: 'abcdefghij' })
    ).id
    const res = json(
      handleClaimTask(svc, {
        agent: 'dev',
        task_id: id,
        fields: ['title', 'description'],
        max_field_chars: 8
      })
    )
    expect(res.description).toBe('abcdefgh…(+2 chars)')
    expect(res.title).toBe('ClaimCap')
  })
})

describe('create_task description no longer seeds comment (#431)', () => {
  test('description argument does not create a comment row', () => {
    const id = json(
      handleCreateTask(svc, { title: 'NoSeed', reporter: 'dev', description: 'my desc' })
    ).id
    const comments = db.query('SELECT * FROM comments WHERE task_id = ?').all(id) as any[]
    expect(comments.length).toBe(0)
  })

  test('timeline for task with description contains only create audit, not a comment', () => {
    const id = json(
      handleCreateTask(svc, { title: 'TLNoSeed', reporter: 'dev', description: 'hidden desc' })
    ).id
    const out = text(handleGetTimeline(svc, { id }))
    const lines = out.split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0].split('|')[1]).toBe('action')
    expect(lines[0]).not.toContain('hidden desc')
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
    const logs = db
      .query("SELECT * FROM audit_log WHERE task_id = ? AND action = 'create'")
      .all(id) as any[]
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
    expect(text(res)).toContain('NOT_FOUND:')
  })

  test('empty agent rejected', () => {
    const id = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id
    const res = handleAddComment(svc, { id, agent: '', content: 'x' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: agent required')
  })

  test('empty content rejected', () => {
    const id = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id
    const res = handleAddComment(svc, { id, agent: 'dev', content: '' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: content required')
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
    handleUpdateStatus(svc, {
      id,
      agent: 'agent-1',
      status: 'review',
      version: v,
      comment: 'check | this'
    })
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
    const reviewLine = lines.find((l) => l.includes('check / this'))
    expect(reviewLine).toBeDefined()
  })

  test('unknown id returns NOT_FOUND', () => {
    const res = handleGetTimeline(svc, { id: 9999 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('NOT_FOUND:')
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

  test('a limit returns the newest N events, still in ascending order (#2243)', () => {
    const id = json(handleCreateTask(svc, { title: 'Window', reporter: 'dev' })).id
    for (const content of ['e2', 'e3', 'e4', 'e5', 'e6'])
      handleAddComment(svc, { id, agent: 'a', content })
    const lines = text(handleGetTimeline(svc, { id, limit: 3 })).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.split('|')[1])).toEqual(['comment', 'comment', 'comment'])
    expect(lines.map((l) => l.split('|')[4])).toEqual(['e4', 'e5', 'e6'])
    expect(lines.map((l) => l.split('|')[0])).toEqual(['1', '2', '3'])
  })

  test('a frozen-clock tie between an audit row and a comment has a deterministic order (#2243)', () => {
    const frozen = '2026-01-01T00:00:00.000Z'
    const clock = { nowMs: () => Date.parse(frozen), nowIso: () => frozen }
    const frozenSvc = new TaskService(new TaskRepo(db, clock), {
      leaseTtlMin: 15,
      scope: 'test',
      clock
    })
    const id = json(handleCreateTask(frozenSvc, { title: 'Tie', reporter: 'dev' })).id
    handleAddComment(frozenSvc, { id, agent: 'a', content: 'note' })
    handleClaimTask(frozenSvc, { agent: 'a', task_id: id })
    const events = text(handleGetTimeline(frozenSvc, { id }))
      .split('\n')
      .map((l) => l.split('|'))
    expect(events).toHaveLength(3)
    expect(events.map((cols) => cols[1])).toEqual(['action', 'action', 'comment'])
    expect(events.map((cols) => cols[4])).toEqual([
      'create: null->queued',
      'claim: queued->in_progress',
      'note'
    ])
    expect(text(handleGetTimeline(frozenSvc, { id }))).toBe(
      text(handleGetTimeline(frozenSvc, { id }))
    )
  })

  test('default limit caps results when many entries exist', () => {
    const id = json(handleCreateTask(svc, { title: 'DfltLim', reporter: 'dev' })).id
    for (let i = 0; i < 52; i++) {
      repo.insertComment(id, 'a', `c${i}`)
    }
    const out = text(handleGetTimeline(svc, { id }))
    const lines = out.split('\n')
    expect(lines.length).toBe(20)
  })

  test('since is a forward cursor: the oldest N events at or after it, ascending', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() }
    const cursorSvc = new TaskService(new TaskRepo(db, clock), {
      leaseTtlMin: 15,
      scope: 'test',
      clock
    })
    const id = json(handleCreateTask(cursorSvc, { title: 'Cursor', reporter: 'dev' })).id
    now += 1000
    handleAddComment(cursorSvc, { id, agent: 'a', content: 'c1' })
    now += 1000
    handleAddComment(cursorSvc, { id, agent: 'a', content: 'c2' })
    now += 1000
    handleAddComment(cursorSvc, { id, agent: 'a', content: 'c3' })

    const newest = text(handleGetTimeline(cursorSvc, { id, limit: 2 }))
    expect(newest.split('\n').map((l) => l.split('|')[4])).toEqual(['c2', 'c3'])

    const page1 = text(
      handleGetTimeline(cursorSvc, { id, since: Date.parse('2026-01-01T00:00:01.000Z'), limit: 2 })
    )
    expect(page1.split('\n').map((l) => l.split('|')[4])).toEqual(['c1', 'c2'])

    const page2 = text(
      handleGetTimeline(cursorSvc, { id, since: Date.parse('2026-01-01T00:00:02.000Z'), limit: 2 })
    )
    expect(page2.split('\n').map((l) => l.split('|')[4])).toEqual(['c2', 'c3'])

    const rest = text(
      handleGetTimeline(cursorSvc, { id, since: Date.parse('2026-01-01T00:00:03.000Z'), limit: 2 })
    )
    expect(rest.split('\n').map((l) => l.split('|')[4])).toEqual(['c3'])
  })

  test('since past the newest event returns empty text', () => {
    const id = json(handleCreateTask(svc, { title: 'NoNew', reporter: 'dev' })).id
    expect(text(handleGetTimeline(svc, { id, since: Date.now() + 60_000 }))).toBe('')
  })

  test('an unrepresentable since is refused without a read', () => {
    const id = json(handleCreateTask(svc, { title: 'BadSince', reporter: 'dev' })).id
    const res = handleGetTimeline(svc, { id, since: Number.MAX_SAFE_INTEGER })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: invalid since')
  })

  test('max_text_chars truncates each text with a marker', () => {
    const id = json(handleCreateTask(svc, { title: 'TextCap', reporter: 'dev' })).id
    handleAddComment(svc, { id, agent: 'a', content: 'abcdefghij' })
    const lines = text(handleGetTimeline(svc, { id, max_text_chars: 4 })).split('\n')
    expect(lines[lines.length - 1].endsWith('|abcd…(+6 chars)')).toBe(true)
  })

  test('max_text_chars: 0 omits the text column entirely', () => {
    const id = json(handleCreateTask(svc, { title: 'NoText', reporter: 'dev' })).id
    handleAddComment(svc, { id, agent: 'a', content: 'hidden note' })
    const lines = text(handleGetTimeline(svc, { id, max_text_chars: 0 })).split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.split('|')).toHaveLength(4)
    expect(text(handleGetTimeline(svc, { id, max_text_chars: 0 }))).not.toContain('hidden note')
  })

  test('empty timeline for fresh task (only create audit)', () => {
    const id = json(handleCreateTask(svc, { title: 'Fresh', reporter: 'dev' })).id
    const out = text(handleGetTimeline(svc, { id }))
    const lines = out.split('\n')
    expect(lines.length).toBe(1)
    expect(lines[0].split('|')[1]).toBe('action')
  })
})

describe('update_status response shape (F2 #1065 + F3 #1066)', () => {
  function claimed(agent = 'agent-1'): number {
    const id = json(handleCreateTask(svc, { title: 'Resp', reporter: 'dev' })).id
    handleClaimTask(svc, { agent, task_id: id })
    return id
  }
  const version = (id: number) => json(handleGetTask(svc, { id, fields: ['version'] })).version

  test('a plain transition keeps the {id, status, version} shape and adds no attempts', () => {
    const id = claimed()
    const res = json(
      handleUpdateStatus(svc, { id, agent: 'agent-1', status: 'review', version: version(id) })
    )
    expect(Object.keys(res).sort()).toEqual(['id', 'status', 'version'])
    expect('attempts' in res).toBe(false)
  })

  test('a renewal keeps the {id, status, version} shape too (no lease field, token economy)', () => {
    const id = claimed()
    const res = json(
      handleUpdateStatus(svc, {
        id,
        agent: 'agent-1',
        status: 'in_progress',
        renew: true,
        version: version(id)
      })
    )
    expect(Object.keys(res).sort()).toEqual(['id', 'status', 'version'])
    expect('lease_expires_at' in res).toBe(false)
    expect('lease_until' in res).toBe(false)
  })

  test('a refund adds attempts — the in-band signal that the flag reached the server', () => {
    const id = claimed()
    db.run('UPDATE tasks SET attempts = 2 WHERE id = ?', [id])
    const res = json(
      handleUpdateStatus(svc, {
        id,
        agent: 'agent-1',
        status: 'blocked',
        version: version(id),
        reset_attempts: true,
        comment: 'spent on accidents'
      })
    )
    expect(Object.keys(res).sort()).toEqual(['attempts', 'id', 'status', 'version'])
    expect(res.attempts).toBe(0)
  })

  test('reset_attempts: false keeps the plain shape (the echo keys off the request, not the value)', () => {
    const id = claimed()
    db.run('UPDATE tasks SET attempts = 2 WHERE id = ?', [id])
    const res = json(
      handleUpdateStatus(svc, {
        id,
        agent: 'agent-1',
        status: 'blocked',
        version: version(id),
        reset_attempts: false,
        comment: 'parking'
      })
    )
    expect(Object.keys(res).sort()).toEqual(['id', 'status', 'version'])
    expect(getTaskRow(db, id).attempts).toBe(2)
  })
})
