import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { nowIso } from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus,
  handleListQueue, handleListTasks
} from './mcp/tools'
import {
  createTestDb, closeTestDb, getTaskRow, json, text, driveToDone
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })

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

describe('atomic epic promotion (#108)', () => {
  test('promoteEpicWithMirror exists on TaskStore', () => {
    expect(typeof (svc as any).store.promoteEpicWithMirror).toBe('function')
  })

  test('subtask attach atomically promotes epic and adds mirror', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id

    const epic = getTaskRow(db, epicId)
    expect(epic.is_epic).toBe(1)

    const mirrors = db.query(
      "SELECT action, new_value FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
    expect(mirrors[0].new_value).toContain(`#${subId}`)
    expect(mirrors[0].new_value).toContain('Sub')
  })

  test('standalone appendEpicAuditMirror still exists', () => {
    expect(typeof (svc as any).store.appendEpicAuditMirror).toBe('function')
  })

  test('direct promoteEpicWithMirror call is atomic (both or neither)', () => {
    const epicId = json(handleCreateTask(svc, { title: 'DirectEpic', reporter: 'dev' })).id
    ;(svc as any).store.promoteEpicWithMirror(
      epicId, 'dev', 'subtask_add', '#99 Some Sub', nowIso(), true
    )
    const epic = getTaskRow(db, epicId)
    expect(epic.is_epic).toBe(1)
    const mirrors = db.query(
      "SELECT action FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
  })
})
