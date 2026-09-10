import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { checkCycles, depsSatisfied, parseDeps } from './core/service'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus, handleListQueue
} from './mcp/tools'
import {
  createTestDb, closeTestDb, insertTaskRow, json, text, driveToDone,
  type CreateTaskRowOpts
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })
const createTaskRow = (opts: CreateTaskRowOpts) => insertTaskRow(repo, opts)

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

describe('epic-dep rejection message (#106)', () => {
  test('error message includes the offending epic id in #N format', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const res = handleCreateTask(svc, { title: 'Bad', reporter: 'dev', depends_on: [epicId] })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain(`#${epicId}`)
    expect(text(res)).toContain('dependencies on epic')
  })

  test('error message is stable across multiple epic deps', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const res = handleCreateTask(svc, { title: 'Bad', reporter: 'dev', depends_on: [epicId, 999] })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain(`#${epicId}`)
    // Unknown dep 999 is ignored (no row → not an epic)
  })
})

describe('corrupt depends_on tolerance (#107)', () => {
  test('parseDeps returns [] for various corrupt inputs', () => {
    expect(parseDeps('not json')).toEqual([])
    expect(parseDeps('{invalid}')).toEqual([])
    expect(parseDeps('')).toEqual([])
    expect(parseDeps('null')).toEqual([])
    expect(parseDeps('42')).toEqual([])
    expect(parseDeps('"string"')).toEqual([])
  })

  test('parseDeps preserves valid behavior', () => {
    expect(parseDeps('[]')).toEqual([])
    expect(parseDeps('[1, 2, 3]')).toEqual([1, 2, 3])
    expect(parseDeps('[1, "two", 3]')).toEqual([1, 3])
  })

  test('getTaskView survives corrupt depends_on', () => {
    const id = createTaskRow({ title: 'Corrupt', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", ['{bad json}', id])
    const res = handleGetTask(svc, { id })
    expect(json(res).id).toBe(id)
    expect(json(res).status).toBe('queued')
    expect(json(res).blocked_by).toEqual([])
  })

  test('blocked_by lists dangling deps, matching readiness (never runs but not listed = footgun)', () => {
    const depId = json(handleCreateTask(svc, { title: 'Dep', reporter: 'dev' })).id
    const id = json(handleCreateTask(svc, { title: 'Dependent', reporter: 'dev', depends_on: [depId, 999] })).id

    expect(json(handleGetTask(svc, { id })).blocked_by).toEqual([depId, 999])

    driveToDone(svc, depId, 'dev')
    expect(json(handleGetTask(svc, { id })).blocked_by).toEqual([999])
    expect(text(handleListQueue(svc, {}))).not.toContain(`${id}|`)
  })

  test('claimTask auto-claim survives corrupt depends_on (treated as no deps)', () => {
    const corruptId = createTaskRow({ title: 'Corrupt', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", ['{bad json}', corruptId])
    const res = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res).id).toBe(corruptId)
  })

  test('listQueue survives corrupt depends_on', () => {
    const corruptId = createTaskRow({ title: 'Corrupt', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", ['{bad json}', corruptId])
    const out = text(handleListQueue(svc, {}))
    expect(out).toContain(`${corruptId}|`)
  })

  test('checkCycles survives corrupt depends_on in graph traversal', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", ['{bad json}', id2])
    expect(() => checkCycles((id) => repo.depsOf(id), id1, [id2])).not.toThrow()
  })

  test('depsSatisfied survives corrupt depends_on input', () => {
    // parseDeps is the gateway; if it returns [], depsSatisfied gets []
    expect(depsSatisfied((id) => repo.statusOf(id), [])).toBe(true)
  })
})
