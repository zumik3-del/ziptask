import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Database as SqliteDb } from 'bun:sqlite'
import { nowIso } from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { openDatabase } from './db/db'
import { MIGRATIONS } from './db/migrations'
import {
  handleCreateTask, handleGetTask, handleClaimTask, handleUpdateStatus,
  handleListQueue, handleListTasks
} from './mcp/task-tools'
import {
  createTestDb, closeTestDb, getTaskRow, json, text, driveToDone, makeTempDbPath, removeTempDb, testProjectId, seedProject
} from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' }) })
afterEach(() => { closeTestDb(db) })

// A refusal writes nothing — not the row, not the audit log (docs/epics.md). Every no-write case
// below reads this before and after, so "the row did not move" is an assertion, not an assumption.
const auditCount = (id: number): number =>
  (db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ?').get(id) as { n: number }).n
const versionOf = (id: number): number => json(handleGetTask(svc, { id, fields: ['version'] })).version

describe('epic creation', () => {
  test('epic: true creates non-claimable task with is_epic=1', () => {
    const res = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    expect(res.status).toBe('open')
    const task = getTaskRow(db, res.id)
    expect(task.is_epic).toBe(true)
    expect(task.epic_id).toBeNull()
    // ADR 0002: an epic holds no lease, so the birth INSERT never names the lease column. The
    // assignee half is refused upstream and pinned at the store in 'an epic takes no assignee'.
    expect(task.lease_expires_at).toBeNull()
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
    const before = getTaskRow(db, epicId)
    const res = handleClaimTask(svc, { agent: 'dev', task_id: epicId })
    expect(res.isError).toBe(true)
    // ADR 0002 checks the epic refusal ahead of the status window (src/core/service.ts:185), so an
    // epic born `open` still gets the sentence naming the real reason instead of degrading to
    // `CONFLICT: status=open`, and claim_task agrees word for word with the update_status guard.
    expect(text(res)).toBe(`INVALID: #${epicId} is an epic, not claimable`)
    const after = getTaskRow(db, epicId)
    expect(after.status).toBe(before.status)
    expect(after.version).toBe(before.version)
    // a refusal is not an attempt: the row is untouched down to the audit log
    expect(after.attempts).toBe(before.attempts)
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
    expect(auditCount(epicId)).toBe(1) // the create row only
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
    expect(text(res)).toContain('NOT_FOUND:')
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
    expect(task.is_epic).toBe(false)
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const promoted = getTaskRow(db, epicId)
    expect(promoted.is_epic).toBe(true)
    expect(promoted.epic_id).toBeNull()
  })

  test('second sub-task does not re-promote (idempotent)', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub1', reporter: 'dev', epic_id: epicId }))
    json(handleCreateTask(svc, { title: 'Sub2', reporter: 'dev', epic_id: epicId }))
    const task = getTaskRow(db, epicId)
    expect(task.is_epic).toBe(true)
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
  // An epic holds no work, so it is never leased and never parks: ADR 0002 gives it the epic-only
  // `open` status whose only outgoing edges are the terminal outcomes (done/failed/canceled), each
  // gated by the non-terminal-children guard. No on-ramp through blocked/review exists any more.
  test('epic with open children cannot go done', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const epicTask = getTaskRow(db, epicId)
    const guard = handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'done', version: epicTask.version })
    expect(guard.isError).toBe(true)
    expect(text(guard)).toContain('CHILDREN')
  })

  test('epic with open children cannot go failed', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId }))
    const epicTask = getTaskRow(db, epicId)
    const guard = handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'failed', version: epicTask.version })
    expect(guard.isError).toBe(true)
    expect(text(guard)).toContain('CHILDREN')
  })

  test('epic without children can go done', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const epicTask = getTaskRow(db, epicId)
    // asserted, not assumed: a plain task would be `queued` and `queued → done` an unrelated refusal,
    // so the direct terminal hop below must start from a real `open` epic
    expect(epicTask.status).toBe('open')
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
    // Epic should still be open (not auto-promoted to done)
    const epic = getTaskRow(db, epicId)
    expect(epic.status).toBe('open')
    expect(epic.is_epic).toBe(true)
  })
})

describe('epic-only open status (ADR 0002)', () => {
  // The status-shape guards of src/core/guards.ts: `open` is reserved for epics, and an epic never
  // holds queued/review/blocked — its only exits are the terminal outcomes. Both are refusal paths
  // with no write, so every case asserts the row and the audit log are untouched. Note the wording
  // is identical to what the transition table produces for the same pair, so these cases pin the
  // wire contract rather than isolating one guard; the guard branch that only it can reach (a legacy
  // leased epic asking for review) is covered in lease.test.ts.

  test('a regular task cannot be moved to open', () => {
    const id = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    const before = getTaskRow(db, id)

    const res = handleUpdateStatus(svc, { id, agent: 'dev', status: 'open', version: before.version })
    expect(text(res)).toBe('INVALID: queued → open')
    const after = getTaskRow(db, id)
    expect(after.status).toBe('queued')
    expect(after.version).toBe(before.version)
    expect(auditCount(id)).toBe(1) // the create row only
  })

  test('an epic never holds queued, review or blocked', () => {
    for (const status of ['queued', 'review', 'blocked'] as const) {
      const id = json(handleCreateTask(svc, { title: `Epic ${status}`, reporter: 'dev', epic: true })).id
      const before = getTaskRow(db, id)

      const res = handleUpdateStatus(svc, { id, agent: 'dev', status, version: before.version })
      expect(`${status}: ${text(res)}`).toBe(`${status}: INVALID: open → ${status}`)
      const after = getTaskRow(db, id)
      expect(`${status}: ${after.status}`).toBe(`${status}: open`)
      expect(`${status}: ${after.version}`).toBe(`${status}: ${before.version}`)
      expect(`${status}: ${auditCount(id)}`).toBe(`${status}: 1`)
    }
  })

  test('open reaches canceled directly, the third terminal outcome', () => {
    // done/failed are covered by the children guard above; canceled carries no extra precondition
    // beyond that same guard, so it is asserted here as the plain open → terminal hop.
    const id = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const before = getTaskRow(db, id)

    const res = json(handleUpdateStatus(svc, { id, agent: 'dev', status: 'canceled', version: before.version }))
    expect(res.status).toBe('canceled')
    const after = getTaskRow(db, id)
    expect(after.completed_at).not.toBeNull()
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
  })
})

// The order of claim_task's three refusals is wire-visible, and each rung outranks the next
// (src/core/service.ts:183-190): epic → status window → deps. Moving a rung is not a refactor, it
// changes what a caller reads — a claim that names the status instead of the epic reads as a stale
// task, and one that names the deps instead of the status as unfinished work. Each case pins the
// whole row too: a refusal is not a write, so status, version, attempts and the audit log all hold.
describe('claim_task refusal order: epic → status window → deps', () => {
  const claimRefusal = (id: number, agent: string): string => {
    const res = handleClaimTask(svc, { agent, task_id: id })
    expect(res.isError).toBe(true)
    return text(res)
  }

  // The row is the other half of every refusal: nothing moved, and no attempt was spent on a call
  // that never leased anything.
  const expectUntouched = (id: number, before: { status: string; version: number; attempts: number; audit: number }) => {
    const after = getTaskRow(db, id)
    expect(after.status).toBe(before.status)
    expect(after.version).toBe(before.version)
    expect(after.attempts).toBe(before.attempts)
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
    expect(auditCount(id)).toBe(before.audit)
  }

  // The snapshot is taken before the refusal and the audit count rides along, so expectUntouched
  // proves the call appended nothing — a baseline read afterwards would absorb the very write it is
  // meant to catch.
  const baseline = (id: number) => ({ ...getTaskRow(db, id), audit: auditCount(id) })

  // A closed epic is still an epic: docs/epics.md documents the refusal for "explicit claim_task on
  // an epic" without qualifying the status, so all three terminal outcomes must say the same thing.
  test('a terminal epic keeps the epic refusal, whichever outcome closed it', () => {
    for (const terminal of ['done', 'failed', 'canceled'] as const) {
      const id = json(handleCreateTask(svc, { title: `Epic ${terminal}`, reporter: 'dev', epic: true })).id
      const open = getTaskRow(db, id)
      expect(`${terminal}: ${open.status}`).toBe(`${terminal}: open`)
      json(handleUpdateStatus(svc, { id, agent: 'dev', status: terminal, version: open.version }))

      const before = baseline(id)
      expect(`${terminal}: ${before.status}`).toBe(`${terminal}: ${terminal}`)
      expect(`${terminal}: ${claimRefusal(id, 'dev')}`).toBe(`${terminal}: INVALID: #${id} is an epic, not claimable`)
      expectUntouched(id, before)
    }
  })

  // The rung below the epic: a non-epic past the window is named by its status, and the status is
  // the only thing the caller can act on (a terminal task is recovered by recreating it).
  test('a terminal non-epic answers the status window with its own outcome', () => {
    // done: the full path; failed: in_progress → failed; canceled: withdrawn straight from queued.
    const done = json(handleCreateTask(svc, { title: 'Done', reporter: 'dev' })).id
    driveToDone(svc, done, 'dev')
    const failed = json(handleCreateTask(svc, { title: 'Failed', reporter: 'dev' })).id
    json(handleUpdateStatus(svc, { id: failed, agent: 'dev', status: 'in_progress', version: versionOf(failed) }))
    json(handleUpdateStatus(svc, { id: failed, agent: 'dev', status: 'failed', version: versionOf(failed) }))
    const canceled = json(handleCreateTask(svc, { title: 'Canceled', reporter: 'dev' })).id
    json(handleUpdateStatus(svc, { id: canceled, agent: 'dev', status: 'canceled', version: versionOf(canceled) }))

    for (const id of [done, failed, canceled]) {
      const before = baseline(id)
      expect(`${before.status}: ${claimRefusal(id, 'dev')}`).toBe(`${before.status}: CONFLICT: status=${before.status}`)
      expectUntouched(id, before)
    }
  })

  // The rung below that: queued/blocked is inside the window, so only the dependency check can
  // refuse — the wording the lease guard reuses for update_status → in_progress.
  test('a dep-blocked non-epic answers the dependency refusal, from queued and from blocked', () => {
    const dep = json(handleCreateTask(svc, { title: 'Dep', reporter: 'dev' })).id
    const blocked = json(handleCreateTask(svc, { title: 'Dependent', reporter: 'dev', depends_on: [dep] })).id
    expect(getTaskRow(db, blocked).status).toBe('queued')

    const queued = baseline(blocked)
    expect(claimRefusal(blocked, 'dev')).toBe('BLOCKED: dependencies not satisfied')
    expectUntouched(blocked, queued)

    json(handleUpdateStatus(svc, { id: blocked, agent: 'dev', status: 'blocked', version: versionOf(blocked) }))
    const parked = baseline(blocked)
    expect(claimRefusal(blocked, 'dev')).toBe('BLOCKED: dependencies not satisfied')
    expectUntouched(blocked, parked)
  })

  // The one case where the two rungs overlap: a terminal task still holding an open dep. It is
  // refused by the window, because the dep is no longer the reason — nothing can reopen the task,
  // so waiting for the dependency would be advice that leads nowhere.
  test('a terminal non-epic with an open dep is refused by the status window, not by the deps', () => {
    const dep = json(handleCreateTask(svc, { title: 'Open dep', reporter: 'dev' })).id
    const withdrawn = json(handleCreateTask(svc, { title: 'Withdrawn dependent', reporter: 'dev', depends_on: [dep] })).id
    // queued → canceled is the withdraw path, and it leaves the dependency open on purpose
    json(handleUpdateStatus(svc, { id: withdrawn, agent: 'dev', status: 'canceled', version: versionOf(withdrawn) }))
    // asserted, not assumed: a closed dep would turn this into the dep case above for the wrong reason
    expect(getTaskRow(db, dep).status).toBe('queued')
    expect(json(handleGetTask(svc, { id: withdrawn, fields: ['blocked_by'] })).blocked_by).toEqual([dep])

    const before = baseline(withdrawn)
    expect(claimRefusal(withdrawn, 'dev')).toBe('CONFLICT: status=canceled')
    expectUntouched(withdrawn, before)
  })
})

describe('migration 007: a legacy epic row becomes open', () => {
  // The data half of ADR 0002 runs once, on a real upgrade: the first test drives it through
  // openDatabase on a real pre-007 database, the second re-executes the raw 007 statements by hand.
  // Both locate the pair by SQL identity, never by a positional tail — appending a migration 008
  // must not silently re-point them, and deleting 007a or 007b must fail the lookup, not pass.
  const OPEN_MARKER = "SET status = 'open', lease_expires_at = NULL, assignee = NULL"
  const CLEAR_MARKER = "SET lease_expires_at = NULL, assignee = NULL WHERE is_epic = 1"
  const locate007 = (): { openIdx: number; clearIdx: number } => {
    const openIdx = MIGRATIONS.findIndex(stmt => stmt.includes(OPEN_MARKER))
    const clearIdx = MIGRATIONS.findIndex(stmt => stmt.includes(CLEAR_MARKER))
    if (openIdx < 0 || clearIdx !== openIdx + 1) {
      throw new Error(`migration 007 statements not located as a pair (open=${openIdx}, clear=${clearIdx})`)
    }
    return { openIdx, clearIdx }
  }
  const SEED_TIME = '2026-01-01T00:00:00.000Z'
  const FUTURE_LEASE = '2099-01-01T00:00:00.000Z'

  // A real pre-007 database: the frozen prefix replayed, legacy epic rows seeded through raw SQL, and
  // the version stamped one short so openDatabase applies exactly the two migration-007 statements.
  const seedPre007Db = (path: string, prefixLength: number) => {
    const raw = new SqliteDb(path)
    // One transaction: the replay is 30 DDL statements plus 6 writes, and one commit per
    // statement is what made this fixture slow. DDL inside a transaction is what production
    // does too (src/db/db.ts applyMigrations). No PRAGMA is involved here, so nothing has to
    // stay outside the transaction.
    const build = raw.transaction(() => {
      for (const stmt of MIGRATIONS.slice(0, prefixLength)) raw.exec(stmt)
      raw.run(
        "INSERT INTO projects (slug, folder_path, created_at, updated_at) VALUES ('legacy-epics', '', ?, ?)",
        [SEED_TIME, SEED_TIME]
      )
      const projectId = (raw.query('SELECT id FROM projects WHERE slug = ?').get('legacy-epics') as { id: number }).id
      const seedEpic = (title: string, status: string, assignee: string | null, lease: string | null) =>
        raw.run(
          `INSERT INTO tasks (title, reporter, status, assignee, lease_expires_at, is_epic, project_id, created_at, updated_at)
           VALUES (?, 'dev', ?, ?, ?, 1, ?, ?, ?)`,
          [title, status, assignee, lease, projectId, SEED_TIME, SEED_TIME]
        )
      seedEpic('QueuedEpic', 'queued', null, null)
      seedEpic('LeasedEpic', 'in_progress', 'developer', FUTURE_LEASE)
      seedEpic('DoneEpic', 'done', 'developer', FUTURE_LEASE)
      raw.run('DELETE FROM schema_version')
      raw.run('INSERT INTO schema_version (version) VALUES (?)', [prefixLength])
    })
    build()
    raw.close()
  }

  test('non-terminal epics become open and lose assignee/lease, a terminal epic keeps its outcome', () => {
    const { openIdx } = locate007()
    const path = makeTempDbPath('epic-open-007')
    try {
      seedPre007Db(path, openIdx)

      const upgraded = openDatabase(path)
      expect((upgraded.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version).toBe(MIGRATIONS.length)
      const rows = upgraded.query('SELECT title, status, assignee, lease_expires_at, updated_at FROM tasks ORDER BY id').all() as any[]
      upgraded.close()

      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      expect(byTitle.QueuedEpic.status).toBe('open')
      expect(byTitle.LeasedEpic.status).toBe('open')
      // the rewritten rows are visibly stamped, not silently relabelled
      expect(byTitle.QueuedEpic.updated_at).not.toBe(SEED_TIME)
      // the stale lease is dropped from every epic, terminal or not
      expect(byTitle.LeasedEpic.assignee).toBeNull()
      expect(byTitle.LeasedEpic.lease_expires_at).toBeNull()
      expect(byTitle.DoneEpic.status).toBe('done')
      expect(byTitle.DoneEpic.assignee).toBeNull()
      expect(byTitle.DoneEpic.lease_expires_at).toBeNull()
    } finally { removeTempDb(path) }
  })

  // ADR 0002 claims the rewrite is idempotent ("re-running it matches zero rows after the first
  // pass"), and an operator can re-execute it by hand after a rolled-back deploy, so the property is
  // pinned rather than assumed. The statements come from locate007, not from a positional tail, and
  // SQLite counts matched rows, so the zeroes also pin each WHERE filter.
  test('migration 007 is idempotent: re-running its statements matches zero rows', () => {
    const { openIdx, clearIdx } = locate007()
    const path = makeTempDbPath('epic-open-007-idempotent')
    try {
      seedPre007Db(path, openIdx)
      const upgraded = openDatabase(path)

      const first = upgraded.run(MIGRATIONS[openIdx])
      const second = upgraded.run(MIGRATIONS[clearIdx])
      expect(Number(first.changes)).toBe(0)
      expect(Number(second.changes)).toBe(0)

      const rows = upgraded.query('SELECT title, status FROM tasks ORDER BY id').all() as any[]
      upgraded.close()
      // the re-run moved nothing: the rewritten rows stay open and the closed epic stays closed
      expect(rows.map(r => `${r.title}=${r.status}`)).toEqual(['QueuedEpic=open', 'LeasedEpic=open', 'DoneEpic=done'])
    } finally { removeTempDb(path) }
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

describe('canceled children do not block epic closure (#112)', () => {
  const cancelChild = (id: number) => handleUpdateStatus(svc, { id, agent: 'dev', status: 'canceled', version: 1 })

  test('nonTerminalChildCount ignores canceled children', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    expect(repo.nonTerminalChildCount(epicId)).toBe(1)
    cancelChild(subId)
    expect(repo.nonTerminalChildCount(epicId)).toBe(0)
  })

  test('nonTerminalChildCount still counts open children when a sibling is canceled', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const sub1 = json(handleCreateTask(svc, { title: 'Sub1', reporter: 'dev', epic_id: epicId })).id
    json(handleCreateTask(svc, { title: 'Sub2', reporter: 'dev', epic_id: epicId }))
    cancelChild(sub1)
    expect(repo.nonTerminalChildCount(epicId)).toBe(1)
  })

  test('childStatusCounts reports canceled', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    cancelChild(subId)
    const counts = repo.childStatusCounts(epicId)
    expect(counts.total).toBe(1)
    expect(counts.canceled).toBe(1)
    expect(counts.open).toBe(0)
  })

  test('epic update_status → done succeeds when only canceled children remain', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    cancelChild(subId)
    // epics go directly to terminal outcomes
    const t1 = getTaskRow(db, epicId)
    const done = json(handleUpdateStatus(svc, { id: epicId, agent: 'dev', status: 'done', version: t1.version }))
    expect(done.status).toBe('done')
  })

  test('get_task subtasks roll-up includes canceled', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const sub1 = json(handleCreateTask(svc, { title: 'Sub1', reporter: 'dev', epic_id: epicId })).id
    const sub2 = json(handleCreateTask(svc, { title: 'Sub2', reporter: 'dev', epic_id: epicId })).id
    cancelChild(sub1)
    driveToDone(svc, sub2, 'dev')
    const view = json(handleGetTask(svc, { id: epicId, fields: ['subtasks'] }))
    expect(view.subtasks.total).toBe(2)
    expect(view.subtasks.canceled).toBe(1)
    expect(view.subtasks.done).toBe(1)
    expect(view.subtasks.open).toBe(0)
    expect(view.subtasks.failed).toBe(0)
  })

  test('canceling a child writes no subtask_done/subtask_failed mirror', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    cancelChild(subId)
    const mirrors = db.query(
      "SELECT action FROM audit_log WHERE task_id = ? AND action IN ('subtask_done', 'subtask_failed')"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(0)
  })
})

describe('atomic epic promotion (#108)', () => {
  test('subtask attach atomically promotes epic and adds mirror', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id

    const epic = getTaskRow(db, epicId)
    expect(epic.is_epic).toBe(true)

    const mirrors = db.query(
      "SELECT action, new_value FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
    expect(mirrors[0].new_value).toContain(`#${subId}`)
    expect(mirrors[0].new_value).toContain('Sub')
  })

  test('direct promoteEpicWithMirror call is atomic (both or neither)', () => {
    const epicId = json(handleCreateTask(svc, { title: 'DirectEpic', reporter: 'dev' })).id
    ;repo.promoteEpicWithMirror(
      epicId, 'dev', 'subtask_add', '#99 Some Sub', nowIso(), true
    )
    const epic = getTaskRow(db, epicId)
    expect(epic.is_epic).toBe(true)
    const mirrors = db.query(
      "SELECT action FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(epicId) as any[]
    expect(mirrors.length).toBe(1)
  })
})

// Review #1740 P1: promotion rewrote the target's status to `open` and cleared its lease, so
// attaching a child to a task somebody was already working silently destroyed that work. Promotion
// is now confined to a `queued` target; every other non-terminal status is refused up front.
describe('promotion cannot destroy in-flight work (review #1740 P1)', () => {
  function seedTask(title: string, status: 'queued' | 'in_progress' | 'review' | 'blocked', assignee?: string): number {
    const id = json(handleCreateTask(svc, { title, reporter: 'dev', ...(assignee ? { assignee } : {}) })).id
    if (status === 'in_progress') {
      handleClaimTask(svc, { agent: assignee ?? 'dev', task_id: id })
    } else if (status === 'review') {
      handleUpdateStatus(svc, { id, agent: assignee ?? 'dev', status: 'in_progress', version: versionOf(id) })
      handleUpdateStatus(svc, { id, agent: assignee ?? 'dev', status: 'review', version: versionOf(id) })
    } else if (status === 'blocked') {
      handleUpdateStatus(svc, { id, agent: 'dev', status: 'blocked', version: versionOf(id) })
    }
    return id
  }

  function versionOf(id: number): number {
    return json(handleGetTask(svc, { id, fields: ['version'] })).version
  }

  for (const status of ['in_progress', 'review', 'blocked'] as const) {
    test(`attaching a child to a ${status} task is refused and the row does not move`, () => {
      const target = seedTask(`Target ${status}`, status, 'worker')
      const before = getTaskRow(db, target)!
      const res: any = handleCreateTask(svc, { title: 'Child', reporter: 'dev', epic_id: target })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(
        `INVALID: cannot promote #${target} from ${status}: only a queued task can become an epic`
      )
      const after = getTaskRow(db, target)!
      expect(after.status).toBe(before.status)
      expect(after.assignee).toBe(before.assignee)
      expect(after.lease_expires_at).toBe(before.lease_expires_at)
      expect(after.is_epic).toBe(false)
    })
  }

  test('a live lease survives a refused promotion attempt', () => {
    const target = seedTask('Leased work', 'in_progress', 'worker')
    const leaseBefore = getTaskRow(db, target)!.lease_expires_at
    handleCreateTask(svc, { title: 'Child', reporter: 'dev', epic_id: target })
    expect(getTaskRow(db, target)!.lease_expires_at).toBe(leaseBefore)
    // the holder can still heartbeat: the refusal left no trace at all
    const res = handleUpdateStatus(svc, {
      id: target, agent: 'worker', status: 'in_progress', version: versionOf(target), renew: true
    })
    expect(res.isError).toBeFalsy()
  })

  test('a queued task is still promoted, and only queued', () => {
    const target = seedTask('Fresh', 'queued')
    const child = handleCreateTask(svc, { title: 'Child', reporter: 'dev', epic_id: target })
    expect(child.isError).toBeFalsy()
    const after = getTaskRow(db, target)!
    expect(after.is_epic).toBe(true)
    expect(after.status).toBe('open')
  })

  test('attaching further children to an existing epic is still allowed', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    expect(handleCreateTask(svc, { title: 'C1', reporter: 'dev', epic_id: epic }).isError).toBeFalsy()
    // the epic is `open`, not `queued`, and no promotion happens, so this must not be refused
    expect(handleCreateTask(svc, { title: 'C2', reporter: 'dev', epic_id: epic }).isError).toBeFalsy()
  })
})

// #1745: createTaskGuard refuses every non-queued target, but the store-level WHERE is the defence
// behind that guard — it is what stops a bypass or a cross-process race from deforming a live row.
// These tests call the store directly, the only way to exercise the defence itself.
describe('promoteEpicWithMirror is a no-op off the queued path (#1745)', () => {
  function seedAt(status: 'in_progress' | 'review' | 'blocked'): number {
    const id = json(handleCreateTask(svc, { title: `Target ${status}`, reporter: 'dev', assignee: 'worker' })).id
    if (status === 'blocked') {
      handleUpdateStatus(svc, { id, agent: 'worker', status: 'blocked', version: versionOf(id) })
    } else {
      handleClaimTask(svc, { agent: 'worker', task_id: id })
      if (status === 'review') {
        handleUpdateStatus(svc, { id, agent: 'worker', status: 'review', version: versionOf(id) })
      }
    }
    return id
  }

  for (const status of ['in_progress', 'review', 'blocked'] as const) {
    test(`a direct call on a ${status} non-epic leaves is_epic, status, assignee, lease and version untouched`, () => {
      const target = seedAt(status)
      const before = getTaskRow(db, target)!
      // non-vacuity: the row really holds the state the defence has to protect. Only an in_progress
      // row carries a lease holder — `assignee` is cleared on every other status.
      expect(before.status).toBe(status)
      expect(before.assignee).toBe(status === 'in_progress' ? 'worker' : null)
      if (status === 'in_progress') expect(before.lease_expires_at).not.toBeNull()

      ;repo.promoteEpicWithMirror(target, 'dev', 'subtask_add', '#99 Some Sub', nowIso(), true)

      const after = getTaskRow(db, target)!
      expect(after.is_epic).toBe(false)
      expect(after.status).toBe(before.status)
      expect(after.assignee).toBe(before.assignee)
      expect(after.lease_expires_at).toBe(before.lease_expires_at)
      expect(after.version).toBe(before.version)
      expect(after.updated_at).toBe(before.updated_at)
    })
  }

  test('a queued non-epic is still promoted: is_epic=1, status=open, no holder and no lease', () => {
    const target = json(handleCreateTask(svc, { title: 'Fresh', reporter: 'dev' })).id
    const before = getTaskRow(db, target)!
    expect(before.status).toBe('queued')
    expect(before.assignee).toBeNull()
    expect(before.lease_expires_at).toBeNull()

    ;repo.promoteEpicWithMirror(target, 'dev', 'subtask_add', '#99 Some Sub', nowIso(), true)

    const after = getTaskRow(db, target)!
    expect(after.is_epic).toBe(true)
    expect(after.status).toBe('open')
    expect(after.assignee).toBeNull()
    expect(after.lease_expires_at).toBeNull()
    const mirrors = db.query(
      "SELECT new_value FROM audit_log WHERE task_id = ? AND action = 'subtask_add'"
    ).all(target) as any[]
    expect(mirrors.length).toBe(1)
    expect(mirrors[0].new_value).toBe('#99 Some Sub')
  })
})

// The epic-promotion race: create_task reads the epic_id target up front (the guard) and promotes it
// in the write. A rival can move the target in between — a claim takes the row out of `queued`, and
// promoting it would destroy live work. The target is re-read and re-checked inside the write
// transaction, so the race is refused with a CONFLICT instead of silently rewriting somebody's row.
//
// The store proxy is the reproduction: it flips the target's state on the guard's `getTaskRow` read,
// the read the guard cannot see past (src/service.test.ts:687 stubs a store the same way).
describe('epic promotion race (#1853)', () => {
  const LEASE_UNTIL = '2099-01-01T00:00:00.000Z'

  // The invariant the race must never break: no task row may point at a parent that is not an epic.
  const orphanChildren = (): number[] => (db.query(
    'SELECT c.id AS id FROM tasks c JOIN tasks p ON p.id = c.epic_id WHERE p.is_epic = 0'
  ).all() as any[]).map(r => r.id)
  // ...and no audit row may outlive its task: a refusal leaves no row behind, the child's own
  // create row included (comments and audit_log carry ON DELETE CASCADE, schema v4).
  const orphanAuditRows = (): number[] => (db.query(
    'SELECT a.rowid AS rowid FROM audit_log a LEFT JOIN tasks t ON t.id = a.task_id WHERE t.id IS NULL'
  ).all() as any[]).map(r => r.rowid)
  const childCount = (epicId: number): number =>
    (db.query('SELECT COUNT(*) AS n FROM tasks WHERE epic_id = ?').get(epicId) as { n: number }).n
  const mirrorCount = (taskId: number): number =>
    (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = 'subtask_add'")
      .get(taskId) as { n: number }).n
  const taskCount = (): number => (db.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n

  test('a target claimed between the guard read and the write is refused, and no child row is left', () => {
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev' })).id
    const before = getTaskRow(db, target)!

    // The store proxy: the guard's read hands back the row as it was, and the rival claims the
    // target right after that read — the window the guard cannot see.
    const raced = new TaskRepo(db)
    const read = raced.getTaskRow.bind(raced)
    let flipped = false
    raced.getTaskRow = (id: number) => {
      const row = read(id)
      if (id === target && !flipped) {
        flipped = true
        raced.markClaimed(target, row!.version, 'rival', LEASE_UNTIL, nowIso())
      }
      return row
    }

    const res = handleCreateTask(new TaskService(raced, { leaseTtlMin: 15, scope: 'test' }), {
      title: 'Child', reporter: 'dev', epic_id: target
    })

    // non-vacuity: the guard really read the target as queued, and the rival really took it
    expect(flipped).toBe(true)
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`CONFLICT: epic #${target} changed state during promotion`)
    // the refusal leaves no row behind: no child, and nothing pointing at a non-epic
    expect(childCount(target)).toBe(0)
    expect(orphanChildren()).toEqual([])
    expect(taskCount()).toBe(1)
    // the child's own create audit row is gone with it
    expect(orphanAuditRows()).toEqual([])
    // the rival's row is untouched: the refused promotion rewrote nothing
    const after = getTaskRow(db, target)!
    expect(after.is_epic).toBe(false)
    expect(after.status).toBe('in_progress')
    expect(after.assignee).toBe('rival')
    // the version moved by the rival's claim only — the refused promotion bumped nothing
    expect(after.version).toBe(before.version + 1)
  })

  test('the race is refused in the window between the child insert and the promotion write', () => {
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev' })).id
    const before = getTaskRow(db, target)!

    // The seam of the developer's #1853 approach: the store proxy flips the target right after the
    // child row is inserted — the guard has read the target by then, the promotion is still ahead.
    const raced = new TaskRepo(db)
    const insert = raced.insertTask.bind(raced)
    raced.insertTask = (args) => {
      const id = insert(args)
      if (args.epicId === target) raced.markClaimed(target, before.version, 'rival', LEASE_UNTIL, nowIso())
      return id
    }

    const res = handleCreateTask(new TaskService(raced, { leaseTtlMin: 15, scope: 'test' }), {
      title: 'Child', reporter: 'dev', epic_id: target
    })

    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`CONFLICT: epic #${target} changed state during promotion`)
    expect(childCount(target)).toBe(0)
    expect(orphanChildren()).toEqual([])
    expect(orphanAuditRows()).toEqual([])
    // a target that was not promoted gets no subtask_add mirror
    expect(mirrorCount(target)).toBe(0)
  })

  test('a target that leaves the queued path before the promotion write is refused, and gets no mirror', () => {
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev' })).id

    // The second window: the target is still queued when the transaction re-checks it, and the rival
    // claims it before the promotion UPDATE lands.
    const raced = new TaskRepo(db)
    const promote = raced.promoteEpicWithMirror.bind(raced)
    raced.promoteEpicWithMirror = (id, agent, action, newValue, now, auditLog) => {
      const row = raced.getTaskRow(id)!
      raced.markClaimed(id, row.version, 'rival', LEASE_UNTIL, nowIso())
      return promote(id, agent, action, newValue, now, auditLog)
    }

    const res = handleCreateTask(new TaskService(raced, { leaseTtlMin: 15, scope: 'test' }), {
      title: 'Child', reporter: 'dev', epic_id: target
    })

    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`CONFLICT: epic #${target} changed state during promotion`)
    // a target that was not promoted gets no subtask_add mirror
    expect(mirrorCount(target)).toBe(0)
    expect(childCount(target)).toBe(0)
    expect(orphanChildren()).toEqual([])
  })

  test('a direct promotion of a target that is not queued writes no subtask_add mirror', () => {
    const target = json(handleCreateTask(svc, { title: 'Leased', reporter: 'dev' })).id
    json(handleClaimTask(svc, { agent: 'worker', task_id: target }))

    // The store-level defence, called directly: the promotion matched no row, so the mirror that
    // belongs to an epic must not be written either.
    const changes = repo.promoteEpicWithMirror(target, 'dev', 'subtask_add', '#99 Some Sub', nowIso(), true)

    expect(changes).toBe(0)
    expect(mirrorCount(target)).toBe(0)
  })

  test('the promotion bumps the target version: the status rewrite is a row write', () => {
    const target = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    const before = getTaskRow(db, target)!
    expect(before.version).toBe(1)

    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: target }))

    const after = getTaskRow(db, target)!
    expect(after.is_epic).toBe(true)
    expect(after.status).toBe('open')
    expect(after.version).toBe(before.version + 1)
  })

  test('a version read before the promotion no longer matches the promoted row', () => {
    const target = json(handleCreateTask(svc, { title: 'Pre-Epic', reporter: 'dev' })).id
    const stale = getTaskRow(db, target)!.version
    json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: target }))

    // the optimistic lock sees the rewrite: a holder's stale version cannot match the promoted row
    const res = handleUpdateStatus(svc, { id: target, agent: 'dev', status: 'done', version: stale })
    expect(text(res)).toBe(`CONFLICT: expected version ${stale + 1}, got ${stale}`)
  })

  test('attaching to a task that is already an epic succeeds and does not bump its version', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const before = getTaskRow(db, epic)!

    // an epic is born `open` and is not `queued`, so there is nothing to promote: the attach is a
    // plain child insert, and the epic's own row is not written at all
    const res = handleCreateTask(svc, { title: 'Child', reporter: 'dev', epic_id: epic })
    expect(res.isError).toBeFalsy()
    expect(childCount(epic)).toBe(1)
    const after = getTaskRow(db, epic)!
    expect(after.version).toBe(before.version)
  })

  test('a target somebody else promoted in the meantime still takes the child', () => {
    const target = json(handleCreateTask(svc, { title: 'Target', reporter: 'dev' })).id

    // The other writer wins the promotion: the target is an epic by the time our UPDATE lands, so
    // the attach is not a race — there is nothing left to promote and the child has a real parent.
    const raced = new TaskRepo(db)
    const promote = raced.promoteEpicWithMirror.bind(raced)
    raced.promoteEpicWithMirror = (id, agent, action, newValue, now, auditLog) => {
      db.run(
        "UPDATE tasks SET is_epic = 1, status = 'open', version = version + 1, updated_at = ? WHERE id = ?",
        [now, id]
      )
      return promote(id, agent, action, newValue, now, auditLog)
    }

    const res = handleCreateTask(new TaskService(raced, { leaseTtlMin: 15, scope: 'test' }), {
      title: 'Child', reporter: 'dev', epic_id: target
    })

    expect(res.isError).toBeFalsy()
    expect(childCount(target)).toBe(1)
    expect(orphanChildren()).toEqual([])
    expect(mirrorCount(target)).toBe(1)
  })
})

// Review #1740 P2: `assignee` means "lease holder" everywhere else, and an epic holds no lease, so
// the value is refused rather than silently dropped.
describe('an epic takes no assignee (review #1740 P2)', () => {
  test('create_task(epic, assignee) is refused', () => {
    const res: any = handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true, assignee: 'boss' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: an epic takes no assignee: it holds no lease')
  })

  test('the store hard-writes a NULL assignee for an epic even when handed one', () => {
    // Review #1744 nit 3: the refusal above means the MCP path can never hand the store an assignee,
    // so only a direct store call exercises repo.ts:63 — the last line of defence behind that guard,
    // which a bypass or a cross-process race would reach with a value in hand.
    const id = repo.insertTask({
      title: 'Epic', description: null, priority: 'p2', assignee: 'boss', reporter: 'dev',
      depends_on: '[]', now: nowIso(), isEpic: true, projectId: testProjectId(repo)
    }).id
    const task = getTaskRow(db, id)
    expect(task.status).toBe('open')
    expect(task.is_epic).toBe(true)
    expect(task.assignee).toBeNull()
    expect(task.lease_expires_at).toBeNull()
  })

  test('a regular task still keeps its assignee', () => {
    const task = json(handleCreateTask(svc, { title: 'Task', reporter: 'dev', assignee: 'worker' })).id
    expect(getTaskRow(db, task)!.assignee).toBe('worker')
  })
})

describe('list_tasks is_epic filter', () => {
  test('is_epic=true returns only epic rows', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const regularId = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    const result = json(handleListTasks(svc, { is_epic: true }))
    const ids = result.tasks.map((t: any) => t.id)
    expect(ids).toContain(epicId)
    expect(ids).not.toContain(regularId)
    expect(result.total).toBe(1)
  })

  test('is_epic=false returns only non-epic rows', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const regularId = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    const result = json(handleListTasks(svc, { is_epic: false }))
    const ids = result.tasks.map((t: any) => t.id)
    expect(ids).toContain(regularId)
    expect(ids).not.toContain(epicId)
    expect(result.total).toBe(1)
  })

  test('is_epic=true combined with status filter', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' }))
    const openEpics = json(handleListTasks(svc, { is_epic: true, status: 'open' }))
    expect(openEpics.tasks.map((t: any) => t.id)).toContain(epicId)
    expect(openEpics.total).toBe(1)
    const queuedEpics = json(handleListTasks(svc, { is_epic: true, status: 'queued' }))
    expect(queuedEpics.total).toBe(0)
  })

  test('is_epic=false combined with status filter', () => {
    const regularId = json(handleCreateTask(svc, { title: 'Regular', reporter: 'dev' })).id
    json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true }))
    const queuedNonEpics = json(handleListTasks(svc, { is_epic: false, status: 'queued' }))
    expect(queuedNonEpics.tasks.map((t: any) => t.id)).toContain(regularId)
    expect(queuedNonEpics.total).toBe(1)
    const openNonEpics = json(handleListTasks(svc, { is_epic: false, status: 'open' }))
    expect(openNonEpics.total).toBe(0)
  })

  test('is_epic=false with epic_id returns the children', () => {
    const epicId = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id
    const subId = json(handleCreateTask(svc, { title: 'Sub', reporter: 'dev', epic_id: epicId })).id
    const nonEpics = json(handleListTasks(svc, { epic_id: epicId, is_epic: false }))
    expect(nonEpics.tasks.map((t: any) => t.id)).toContain(subId)
    expect(nonEpics.total).toBe(1)
    const epics = json(handleListTasks(svc, { epic_id: epicId, is_epic: true }))
    expect(epics.total).toBe(0)
  })

  test('is_epic filter respects project scoping', () => {
    seedProject(db, 'alpha')
    const alphaEpic = json(handleCreateTask(svc, { title: 'AlphaEpic', reporter: 'dev', project: 'alpha', epic: true })).id
    const alphaRegular = json(handleCreateTask(svc, { title: 'AlphaReg', reporter: 'dev', project: 'alpha' })).id
    const testEpic = json(handleCreateTask(svc, { title: 'TestEpic', reporter: 'dev', epic: true })).id
    const r = json(handleListTasks(svc, { project: 'alpha', is_epic: true }))
    const ids = r.tasks.map((t: any) => t.id)
    expect(ids).toContain(alphaEpic)
    expect(ids).not.toContain(alphaRegular)
    expect(ids).not.toContain(testEpic)
    expect(r.total).toBe(1)
    const r2 = json(handleListTasks(svc, { project: 'alpha', is_epic: false }))
    const ids2 = r2.tasks.map((t: any) => t.id)
    expect(ids2).toContain(alphaRegular)
    expect(ids2).not.toContain(alphaEpic)
    expect(r2.total).toBe(1)
  })
})
