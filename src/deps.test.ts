import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { collapseDeps, createsCycle, depsSatisfied, parseDeps } from './core/deps'
import { MAX_DEPENDS_ON } from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask,
  handleGetTask,
  handleClaimTask,
  handleUpdateStatus,
  handleListQueue
} from './mcp/task-tools'
import {
  createTestDb,
  closeTestDb,
  getTaskRow,
  insertTaskRow,
  json,
  text,
  driveToDone,
  testProjectId,
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

describe('createsCycle', () => {
  test('self-dependency rejected', () => {
    const id = createTaskRow({ title: 'Self', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id]), id])
    expect(createsCycle((id) => repo.depsOf(id), id, [id])).toBe(true)
  })

  test('simple 2-node cycle rejected', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id2]), id1])
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id1]), id2])
    expect(createsCycle((id) => repo.depsOf(id), id1, [id2])).toBe(true)
  })

  test('3+ node cycle rejected', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    const id3 = createTaskRow({ title: 'C', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id2]), id1])
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id3]), id2])
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id1]), id3])
    expect(createsCycle((id) => repo.depsOf(id), id1, [id3])).toBe(true)
  })

  test('valid DAG accepted (diamond)', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    const id3 = createTaskRow({ title: 'C', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id1, id2]), id3])
    expect(createsCycle((id) => repo.depsOf(id), id3, [id1, id2])).toBe(false)
  })

  test('cycle attempt via multiple parents rejected', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    const id3 = createTaskRow({ title: 'C', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id2]), id1])
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id3]), id2])
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', [JSON.stringify([id1, id2]), id3])
    expect(createsCycle((id) => repo.depsOf(id), id1, [id2, id3])).toBe(true)
  })
})

describe('deps', () => {
  test('deps satisfied when all done', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    handleUpdateStatus(svc, { id: id1, agent: 'dev', status: 'in_progress', version: 1 })
    handleUpdateStatus(svc, { id: id1, agent: 'dev', status: 'review', version: 2 })
    handleUpdateStatus(svc, { id: id1, agent: 'dev', status: 'done', version: 3 })
    expect(depsSatisfied(repo.statusesOf([id1]), [id1])).toBe(true)
  })

  test('deps not satisfied when pending', () => {
    const id = createTaskRow({ title: 'Pending', reporter: 'dev' })
    expect(depsSatisfied(repo.statusesOf([id]), [id])).toBe(false)
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
    // One transaction: the seeding is 102 inserts, and one WAL commit per row is what made this
    // the slowest fixture in the suite. The claim itself stays outside the transaction.
    let freeId = 0
    repo.transaction(() => {
      for (let i = 0; i < 101; i++) {
        createTaskRow({ title: `Blocked ${i}`, reporter: 'dev', depends_on: [999] })
      }
      freeId = createTaskRow({ title: 'FreeBeyondBatch', reporter: 'dev' })
    })
    const res = handleClaimTask(svc, { agent: 'agent-2' })
    expect(json(res).id).toBe(freeId)
  })

  test('list_queue pipe hides dep-pending task even though queued (v2)', () => {
    const a = json(handleCreateTask(svc, { title: 'A', reporter: 'dev' })).id
    const b = json(handleCreateTask(svc, { title: 'B', reporter: 'dev', depends_on: [a] })).id
    const queue = text(handleListQueue(svc, {}))
    expect(queue).toBe(`${a}|p2|A`)
    const ids = queue.split('\n').map((line) => Number(line.split('|')[0]))
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
    // The first offending id in input order wins: the epic is reported ahead of the unknown 999.
  })
})

describe('dependency validation (#2244)', () => {
  const storeCounts = (): { tasks: number; audit: number; comments: number } => {
    const count = (table: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return { tasks: count('tasks'), audit: count('audit_log'), comments: count('comments') }
  }
  // A boundary list needs real rows: an unknown id is refused on its own, so a length test seeded
  // with fabricated ids would pass for the wrong reason.
  const seedDeps = (count: number): number[] =>
    repo.transaction(() =>
      Array.from({ length: count }, (_, i) => createTaskRow({ title: `Dep ${i}`, reporter: 'dev' }))
    )

  test('create_task refuses an unknown dependency id and writes nothing', () => {
    const dep = createTaskRow({ title: 'Known', reporter: 'dev' })
    const before = storeCounts()
    const res = handleCreateTask(svc, { title: 'Bad', reporter: 'dev', depends_on: [dep, 998] })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: dependency #998 not found')
    expect(storeCounts()).toEqual(before)
  })

  test('create_task names the first missing id in input order', () => {
    const res = handleCreateTask(svc, { title: 'Bad', reporter: 'dev', depends_on: [997, 996] })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: dependency #997 not found')
  })

  test('create_task stores a repeated id once and lists it once in blocked_by', () => {
    const dep = createTaskRow({ title: 'Dep', reporter: 'dev' })
    const id = json(
      handleCreateTask(svc, { title: 'Dup', reporter: 'dev', depends_on: [dep, dep, dep] })
    ).id
    expect(JSON.parse(getTaskRow(db, id).depends_on)).toEqual([dep])
    expect(json(handleGetTask(svc, { id })).blocked_by).toEqual([dep])
  })

  test('create_task counts duplicates once against the limit: 101 entries of 100 ids are accepted', () => {
    const deps = seedDeps(MAX_DEPENDS_ON)
    const id = json(
      handleCreateTask(svc, { title: 'Boundary', reporter: 'dev', depends_on: [...deps, deps[0]] })
    ).id
    expect(JSON.parse(getTaskRow(db, id).depends_on)).toEqual(deps)
  })

  test('create_task refuses 101 distinct existing ids and writes nothing', () => {
    const deps = seedDeps(MAX_DEPENDS_ON + 1)
    const before = storeCounts()
    const res = handleCreateTask(svc, { title: 'TooMany', reporter: 'dev', depends_on: deps })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: depends_on too long')
    expect(storeCounts()).toEqual(before)
  })

  test('createTask refuses a non-array depends_on on the direct service path', () => {
    const before = storeCounts()
    const res = svc.createTask({ title: 'Bad', reporter: 'dev', depends_on: 'x' as any })
    if (res.ok) throw new Error('a non-array depends_on was accepted')
    expect(res.error).toEqual({ code: 'INVALID', message: 'invalid depends_on' })
    expect(storeCounts()).toEqual(before)
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
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', ['{bad json}', id])
    const res = handleGetTask(svc, { id })
    expect(json(res).id).toBe(id)
    expect(json(res).status).toBe('queued')
    expect(json(res).blocked_by).toEqual([])
  })

  test('blocked_by lists dangling deps, matching readiness (never runs but not listed = footgun)', () => {
    const depId = json(handleCreateTask(svc, { title: 'Dep', reporter: 'dev' })).id
    // A dangling id can no longer be written through the service, so the row is seeded.
    const id = createTaskRow({ title: 'Dependent', reporter: 'dev', depends_on: [depId, 999] })

    expect(json(handleGetTask(svc, { id })).blocked_by).toEqual([depId, 999])

    driveToDone(svc, depId, 'dev')
    expect(json(handleGetTask(svc, { id })).blocked_by).toEqual([999])
    expect(text(handleListQueue(svc, {}))).not.toContain(`${id}|`)
  })

  test('claimTask auto-claim survives corrupt depends_on (treated as no deps)', () => {
    const corruptId = createTaskRow({ title: 'Corrupt', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', ['{bad json}', corruptId])
    const res = handleClaimTask(svc, { agent: 'agent-1' })
    expect(json(res).id).toBe(corruptId)
  })

  test('listQueue survives corrupt depends_on', () => {
    const corruptId = createTaskRow({ title: 'Corrupt', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', ['{bad json}', corruptId])
    const out = text(handleListQueue(svc, {}))
    expect(out).toContain(`${corruptId}|`)
  })

  test('createsCycle survives corrupt depends_on in graph traversal', () => {
    const id1 = createTaskRow({ title: 'A', reporter: 'dev' })
    const id2 = createTaskRow({ title: 'B', reporter: 'dev' })
    db.run('UPDATE tasks SET depends_on = ? WHERE id = ?', ['{bad json}', id2])
    expect(() => createsCycle((id) => repo.depsOf(id), id1, [id2])).not.toThrow()
  })

  test('depsSatisfied survives corrupt depends_on input', () => {
    // parseDeps is the gateway; if it returns [], depsSatisfied gets []
    expect(depsSatisfied(repo.statusesOf([]), [])).toBe(true)
  })
})

describe('queuedCandidates id tie-break (#431)', () => {
  test('same priority + same created_at orders by ascending id', () => {
    // Insert tasks with explicit same created_at to test tie-break
    const baseTime = '2020-01-01T00:00:00.000Z'
    const idA = repo.insertTask({
      title: 'A',
      description: null,
      priority: 'p2',
      reporter: 'dev',
      depends_on: '[]',
      now: baseTime,
      projectId: testProjectId(repo)
    }).id
    const idB = repo.insertTask({
      title: 'B',
      description: null,
      priority: 'p2',
      reporter: 'dev',
      depends_on: '[]',
      now: baseTime,
      projectId: testProjectId(repo)
    }).id
    const idC = repo.insertTask({
      title: 'C',
      description: null,
      priority: 'p2',
      reporter: 'dev',
      depends_on: '[]',
      now: baseTime,
      projectId: testProjectId(repo)
    }).id
    // Set same created_at
    db.run('UPDATE tasks SET created_at = ? WHERE id IN (?, ?, ?)', [baseTime, idA, idB, idC])

    const candidates = repo.queuedCandidates(10, testProjectId(repo))
    // Should order by id ASC when priority and created_at are equal
    expect(candidates.map((t: any) => t.id)).toEqual([idA, idB, idC])
  })

  test('priority still takes precedence over id tie-break', () => {
    const p0id = repo.insertTask({
      title: 'P0',
      description: null,
      priority: 'p0',
      reporter: 'dev',
      depends_on: '[]',
      now: '2020-01-01T00:00:00.000Z',
      projectId: testProjectId(repo)
    }).id
    const p2id = repo.insertTask({
      title: 'P2',
      description: null,
      priority: 'p2',
      reporter: 'dev',
      depends_on: '[]',
      now: '2020-01-01T00:00:00.000Z',
      projectId: testProjectId(repo)
    }).id
    db.run("UPDATE tasks SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [
      p0id,
      p2id
    ])

    const candidates = repo.queuedCandidates(10, testProjectId(repo))
    expect(candidates[0].id).toBe(p0id)
    expect(candidates[1].id).toBe(p2id)
  })
})

describe('listQueue dep-aware priority ordering (#767)', () => {
  test('lower-priority ready task listed before higher-priority dep-blocked task', () => {
    // Create a high-priority task that is dep-blocked
    const blockedP0 = createTaskRow({
      title: 'BlockedP0',
      reporter: 'dev',
      priority: 'p0',
      depends_on: [999]
    })
    // Create a low-priority task that is ready
    const readyP2 = createTaskRow({ title: 'ReadyP2', reporter: 'dev', priority: 'p2' })
    // Queue should show readyP2 first since blockedP0 is dep-blocked
    const out = text(handleListQueue(svc, {}))
    const lines = out.split('\n').filter((l) => l.trim())
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain(`${readyP2}|`)
    expect(lines[0]).not.toContain(`${blockedP0}|`)
  })

  test('listQueue matches auto-claim readiness: both skip dep-blocked tasks', () => {
    const blockedP0 = createTaskRow({
      title: 'BlockedP0',
      reporter: 'dev',
      priority: 'p0',
      depends_on: [999]
    })
    const readyP2 = createTaskRow({ title: 'ReadyP2', reporter: 'dev', priority: 'p2' })
    const readyP1 = createTaskRow({ title: 'ReadyP1', reporter: 'dev', priority: 'p1' })

    // listQueue should only show ready tasks
    const queue = text(handleListQueue(svc, {}))
    const queueLines = queue.split('\n').filter((l) => l.trim())
    const queueIds = queueLines.map((line) => Number(line.split('|')[0]))
    expect(queueIds).toContain(readyP1)
    expect(queueIds).toContain(readyP2)
    expect(queueIds).not.toContain(blockedP0)

    // auto-claim should pick the highest-priority ready task (P1)
    const claim = json(handleClaimTask(svc, { agent: 'agent-1' }))
    expect(claim.id).toBe(readyP1)
  })

  test('all higher-priority tasks dep-blocked: queue returns lowest-priority ready ones', () => {
    // Block two p0 and one p1 tasks
    for (let i = 0; i < 2; i++) {
      createTaskRow({ title: `BlockedP0${i}`, reporter: 'dev', priority: 'p0', depends_on: [999] })
    }
    createTaskRow({ title: 'BlockedP1', reporter: 'dev', priority: 'p1', depends_on: [999] })
    // Two ready p2 tasks
    const p2a = createTaskRow({ title: 'ReadyP2a', reporter: 'dev', priority: 'p2' })
    const p2b = createTaskRow({ title: 'ReadyP2b', reporter: 'dev', priority: 'p2' })

    const queue = text(handleListQueue(svc, {}))
    const ids = queue.split('\n').map((line) => Number(line.split('|')[0]))
    expect(ids).toEqual([p2a, p2b])
  })
})

describe('collapseDeps purity (#2257)', () => {
  test('keeps the first occurrence of every id in input order', () => {
    expect(collapseDeps([3, 1, 3, 2, 1])).toEqual([3, 1, 2])
  })

  test('leaves the caller array untouched', () => {
    const input = [2, 2, 5]
    collapseDeps(input)
    expect(input).toEqual([2, 2, 5])
  })

  test('returns a distinct array even when nothing needs collapsing', () => {
    // Pins the contract the guard relies on: it may keep the returned array as the normalised list,
    // so an aliasing fast path (`return deps`) would quietly reintroduce the caller-array rewrite.
    const input = [1, 2, 3]
    expect(collapseDeps(input)).not.toBe(input)
  })
})

describe('the service normalizes depends_on without rewriting the caller array (#2257)', () => {
  test('createTask stores the deduped list and leaves the argument array as passed', () => {
    const dep = createTaskRow({ title: 'Dep', reporter: 'dev' })
    const input = [dep, dep]
    const res = svc.createTask({ title: 'Dup', reporter: 'dev', depends_on: input })
    if (!res.ok) throw new Error(res.error.message)
    expect(JSON.parse(getTaskRow(db, res.data.id).depends_on)).toEqual([dep])
    expect(input).toEqual([dep, dep])
  })

  test('updateTask stores the deduped list and leaves the argument array as passed', () => {
    const dep = createTaskRow({ title: 'Dep', reporter: 'dev' })
    const id = createTaskRow({ title: 'Target', reporter: 'dev' })
    const input = [dep, dep]
    const res = svc.updateTask({ id, agent: 'dev', depends_on: input })
    if (!res.ok) throw new Error(res.error.message)
    expect(JSON.parse(getTaskRow(db, id).depends_on)).toEqual([dep])
    expect(input).toEqual([dep, dep])
  })
})
