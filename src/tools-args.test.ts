import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask, handleGetTask, handleListTasks, handleClaimTask, handleUpdateStatus,
  handleListQueue, handleAddComment, handleGetTimeline
} from './mcp/tools'
import { createTestDb, closeTestDb, getTaskRow, json, text } from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })

type Snapshot = { tasks: unknown[]; audit: unknown; comments: unknown; leases: unknown }

function snapshot(): Snapshot {
  return {
    tasks: db.query('SELECT id, status, version, assignee, attempts, max_attempts FROM tasks ORDER BY id').all(),
    audit: db.query('SELECT id, task_id, agent, action, old_value, new_value FROM audit_log ORDER BY id').all(),
    comments: db.query('SELECT id, task_id, agent, content, type FROM comments ORDER BY id').all(),
    leases: db.query('SELECT id, lease_expires_at FROM tasks ORDER BY id').all()
  }
}

const createTask = (title: string, priority?: string) => {
  const args: { title: string; reporter: string; priority?: any } = { title, reporter: 'dev' }
  if (priority) args.priority = priority
  return json(handleCreateTask(svc, args)).id as number
}

describe('claim_task id alias (F1 #1040)', () => {
  test('id alone claims exactly that task, never an auto-picked one', () => {
    // p0 first in queue order, so pre-fix auto-pick would have claimed `first`, not `second`.
    const first = createTask('Auto-pick bait', 'p0')
    const second = createTask('Alias target', 'p3')
    expect(first).not.toBe(second)

    const res = json(handleClaimTask(svc, { agent: 'dev', id: second }))
    expect(res.id).toBe(second)
    expect(getTaskRow(db, second).status).toBe('in_progress')
    expect(getTaskRow(db, first).status).toBe('queued')
    expect(getTaskRow(db, first).lease_expires_at).toBeNull()
  })

  test('task_id alone still claims exactly that task (canonical name unchanged)', () => {
    const first = createTask('Auto-pick bait', 'p0')
    const second = createTask('Canonical target', 'p3')

    const res = json(handleClaimTask(svc, { agent: 'dev', task_id: second }))
    expect(res.id).toBe(second)
    expect(getTaskRow(db, first).status).toBe('queued')
  })

  test('id and task_id both present and equal → claims, no error', () => {
    const id = createTask('Both equal', 'p1')
    const res = handleClaimTask(svc, { agent: 'dev', id, task_id: id })
    expect(res.isError).toBeUndefined()
    expect(json(res).id).toBe(id)
    expect(getTaskRow(db, id).status).toBe('in_progress')
  })

  test('id and task_id disagree → exact conflict text, nothing claimed, both stay queued', () => {
    const a = createTask('A', 'p0')
    const b = createTask('B', 'p1')

    const forward = handleClaimTask(svc, { agent: 'dev', id: b, task_id: a })
    expect(forward.isError).toBe(true)
    expect(text(forward)).toBe(`INVALID: claim_task id/task_id conflict (id=${b} task_id=${a}); task_id is canonical`)

    const reverse = handleClaimTask(svc, { agent: 'dev', id: a, task_id: b })
    expect(reverse.isError).toBe(true)
    expect(text(reverse)).toBe(`INVALID: claim_task id/task_id conflict (id=${a} task_id=${b}); task_id is canonical`)

    expect(getTaskRow(db, a).status).toBe('queued')
    expect(getTaskRow(db, b).status).toBe('queued')
    expect(getTaskRow(db, a).lease_expires_at).toBeNull()
    expect(getTaskRow(db, b).lease_expires_at).toBeNull()
  })

  test('alias conflict writes no claim audit row', () => {
    const a = createTask('A', 'p0')
    const b = createTask('B', 'p1')
    const before = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'claim'").get() as { n: number }
    handleClaimTask(svc, { agent: 'dev', id: b, task_id: a })
    const after = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'claim'").get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  test('alias resolution precedes the queue: id-only claim on a blocked-by-deps task is BLOCKED, not EMPTY', () => {
    const dep = createTask('Dep')
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev', depends_on: [dep] })).id as number
    const res = handleClaimTask(svc, { agent: 'dev', id: target })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('BLOCKED')
  })
})

describe('unknown-argument rejection on claim_task (F1 #1040)', () => {
  test('id_typo → exact INVALID text and no auto-pick; intended task still in list_queue', () => {
    const first = createTask('Intended', 'p0')
    const other = createTask('Other', 'p3')

    const res = handleClaimTask(svc, { agent: 'dev', id_typo: first } as any)
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: unknown argument id_typo on claim_task (accepted: agent, id, include, lease_ttl_min, task_id)')

    const queue = text(handleListQueue(svc, {}))
    expect(queue).toContain(`${first}|p0|Intended`)
    expect(getTaskRow(db, first).status).toBe('queued')
    expect(getTaskRow(db, other).status).toBe('queued')
  })

  test('multi-key unknown input → plural "arguments" and ascending key order', () => {
    const id = createTask('Bait', 'p0')
    const res = handleClaimTask(svc, { agent: 'dev', b: 1, a: 2 } as any)
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: unknown arguments a, b on claim_task (accepted: agent, id, include, lease_ttl_min, task_id)')
    expect(getTaskRow(db, id).status).toBe('queued')
  })

  test('key order on the wire does not change the message (deterministic text)', () => {
    createTask('Bait', 'p0')
    const first = text(handleClaimTask(svc, { agent: 'dev', zebra: 1, alpha: 2, mike: 3 } as any))
    const second = text(handleClaimTask(svc, { agent: 'dev', mike: 3, zebra: 1, alpha: 2 } as any))
    expect(first).toBe('INVALID: unknown arguments alpha, mike, zebra on claim_task (accepted: agent, id, include, lease_ttl_min, task_id)')
    expect(second).toBe(first)
  })

  test('id_typo does not hide a valid task_id: guard wins, nothing claimed', () => {
    const id = createTask('Guarded', 'p0')
    const res = handleClaimTask(svc, { agent: 'dev', task_id: id, id_typo: 1 } as any)
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: unknown argument id_typo on claim_task (accepted: agent, id, include, lease_ttl_min, task_id)')
    expect(getTaskRow(db, id).status).toBe('queued')
  })

  test('guard runs before the service: a rejected claim mutates nothing', () => {
    const id = createTask('Untouched', 'p0')
    const before = snapshot()
    handleClaimTask(svc, { agent: 'dev', id_typo: id } as any)
    expect(snapshot()).toEqual(before)
  })

  test('no reap side effect on the rejected path (reap counter untouched)', () => {
    createTask('Bait', 'p0')
    // A write-path claim always forces a reap (service.claimTask → _doReap); the guard
    // short-circuits before that, so a counting store must not be touched.
    const countingRepo = new TaskRepo(db)
    let reaps = 0
    const original = countingRepo.expiredLeases.bind(countingRepo)
    countingRepo.expiredLeases = (now: string) => { reaps++; return original(now) }
    const countingSvc = new TaskService(countingRepo, { leaseTtlMin: 15, reapCooldownSec: 0 })

    expect(reaps).toBe(0)
    countingSvc.claimTask({ agent: 'dev', taskId: 1 })
    expect(reaps).toBeGreaterThan(0)

    const afterValid = reaps
    handleClaimTask(countingSvc, { agent: 'dev', id_typo: 1 } as any)
    expect(reaps).toBe(afterValid)
  })
})

describe('task_id 0 must not auto-pick (F1 #1040)', () => {
  test('handleClaimTask with task_id 0 errors and claims nothing', () => {
    const bait = createTask('Bait', 'p0')
    const res = handleClaimTask(svc, { agent: 'dev', task_id: 0 })
    expect(res.isError).toBe(true)
    expect(getTaskRow(db, bait).status).toBe('queued')
    expect(getTaskRow(db, bait).lease_expires_at).toBeNull()
  })

  test('handleClaimTask with id 0 errors and claims nothing', () => {
    const bait = createTask('Bait', 'p0')
    const res = handleClaimTask(svc, { agent: 'dev', id: 0 })
    expect(res.isError).toBe(true)
    expect(getTaskRow(db, bait).status).toBe('queued')
  })

  test('service.claimTask with taskId 0 returns NOT_FOUND, never an auto-claim', () => {
    const bait = createTask('Bait', 'p0')
    const res = svc.claimTask({ agent: 'dev', taskId: 0 })
    expect(res).toEqual({ ok: false, error: 'NOT_FOUND:' })
    expect(getTaskRow(db, bait).status).toBe('queued')
  })

  test('service.claimTask with taskId -5 returns NOT_FOUND (pre-existing behaviour kept)', () => {
    const bait = createTask('Bait', 'p0')
    const res = svc.claimTask({ agent: 'dev', taskId: -5 })
    expect(res).toEqual({ ok: false, error: 'NOT_FOUND:' })
    expect(getTaskRow(db, bait).status).toBe('queued')
  })
})

describe('unknown-argument rejection on the other handlers (F1 #1040)', () => {
  // handleGetTemplate is not exported from src/mcp/tools.ts, so get_template is covered
  // over the wire in src/server.test.ts ('argument contract over MCP'). The 7 exported
  // handlers live here; every row passes args that WOULD mutate or read state if the
  // guard were absent, so the snapshot equality is a real no-fallthrough assertion.
  function rows(): Array<{ expected: string; call: (id: number) => any }> {
    return [
      {
        expected: 'INVALID: unknown argument bogus on create_task (accepted: assignee, depends_on, description, epic, epic_id, priority, reporter, title)',
        call: () => handleCreateTask(svc, { title: 'Should not exist', reporter: 'dev', bogus: 1 } as any)
      },
      {
        expected: 'INVALID: unknown argument field on get_task (accepted: fields, id)',
        call: (id: number) => handleGetTask(svc, { id, field: 'x' } as any)
      },
      {
        expected: 'INVALID: unknown argument sort on list_tasks (accepted: assignee, epic_id, fields, ids, limit, status, updated_since)',
        call: () => handleListTasks(svc, { status: 'queued', limit: 5, sort: 'id' } as any)
      },
      {
        expected: 'INVALID: unknown argument task on update_status (accepted: agent, comment, id, renew, reset_attempts, status, version)',
        call: (id: number) => handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: 1, task: 'review' } as any)
      },
      {
        expected: 'INVALID: unknown argument agent on list_queue (accepted: limit)',
        call: () => handleListQueue(svc, { limit: 5, agent: 'dev' } as any)
      },
      {
        expected: 'INVALID: unknown argument body on add_comment (accepted: agent, comment, content, id, text)',
        call: (id: number) => handleAddComment(svc, { id, agent: 'dev', content: 'nope', body: 'nope' } as any)
      },
      {
        expected: 'INVALID: unknown argument order on get_timeline (accepted: id, limit)',
        call: (id: number) => handleGetTimeline(svc, { id, limit: 5, order: 'asc' } as any)
      }
    ]
  }

  for (const row of rows()) {
    const tool = row.expected.split(' on ')[1]!.split(' ')[0]!
    test(`${tool}: unknown key → exact INVALID text, store byte-identical`, () => {
      const id = createTask('Target', 'p0')
      const before = snapshot()
      const res = row.call(id)
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(row.expected)
      expect(snapshot()).toEqual(before)
    })
  }

  test('create_task rejection does not create the task the guard blocked', () => {
    createTask('Existing', 'p0')
    const res = handleCreateTask(svc, { title: 'Ghost', reporter: 'dev', bogus: 1 } as any)
    expect(res.isError).toBe(true)
    const titles = (db.query('SELECT title FROM tasks ORDER BY id').all() as Array<{ title: string }>).map(r => r.title)
    expect(titles).toEqual(['Existing'])
  })

  test('update_status rejection does not transition the task', () => {
    const id = createTask('Target', 'p0')
    const res = handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: 1, task: 'review' } as any)
    expect(res.isError).toBe(true)
    expect(getTaskRow(db, id).status).toBe('queued')
    expect(getTaskRow(db, id).version).toBe(1)
  })

  test('add_comment rejection inserts no comment row', () => {
    const id = createTask('Target', 'p0')
    const res = handleAddComment(svc, { id, agent: 'dev', content: 'nope', body: 'nope' } as any)
    expect(res.isError).toBe(true)
    const comments = db.query('SELECT COUNT(*) AS n FROM comments').get() as { n: number }
    expect(comments.n).toBe(0)
  })
})

describe('renew / reset_attempts argument contract (F2 #1065 + F3 #1066)', () => {
  // Both flags hang off update_status and nowhere else: no 11th tool (D-F2-1/D-F3-1), so the
  // F1 guard must accept them there and still reject them on every other handler.
  function claimed(): number {
    const id = createTask('Working', 'p0')
    const res = handleClaimTask(svc, { agent: 'dev', task_id: id })
    expect(res.isError).toBeUndefined()
    return id
  }
  const version = (id: number) => getTaskRow(db, id).version as number

  test('renew: true is accepted on update_status and reaches the service', () => {
    const id = claimed()
    const before = getTaskRow(db, id)
    // The claim and the renewal both stamp now + lease_ttl_min, so an un-pinned pre-state collides
    // with the post-state whenever both land in the same millisecond and "changed" would be asserting
    // on the clock (that is what turned run 36742457188 red). A deadline one second out leaves 14
    // minutes between the pre-state and anything a renewal can write, so the post-conditions below
    // hold by construction instead of by luck.
    const pinned = new Date(Date.now() + 1000).toISOString()
    db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [pinned, id])

    const res = handleUpdateStatus(svc, { id, agent: 'dev', status: 'in_progress', renew: true, version: before.version })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, status: 'in_progress', version: before.version + 1 })

    const after = getTaskRow(db, id)
    expect(after.lease_expires_at).not.toBe(pinned)
    // 14 min of slack under the 15 min lease_ttl_min. Strictly stronger than "changed": a deadline
    // one second out can only reach a full window if the renewal recomputed it from now.
    expect(new Date(after.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
    const renewed = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = 'lease_renewed'").get(id) as { n: number }
    expect(renewed.n).toBe(1)
  })

  test('renew: false is an accepted no-op argument, not an unknown key', () => {
    const id = claimed()
    const res = handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', renew: false, version: version(id) })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('review')
  })

  test('reset_attempts: true is accepted on update_status and echoes attempts', () => {
    const id = claimed()
    db.run('UPDATE tasks SET attempts = 2 WHERE id = ?', [id])
    const res = handleUpdateStatus(svc, {
      id, agent: 'dev', status: 'blocked', version: version(id), reset_attempts: true, comment: 'spent on a typo'
    })
    expect(res.isError).toBeUndefined()
    expect(json(res).attempts).toBe(0)
    expect(getTaskRow(db, id).attempts).toBe(0)
    expect(getTaskRow(db, id).max_attempts).toBe(3)
  })

  test('renew: true on claim_task → exact unknown-argument text, nothing claimed', () => {
    const id = createTask('Untouched', 'p0')
    const res = handleClaimTask(svc, { agent: 'dev', task_id: id, renew: true } as any)
    expect(text(res)).toBe('INVALID: unknown argument renew on claim_task (accepted: agent, id, include, lease_ttl_min, task_id)')
    expect(getTaskRow(db, id).status).toBe('queued')
    expect(getTaskRow(db, id).lease_expires_at).toBeNull()
  })

  test('reset_attempts: true on add_comment → exact unknown-argument text, no comment row', () => {
    const id = createTask('Untouched', 'p0')
    const res = handleAddComment(svc, { id, agent: 'dev', content: 'hi', reset_attempts: true } as any)
    expect(text(res)).toBe('INVALID: unknown argument reset_attempts on add_comment (accepted: agent, comment, content, id, text)')
    const comments = db.query('SELECT COUNT(*) AS n FROM comments').get() as { n: number }
    expect(comments.n).toBe(0)
  })

  test('the flags are additive: the accepted list is exactly the seven update_status keys', () => {
    const id = claimed()
    const res = handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', version: version(id), extra_key: 1 } as any)
    expect(text(res)).toBe('INVALID: unknown argument extra_key on update_status (accepted: agent, comment, id, renew, reset_attempts, status, version)')
  })
})
