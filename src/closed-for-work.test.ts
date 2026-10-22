import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { isValidTransition, nowIso, TASK_STATUSES } from './core/tasks'
import { blockingDeps, depsSatisfied } from './core/deps'
import { epicTargetRefusal } from './core/guards'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus, handleListQueue
} from './mcp/task-tools'
import { handleListProjects } from './mcp/project-tools'
import {
  createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text, seedProject
} from './test-context'

// The closed-for-work contract (#1896). A failed task is closed for work: it carries a
// completed_at, holds no lease holder, and never blocks a dependent, a parent epic or an open
// count. `failed -> canceled` is the one administrative way out of it — the failure stands, the
// task is only closed out — and it never reopens the task. Every case below runs against the
// production seams (the service verbs, the repo, the guards, the deps rule), never a double.

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' }) })
afterEach(() => { closeTestDb(db) })

const createTaskRow = (title: string) => insertTaskRow(repo, { title, reporter: 'dev' })
const row = (id: number) => getTaskRow(db, id)
const versionOf = (id: number): number => json(handleGetTask(svc, { id, fields: ['version'] })).version
const auditRows = (id: number) =>
  db.query('SELECT action, old_value, new_value FROM audit_log WHERE task_id = ? ORDER BY id')
    .all(id) as Array<{ action: string; old_value: string | null; new_value: string | null }>
const countAudit = (id: number, action: string): number =>
  (db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = ?').get(id, action) as { n: number }).n

// The failure, driven through the production verbs: a claim and the in_progress -> failed edge.
// The version of the failed row is returned, so the caller writes against the state it observes.
const failTask = (id: number, agent = 'developer'): number => {
  handleClaimTask(svc, { agent, task_id: id })
  handleUpdateStatus(svc, { id, agent, status: 'failed', version: versionOf(id) })
  expect(row(id).status).toBe('failed')
  return versionOf(id)
}

// One #1013 round: a claim that is never finished costs exactly one attempt on the next sweep.
const burnAttempt = (id: number, agent = 'developer'): void => {
  handleClaimTask(svc, { agent, task_id: id })
  db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [new Date(Date.now() - 3600_000).toISOString(), id])
  svc.lifecycle.reapExpiredLeases()
}

describe('failed -> canceled: the administrative withdrawal (#1896)', () => {
  test('the withdrawal closes the task out: canceled, no holder, completed_at stamped', () => {
    const id = createTaskRow('Withdrawn')
    const failedVersion = failTask(id)
    expect(row(id).status).toBe('failed')

    const res = handleUpdateStatus(svc, { id, agent: 'operator', status: 'canceled', version: failedVersion })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('canceled')

    const after = row(id)
    expect(after.status).toBe('canceled')
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
    expect(after.completed_at).not.toBeNull()
  })

  test('the withdrawal is recorded as an audited transition and a resolution comment', () => {
    const id = createTaskRow('Recorded')
    const failedVersion = failTask(id)
    handleUpdateStatus(svc, {
      id, agent: 'operator', status: 'canceled', version: failedVersion,
      comment: 'withdrawn: the failure stands, the task is only closed out'
    })

    const transitions = auditRows(id).filter(r => r.action === 'update_status')
    expect(transitions.length).toBe(2)
    expect(transitions[0].old_value).toBe('in_progress')
    expect(transitions[0].new_value).toBe('failed')
    expect(transitions[1].old_value).toBe('failed')
    expect(transitions[1].new_value).toBe('canceled')

    // a terminal transition takes a typed resolution, not a plain comment
    const comments = repo.commentsOf(id)
    expect(comments.length).toBe(1)
    expect(comments[0].type).toBe('resolution')
    expect(comments[0].content).toBe('withdrawn: the failure stands, the task is only closed out')
  })

  test('failed -> done is refused: the withdrawal is the only way out', () => {
    const id = createTaskRow('NoDone')
    const failedVersion = failTask(id)

    const res = handleUpdateStatus(svc, { id, agent: 'operator', status: 'done', version: failedVersion })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: failed → done')

    // a refusal is not a write: the row, its version and the audit log all hold
    const after = row(id)
    expect(after.status).toBe('failed')
    expect(after.version).toBe(failedVersion)
    expect(countAudit(id, 'update_status')).toBe(1)
  })

  test('a failed task is never reopened', () => {
    for (const status of ['queued', 'in_progress', 'review'] as const) {
      const id = createTaskRow(`Reopen ${status}`)
      const failedVersion = failTask(id)

      const res = handleUpdateStatus(svc, { id, agent: 'operator', status, version: failedVersion })
      expect(`${status}: ${text(res)}`).toBe(`${status}: INVALID: failed → ${status}`)
      expect(`${status}: ${row(id).status}`).toBe(`${status}: failed`)
    }
  })

  test('canceled is terminal: it has no outgoing edge and the tool refuses every target', () => {
    for (const to of TASK_STATUSES) {
      expect(isValidTransition('canceled', to)).toBe(false)
    }

    const id = createTaskRow('Closed')
    handleUpdateStatus(svc, { id, agent: 'operator', status: 'canceled', version: 1 })
    const res = handleUpdateStatus(svc, { id, agent: 'operator', status: 'failed', version: 2 })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('INVALID: canceled → failed')
    expect(row(id).status).toBe('canceled')
  })

  test('a failed epic can be withdrawn to canceled as well', () => {
    // The same administrative edge on an epic: the failure stands, the epic is only closed out.
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    handleUpdateStatus(svc, { id: epicId, agent: 'operator', status: 'failed', version: 1 })

    const res = handleUpdateStatus(svc, { id: epicId, agent: 'operator', status: 'canceled', version: 2 })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('canceled')

    const after = row(epicId)
    expect(after.status).toBe('canceled')
    expect(after.completed_at).not.toBeNull()
  })

  test('reset_attempts cannot ride on the withdrawal', () => {
    // A failed task with a spent budget: the refund would be visible if it slipped through.
    const id = createTaskRow('Refunded')
    for (let round = 0; round < 4; round++) burnAttempt(id)
    const before = row(id)
    expect(before.status).toBe('failed')
    expect(before.attempts).toBe(4)

    const res = handleUpdateStatus(svc, {
      id, agent: 'operator', status: 'canceled', version: before.version,
      reset_attempts: true, comment: 'the budget went on accidents'
    })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`INVALID: cannot reset attempts on terminal task #${id}`)

    const after = row(id)
    expect(after.status).toBe('failed')
    expect(after.attempts).toBe(4)
    expect(after.version).toBe(before.version)
    expect(countAudit(id, 'attempts_reset')).toBe(0)
    expect(countAudit(id, 'update_status')).toBe(0)
  })
})

describe('closed for work: the invariants a failed task keeps', () => {
  test('completed_at is stamped when a task goes to failed (the service write path)', () => {
    const id = createTaskRow('Stamped')
    failTask(id)

    const after = row(id)
    expect(after.status).toBe('failed')
    expect(after.completed_at).not.toBeNull()
  })

  test('the reap write path stamps completed_at and drops the holder when it fails a task', () => {
    // src/db/repo.ts reapTransition — the write that fails a task whose lease expired for good,
    // as opposed to the service transition above.
    const id = createTaskRow('Reaped')
    handleClaimTask(svc, { agent: 'developer', task_id: id })
    const leased = row(id)
    expect(leased.status).toBe('in_progress')
    expect(leased.assignee).toBe('developer')

    const changes = repo.reapTransition(id, leased.version, 'failed', 4, nowIso())
    expect(changes).toBe(1)

    const after = row(id)
    expect(after.status).toBe('failed')
    expect(after.completed_at).not.toBeNull()
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
  })

  test('a failed task holds no lease holder and no lease deadline', () => {
    const id = createTaskRow('Released')
    handleClaimTask(svc, { agent: 'developer', task_id: id })
    expect(row(id).assignee).toBe('developer')

    handleUpdateStatus(svc, { id, agent: 'developer', status: 'failed', version: versionOf(id) })

    const after = row(id)
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
  })

  test('a failed dependency does not block its dependents', () => {
    const dep = createTaskRow('Dep')
    const dependent = insertTaskRow(repo, { title: 'Dependent', reporter: 'dev', depends_on: [dep] })
    failTask(dep)

    // the rule itself (src/core/deps.ts)
    expect(blockingDeps(repo.statusesOf([dep]), [dep])).toEqual([])
    expect(depsSatisfied(repo.statusesOf([dep]), [dep])).toBe(true)

    // and what the caller sees
    expect(json(handleGetTask(svc, { id: dependent })).blocked_by).toEqual([])
    expect(text(handleListQueue(svc, {}))).toContain(`${dependent}|`)
    expect(json(handleClaimTask(svc, { agent: 'developer', task_id: dependent })).id).toBe(dependent)
  })

  test('a failed child does not keep its epic open', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id as number
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id as number
    failTask(subId)

    // the counter behind the CHILDREN guard (src/db/repo.ts nonTerminalChildCount)
    expect(repo.nonTerminalChildCount(epicId)).toBe(0)

    const epic = row(epicId)
    expect(epic.status).toBe('open')
    const res = handleUpdateStatus(svc, { id: epicId, agent: 'operator', status: 'done', version: epic.version })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('done')
  })

  test('a failed task is excluded from the project open count', () => {
    seedProject(db, 'alpha')
    const id = json(handleCreateTask(svc, { title: 'Alpha task', reporter: 'dev', project: 'alpha' })).id as number
    failTask(id)

    // the counter (src/db/repo.ts listProjects.open)
    const alpha = repo.listProjects().find(p => p.slug === 'alpha')
    expect(alpha?.open).toBe(0)
    // and the pipe the reader sees
    const line = text(handleListProjects(svc, {})).split('\n').find(l => l.startsWith('alpha|'))
    expect(line).toBe('alpha||0')
  })

  test('a failed child is excluded from the epic open count', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id as number
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id as number
    failTask(subId)

    // the roll-up (src/db/repo.ts childStatusCounts.open)
    const counts = repo.childStatusCounts(epicId)
    expect(counts.total).toBe(1)
    expect(counts.open).toBe(0)
    expect(counts.failed).toBe(1)
  })

  test('a failed task cannot be promoted to an epic', () => {
    const id = createTaskRow('Doomed')
    failTask(id)

    // the guard (src/core/guards.ts epicTargetRefusal)
    expect(epicTargetRefusal(repo.getTaskRow(id), 'test')).toEqual({ kind: 'terminal' })

    // and the wire refusal: the target stays a plain task
    const res = handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: id })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('cannot attach to a terminal task')
    expect(row(id).is_epic).toBe(false)
  })
})
