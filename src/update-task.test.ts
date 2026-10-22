import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { codePointLength, nowIso } from './core/tasks'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus, handleUpdateTask
} from './mcp/task-tools'
import {
  createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' }) })
afterEach(() => { closeTestDb(db) })

const createTaskRow = (opts: any = {}) => insertTaskRow(repo, { title: opts.title ?? 'Task', reporter: opts.reporter ?? 'dev', priority: opts.priority, depends_on: opts.depends_on })
const row = (id: number) => getTaskRow(db, id)
const versionOf = (id: number): number => json(handleGetTask(svc, { id, fields: ['version'] })).version
const auditRows = (id: number) =>
  db.query('SELECT action, old_value, new_value FROM audit_log WHERE task_id = ? ORDER BY id')
    .all(id) as Array<{ action: string; old_value: string | null; new_value: string | null }>
const countAudit = (id: number, action: string): number =>
  (db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = ?').get(id, action) as { n: number }).n
const storeCounts = () => {
  const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { tasks: count('tasks'), audit: count('audit_log'), comments: count('comments') }
}

describe('update_task: successful writes', () => {
  test('title update: changed, version bump, audit row', () => {
    const id = json(handleCreateTask(svc, { title: 'Old', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'New' })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, version: 2, changed: ['title'] })
    expect(row(id).title).toBe('New')
    expect(row(id).version).toBe(2)
    const audits = auditRows(id).filter(a => a.action === 'update_task:title')
    expect(audits.length).toBe(1)
    expect(audits[0].old_value).toBe('Old')
    expect(audits[0].new_value).toBe('New')
  })

  test('description update writes digest audit with code points', () => {
    const id = json(handleCreateTask(svc, { title: 'D', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', description: 'new desc' })
    expect(res.isError).toBeUndefined()
    expect(json(res).changed).toEqual(['description'])
    expect(row(id).description).toBe('new desc')
    const audits = auditRows(id).filter(a => a.action === 'update_task:description')
    expect(audits.length).toBe(1)
    expect(audits[0].old_value).toMatch(/^sha256:[0-9a-f]{16}:\d+$/)
    expect(audits[0].new_value).toMatch(/^sha256:[0-9a-f]{16}:\d+$/)
    expect(audits[0].new_value).toBe(`sha256:${audits[0].new_value!.split(':')[1]}:${codePointLength('new desc')}`)
  })

  test('priority update normalizes and audits', () => {
    const id = json(handleCreateTask(svc, { title: 'P', reporter: 'dev', priority: 'p2' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', priority: 0 })
    expect(res.isError).toBeUndefined()
    expect(json(res).changed).toEqual(['priority'])
    expect(row(id).priority).toBe('p0')
    const audits = auditRows(id).filter(a => a.action === 'update_task:priority')
    expect(audits.length).toBe(1)
    expect(audits[0].old_value).toBe('p2')
    expect(audits[0].new_value).toBe('p0')
  })

  test('depends_on replaces list, audits JSON', () => {
    const dep = createTaskRow({ title: 'Dep' })
    const id = json(handleCreateTask(svc, { title: 'Main', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', depends_on: [dep] })
    expect(res.isError).toBeUndefined()
    expect(json(res).changed).toEqual(['depends_on'])
    expect(JSON.parse(row(id).depends_on)).toEqual([dep])
    const audits = auditRows(id).filter(a => a.action === 'update_task:depends_on')
    expect(audits.length).toBe(1)
    expect(audits[0].old_value).toBe('[]')
    expect(audits[0].new_value).toBe(JSON.stringify([dep]))
  })

  test('multi-field update changed in stable order', () => {
    const id = json(handleCreateTask(svc, { title: 'M', reporter: 'dev', priority: 'p2' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', depends_on: [999], title: 'M2', priority: 'p1' })
    expect(res.isError).toBeUndefined()
    expect(json(res).changed).toEqual(['title', 'priority', 'depends_on'])
  })

  test('optional version omitted still succeeds', () => {
    const id = json(handleCreateTask(svc, { title: 'V', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'V2' })
    expect(res.isError).toBeUndefined()
    expect(json(res).version).toBe(2)
  })

  test('optional comment inserted as comment row', () => {
    const id = json(handleCreateTask(svc, { title: 'C', reporter: 'dev' })).id as number
    handleUpdateTask(svc, { id, agent: 'dev', title: 'C2', comment: 'rationale' })
    const comments = repo.commentsOf(id)
    expect(comments.length).toBe(1)
    expect(comments[0].type).toBe('comment')
    expect(comments[0].content).toBe('rationale')
  })

  test('epic (open) is editable', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    expect(row(epicId).status).toBe('open')
    const res = handleUpdateTask(svc, { id: epicId, agent: 'dev', title: 'Epic2' })
    expect(res.isError).toBeUndefined()
    expect(row(epicId).title).toBe('Epic2')
  })
})

describe('update_task: idempotency / no-op', () => {
  test('equal values produce changed [] and no version bump / no audit', () => {
    const id = json(handleCreateTask(svc, { title: 'Same', reporter: 'dev', priority: 'p2' })).id as number
    const beforeVersion = row(id).version
    const beforeAudit = countAudit(id, 'update_task:title')
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'Same', priority: 'p2' })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, version: beforeVersion, changed: [] })
    expect(row(id).version).toBe(beforeVersion)
    expect(countAudit(id, 'update_task:title')).toBe(beforeAudit)
  })

  test('nothing to update refused', () => {
    const id = json(handleCreateTask(svc, { title: 'N', reporter: 'dev' })).id as number
    const before = storeCounts()
    const res = handleUpdateTask(svc, { id, agent: 'dev' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: nothing to update')
    expect(storeCounts()).toEqual(before)
    expect(row(id).version).toBe(1)
  })
})

describe('update_task: eligibility window', () => {
  test('refused on in_progress / review / blocked / terminal', () => {
    for (const status of ['in_progress', 'review', 'blocked'] as const) {
      const id = json(handleCreateTask(svc, { title: `S-${status}`, reporter: 'dev' })).id as number
      if (status === 'in_progress') {
        handleClaimTask(svc, { agent: 'dev', task_id: id })
      } else if (status === 'review') {
        handleClaimTask(svc, { agent: 'dev', task_id: id })
        handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: versionOf(id) })
      } else {
        handleClaimTask(svc, { agent: 'dev', task_id: id })
        handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: versionOf(id) })
      }
      const before = storeCounts()
      const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'X' })
      expect(res.isError).toBe(true)
      expect(text(res)).toContain(`cannot edit #${id} in status=${status}`)
      expect(storeCounts()).toEqual(before)
    }
  })

  test('refused on done / failed / canceled', () => {
    for (const terminal of ['done', 'failed', 'canceled'] as const) {
      const id = json(handleCreateTask(svc, { title: `T-${terminal}`, reporter: 'dev' })).id as number
      if (terminal === 'done') {
        handleClaimTask(svc, { agent: 'dev', task_id: id })
        handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: versionOf(id) })
        handleUpdateStatus(svc, { id, agent: 'dev', status: 'done', version: versionOf(id) })
      } else if (terminal === 'failed') {
        handleClaimTask(svc, { agent: 'dev', task_id: id })
        handleUpdateStatus(svc, { id, agent: 'dev', status: 'failed', version: versionOf(id) })
      } else {
        handleUpdateStatus(svc, { id, agent: 'dev', status: 'canceled', version: versionOf(id) })
      }
      const before = storeCounts()
      const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'X' })
      expect(res.isError).toBe(true)
      expect(text(res)).toContain(`cannot edit #${id} in status=${terminal}`)
      expect(storeCounts()).toEqual(before)
    }
  })

  test('refused when task holds a lease (queued with assignee/lease)', () => {
    const id = json(handleCreateTask(svc, { title: 'Leased', reporter: 'dev' })).id as number
    db.run('UPDATE tasks SET assignee = ?, lease_expires_at = ? WHERE id = ?', ['dev', new Date(Date.now() + 60000).toISOString(), id])
    const before = storeCounts()
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'X' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`INVALID: task #${id} holds a lease and is not editable`)
    expect(storeCounts()).toEqual(before)
  })

  test('NOT_FOUND for unknown id', () => {
    const res = handleUpdateTask(svc, { id: 99999, agent: 'dev', title: 'X' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('NOT_FOUND')
  })
})

describe('update_task: version lock', () => {
  test('stale version refused', () => {
    const id = json(handleCreateTask(svc, { title: 'VL', reporter: 'dev' })).id as number
    const before = storeCounts()
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'X', version: 999 })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`CONFLICT: expected version 1, got 999`)
    expect(storeCounts()).toEqual(before)
    expect(row(id).title).toBe('VL')
  })

  test('concurrency race: CAS failure returns concurrent modification', () => {
    const id = json(handleCreateTask(svc, { title: 'Race', reporter: 'dev' })).id as number
    const orig = repo.updateTaskFields.bind(repo)
    repo.updateTaskFields = () => 0
    try {
      const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'Changed' })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe('CONFLICT: concurrent modification')
    } finally {
      repo.updateTaskFields = orig
    }
    expect(row(id).title).toBe('Race')
  })

  test('concurrency race: task changed state during update', () => {
    const id = json(handleCreateTask(svc, { title: 'Race2', reporter: 'dev' })).id as number
    const origUpdate = repo.updateTaskFields.bind(repo)
    const origGet = repo.getTaskRow.bind(repo)
    let getCalls = 0
    repo.updateTaskFields = () => 0
    repo.getTaskRow = ((x: number) => {
      getCalls++
      if (getCalls === 1) return origGet(x)
      return { ...origGet(x), status: 'review' }
    }) as any
    try {
      const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'Changed' })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(`CONFLICT: task #${id} changed state during the update`)
    } finally {
      repo.updateTaskFields = origUpdate
      repo.getTaskRow = origGet
    }
  })
})

describe('update_task: validation', () => {
  test('agent required / too long', () => {
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    let res = handleUpdateTask(svc, { id, agent: '', title: 'X' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: agent required')
    const long = 'a'.repeat(201)
    res = handleUpdateTask(svc, { id, agent: long, title: 'X' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: agent too long')
  })

  test('title required / too long', () => {
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    let res = handleUpdateTask(svc, { id, agent: 'dev', title: '' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: title required')
    const long = 'a'.repeat(201)
    res = handleUpdateTask(svc, { id, agent: 'dev', title: long })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: title too long')
  })

  test('description required (not null) / too long', () => {
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', description: null as any })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: description required')
  })

  test('priority invalid refused', () => {
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', priority: 'bogus' as any })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: priority must be one of')
  })

  test('comment too long refused', () => {
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const long = 'a'.repeat(20001)
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'X', comment: long })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: comment too long')
  })

  test('depends_on too long / not array refused', () => {
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1)
    let res = handleUpdateTask(svc, { id, agent: 'dev', depends_on: tooMany })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: depends_on too long')
    res = handleUpdateTask(svc, { id, agent: 'dev', depends_on: 'x' as any })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: depends_on too long')
  })

  test('epic cannot have depends_on', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const res = handleUpdateTask(svc, { id: epicId, agent: 'dev', depends_on: [] })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: an epic cannot have depends_on')
  })

  test('depends_on epic dep refused', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', depends_on: [epicId] })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('dependencies on epic tasks not allowed')
  })

  test('depends_on project mismatch refused', () => {
    // create a second project and a task there
    db.run("INSERT INTO projects (slug, folder_path, created_at, updated_at) VALUES ('other', '', ?, ?)", [new Date().toISOString(), new Date().toISOString()])
    // insert task in other project directly
    const otherProjectId = (db.query("SELECT id FROM projects WHERE slug='other'").get() as any).id
    const otherTaskId = repo.insertTask({ title: 'Other', description: null, priority: 'p2', assignee: null, reporter: 'dev', depends_on: '[]', now: new Date().toISOString(), projectId: otherProjectId }).id
    const id = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', depends_on: [otherTaskId] })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain("belongs to project 'other'")
  })

  test('depends_on cycle refused and no write', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id as number
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [a] })).id as number
    // make a depend on b -> cycle
    const beforeVersion = row(a).version
    const beforeDeps = row(a).depends_on
    const res = handleUpdateTask(svc, { id: a, agent: 'dev', depends_on: [b] })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('CYCLE: dependency graph contains a cycle')
    expect(row(a).version).toBe(beforeVersion)
    expect(row(a).depends_on).toBe(beforeDeps)
  })
})

describe('update_task: refused writes leave no changes', () => {
  test('validation refusal does not bump version or audit', () => {
    const id = json(handleCreateTask(svc, { title: 'R', reporter: 'dev' })).id as number
    const before = storeCounts()
    const beforeVersion = row(id).version
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: '', depends_on: [999] })
    expect(res.isError).toBe(true)
    expect(storeCounts()).toEqual(before)
    expect(row(id).version).toBe(beforeVersion)
  })
})

describe('update_task: unknown args', () => {
  test('rejects unknown key', () => {
    const id = json(handleCreateTask(svc, { title: 'U', reporter: 'dev' })).id as number
    const res = handleUpdateTask(svc, { id, agent: 'dev', title: 'X', bogus: 1 } as any)
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: unknown argument bogus on update_task')
  })
})

describe('update_task: store-level SQL window predicate', () => {
  test('leased row rejects updateTaskFields (0 changes, unchanged version/title)', () => {
    const id = createTaskRow({ title: 'Leased' })
    db.run('UPDATE tasks SET assignee = ?, lease_expires_at = ? WHERE id = ?',
      ['dev', new Date(Date.now() + 60000).toISOString(), id])
    const before = row(id)
    const changes = repo.updateTaskFields(id, before.version, { title: 'Changed' }, nowIso())
    expect(changes).toBe(0)
    const after = row(id)
    expect(after.title).toBe('Leased')
    expect(after.version).toBe(before.version)
  })

  test('empty patch refuses without bumping version', () => {
    const id = createTaskRow({ title: 'Empty' })
    const before = row(id)
    const changes = repo.updateTaskFields(id, before.version, {}, nowIso())
    expect(changes).toBe(0)
    const after = row(id)
    expect(after.version).toBe(before.version)
  })
})
