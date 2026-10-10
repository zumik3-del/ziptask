import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { isValidTransition, nowIso } from './core/tasks'
import { TaskRepo } from './db/repo'
import { MetricsRepo } from './db/metrics-repo'
import { TaskService } from './core/service'
import { formatError } from './core/result'
import {
  handleCreateTask, handleGetTask, handleUpdateStatus, handleGetTimeline, handleListTasks
} from './mcp/tools'
import { createTestDb, closeTestDb, insertTaskRow, getTaskRow, json, text, driveToDone } from './test-context'

// F2 (#1065) lease heartbeat + F3 (#1066) attempts recovery, against the production symbols
// (isValidTransition, TaskService, TaskRepo — never a local double) and through the real reap seam
// TaskService.reapExpiredLeases(), so the reaper is the thing under test rather than a stub.

let db: Database
let repo: TaskRepo
let metrics: MetricsRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); metrics = new MetricsRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })
const createTaskRow = (title: string) => insertTaskRow(repo, { title, reporter: 'dev' })

const HOLDER = 'developer'
const HOUR_MS = 3600_000

const row = (id: number) => getTaskRow(db, id)
const versionOf = (id: number): number => json(handleGetTask(svc, { id, fields: ['version'] })).version
const leaseMs = (id: number): number => new Date(row(id).lease_expires_at).getTime()
// A full window from now: 14 min of slack under the 15 min lease_ttl_min. Comparing against the
// clock instead of the previous deadline keeps the assertion free of millisecond races, and it is
// strictly stronger than "changed": a stored deadline one second out can only become this if the
// renewal recomputed the window instead of nudging it.
const fullWindowFromNow = () => Date.now() + 14 * 60_000
// Simulates an elapsed TTL without a clock seam: only lease_expires_at moves, so version and
// attempts stay exactly where the production write left them.
const expireLease = (id: number) => { db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [new Date(Date.now() - HOUR_MS).toISOString(), id]) }
const pinLease = (id: number, msFromNow: number): string => { const iso = new Date(Date.now() + msFromNow).toISOString(); db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [iso, id]); return iso }
const auditActions = (id: number): string[] =>
  (db.query('SELECT action FROM audit_log WHERE task_id = ? ORDER BY id').all(id) as Array<{ action: string }>).map(r => r.action)
const countAudit = (id: number, action: string): number =>
  (db.query('SELECT COUNT(*) AS n FROM audit_log WHERE task_id = ? AND action = ?').get(id, action) as { n: number }).n
// get_timeline renders seq|type|agent|at|text, so the audit action lives in the text column.
const timelineField = (id: number, action: string, field: 'type' | 'agent' | 'text' = 'text'): string | undefined => {
  const cols = text(handleGetTimeline(svc, { id })).split('\n')
    .map(l => l.split('|'))
    .find(c => (c[4] ?? '').startsWith(`${action}:`))
  if (!cols) return undefined
  return cols[field === 'type' ? 1 : field === 'agent' ? 2 : 4]
}
const leaseField = (id: number, agent: string, version: number, extra: Record<string, unknown> = {}) =>
  handleUpdateStatus(svc, { id, agent, status: 'in_progress', renew: true, version, ...extra } as any)
const claimOrThrow = (id: number, agent: string) => {
  const res = svc.claimTask({ agent, taskId: id })
  if (!res.ok) throw new Error(`claimTask(${id}) failed: ${formatError(res.error)}`)
  return res.data
}
// the refusal text from the claim verb itself — the guard reuses it, so the two doors must agree
const claimError = (id: number, agent: string): string | undefined => {
  const res = svc.claimTask({ agent, taskId: id })
  return res.ok ? undefined : formatError(res.error)
}
// one #1013 round: a claim that is never finished costs exactly one attempt on the next sweep
const burnAttempt = (id: number, agent = 'developer') => {
  claimOrThrow(id, agent)
  expireLease(id)
  svc.reapExpiredLeases()
}
// A leased row the service can no longer produce: legacy, hand-edited, or rolled back. Written with
// the production statement shape (transitionStatus sets status/assignee/lease_expires_at in one UPDATE),
// so the sweep and the renewal guard meet a row the database could really hold.
const seedLease = (id: number, holder: string, msFromNow: number) => {
  db.run("UPDATE tasks SET status = 'in_progress', assignee = ?, lease_expires_at = ?, version = version + 1 WHERE id = ?",
    [holder, new Date(Date.now() + msFromNow).toISOString(), id])
  return id
}
const seedLeasedEpic = (title: string, holder: string, msFromNow = 15 * 60_000) =>
  seedLease(json(handleCreateTask(svc, { title, reporter: 'dev', epic: true })).id as number, holder, msFromNow)
const seedReview = (id: number) => {
  db.run("UPDATE tasks SET status = 'review', version = version + 1 WHERE id = ?", [id])
  return id
}
const createDepTask = (title: string, depends_on: number[]) =>
  insertTaskRow(repo, { title, reporter: 'dev', depends_on })

describe('lease heartbeat: update_status renew (F2 #1065)', () => {
  test('a heartbeat re-arms the lease and moves nothing but the version', () => {
    const id = createTaskRow('Heartbeat')
    claimOrThrow(id, HOLDER)
    const before = row(id)
    // The stored deadline is one second out: a renewal that nudged or kept it could not reach a
    // full window, so the post-condition below cannot be met by any clock coincidence. The
    // not-equal is checked against the pinned value, not the claim's — the claim and the renewal
    // share the now + lease_ttl_min formula and would agree to the millisecond.
    const pinned = pinLease(id, 1000)

    const res = handleUpdateStatus(svc, { id, agent: HOLDER, status: 'in_progress', renew: true, version: before.version })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, status: 'in_progress', version: before.version + 1 })

    const after = row(id)
    expect(after.status).toBe('in_progress')
    expect(after.attempts).toBe(0)
    expect(after.assignee).toBe(HOLDER)
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
    expect(after.lease_expires_at).not.toBe(pinned)
  })

  test('the renewal window is recomputed from now, never added to the stored deadline', () => {
    // A deadline far in the future is what unbounded creep (old + TTL per heartbeat) would
    // produce; after a renewal the window must be ~now + lease_ttl_min instead.
    const id = createTaskRow('FixedWindow')
    claimOrThrow(id, HOLDER)
    const creeped = new Date(Date.now() + 10 * 24 * HOUR_MS).toISOString()
    db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [creeped, id])

    const res = leaseField(id, HOLDER, versionOf(id))
    expect(res.isError).toBeUndefined()

    const renewed = leaseMs(id)
    expect(renewed).toBeLessThan(new Date(creeped).getTime())
    expect(renewed).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5000)
  })

  test('repeated heartbeats are never requeued by the reap and never spend an attempt', () => {
    const id = createTaskRow('Long')
    const control = createTaskRow('Silent')
    claimOrThrow(id, HOLDER)
    claimOrThrow(control, HOLDER)
    // The heartbeating task's window is already almost spent, as it would be at the end of a TTL.
    pinLease(id, 1000)

    for (let beat = 0; beat < 3; beat++) {
      const res = leaseField(id, HOLDER, versionOf(id))
      expect(json(res).version).toBe(versionOf(id))
      svc.reapExpiredLeases()
      expect(row(id).status).toBe('in_progress')
      expect(row(id).attempts).toBe(0)
      expect(row(id).lease_expires_at).not.toBeNull()
      expect(countAudit(id, 'lease_renewed')).toBe(beat + 1)
    }

    // Same sweep, same second: a task whose lease really did elapse is requeued and charged, so
    // the survival above is the renewal's doing and not an inert sweep.
    expireLease(control)
    svc.reapExpiredLeases()
    expect(row(control).status).toBe('queued')
    expect(row(control).attempts).toBe(1)

    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
    expect(countAudit(id, 'lease_renewed')).toBe(3)
    expect(countAudit(id, 'update_status')).toBe(0)
  })

  test('in_progress → in_progress without renew is an error, not a silent lease bump', () => {
    const id = createTaskRow('NoFlag')
    claimOrThrow(id, HOLDER)
    const before = row(id)

    const res = handleUpdateStatus(svc, { id, agent: HOLDER, status: 'in_progress', version: before.version })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: in_progress → in_progress requires renew: true')

    const after = row(id)
    expect(after.version).toBe(before.version)
    expect(after.attempts).toBe(before.attempts)
    expect(after.lease_expires_at).toBe(before.lease_expires_at)
    expect(after.status).toBe('in_progress')
    expect(countAudit(id, 'lease_renewed')).toBe(0)
  })

  test('renew off the in_progress → in_progress edge is refused with exact text, state untouched', () => {
    const id = createTaskRow('WrongTarget')
    claimOrThrow(id, HOLDER)
    const before = row(id)

    const review = leaseField(id, HOLDER, before.version, { status: 'review' })
    expect(text(review)).toBe('INVALID: renew requires status=in_progress on an in_progress task')
    expect(row(id).status).toBe('in_progress')
    expect(row(id).version).toBe(before.version)

    const queued = createTaskRow('Queued')
    const queuedBefore = row(queued)
    const queuedRenew = leaseField(queued, HOLDER, queuedBefore.version)
    expect(text(queuedRenew)).toBe('INVALID: renew requires status=in_progress on an in_progress task')
    expect(row(queued).status).toBe('queued')
    expect(row(queued).lease_expires_at).toBeNull()
    expect(row(queued).assignee).toBeNull()
  })

  test('only the holder may renew: a non-holder gets CONFLICT, the holder succeeds', () => {
    const id = createTaskRow('Guard')
    claimOrThrow(id, HOLDER)
    const before = row(id)

    const foreign = leaseField(id, 'tester', before.version)
    expect(foreign.isError).toBe(true)
    expect(text(foreign)).toBe(`CONFLICT: lease held by ${HOLDER}`)
    expect(row(id).version).toBe(before.version)
    expect(row(id).lease_expires_at).toBe(before.lease_expires_at)
    expect(row(id).attempts).toBe(0)
    expect(countAudit(id, 'lease_renewed')).toBe(0)

    // Same call, holder name: the guard discriminates on identity, not on the call shape.
    const own = leaseField(id, HOLDER, before.version)
    expect(own.isError).toBeUndefined()
    expect(json(own).status).toBe('in_progress')
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
  })

  test('the holder guard is scoped to renewal: any agent can still drive a non-renewal transition', () => {
    const id = createTaskRow('Unguarded')
    claimOrThrow(id, HOLDER)
    const res = handleUpdateStatus(svc, { id, agent: 'tester', status: 'review', version: versionOf(id) })
    expect(json(res).status).toBe('review')
  })

  test('a stale version on a heartbeat is refused by the optimistic lock', () => {
    const id = createTaskRow('Stale')
    claimOrThrow(id, HOLDER)
    const stale = versionOf(id) - 1

    const res = leaseField(id, HOLDER, stale)
    expect(text(res)).toBe(`CONFLICT: expected version ${versionOf(id)}, got ${stale}`)
    expect(countAudit(id, 'lease_renewed')).toBe(0)
  })

  test('a late heartbeat cannot resurrect a reaped lease; it costs one attempt and the re-claim recovers', () => {
    // The #1013 accident shape. _doReap() runs inside updateStatus, so the sweep happens before
    // the transition is evaluated: the renewal is fenced, not merely late.
    const id = createTaskRow('Late')
    claimOrThrow(id, HOLDER)
    const held = versionOf(id)
    expireLease(id)

    const late = leaseField(id, HOLDER, held)
    expect(text(late)).toBe(`CONFLICT: expected version ${held + 1}, got ${held}`)

    const reaped = row(id)
    expect(reaped.status).toBe('queued')
    expect(reaped.attempts).toBe(1)
    expect(reaped.lease_expires_at).toBeNull()

    const retry = leaseField(id, HOLDER, reaped.version)
    expect(text(retry)).toBe('INVALID: renew requires status=in_progress on an in_progress task')
    expect(row(id).status).toBe('queued')
    expect(row(id).attempts).toBe(1)
    expect(row(id).lease_expires_at).toBeNull()
    expect(countAudit(id, 'lease_renewed')).toBe(0)

    expect(claimOrThrow(id, HOLDER).id).toBe(id)
    expect(row(id).status).toBe('in_progress')
  })

  test('a heartbeat on an epic is refused (epics have no lease semantics)', () => {
    // The in_progress acquisition guard makes a leased epic unreachable through the service, so the
    // renewal-path epic refusal is only reachable from a legacy or hand-edited in_progress epic row.
    // Seeded through the store fixture (the production write), never through update_status.
    const epic = seedLeasedEpic('Epic', HOLDER)
    const before = row(epic)
    expect(before.is_epic).toBe(true)
    expect(before.status).toBe('in_progress')

    const res = leaseField(epic, HOLDER, before.version)
    expect(text(res)).toBe(`INVALID: #${epic} is an epic`)
    expect(row(epic).version).toBe(before.version)
    expect(row(epic).lease_expires_at).toBe(before.lease_expires_at)
    expect(countAudit(epic, 'lease_renewed')).toBe(0)
  })

  test('blocked → in_progress makes the mover the holder, so the new holder can renew', () => {
    const id = createTaskRow('Takeover')
    claimOrThrow(id, HOLDER)
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'blocked', version: versionOf(id) })

    const taken = handleUpdateStatus(svc, { id, agent: 'orchestrator', status: 'in_progress', version: versionOf(id) })
    expect(json(taken).status).toBe('in_progress')
    expect(row(id).assignee).toBe('orchestrator')
    expect(row(id).lease_expires_at).not.toBeNull()

    const res = leaseField(id, 'orchestrator', versionOf(id))
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('in_progress')
  })

  test('a pure renewal audits as lease_renewed <old iso>-><new iso>, never as update_status', () => {
    const id = createTaskRow('Audit')
    claimOrThrow(id, HOLDER)
    const before = row(id).lease_expires_at

    leaseField(id, HOLDER, versionOf(id))
    const after = row(id).lease_expires_at

    expect(timelineField(id, 'lease_renewed')).toBe(`lease_renewed: ${before}->${after}`)
    expect(timelineField(id, 'lease_renewed', 'agent')).toBe(HOLDER)
    expect(timelineField(id, 'lease_renewed', 'type')).toBe('action')
    expect(timelineField(id, 'update_status')).toBeUndefined()
    expect(countAudit(id, 'update_status')).toBe(0)
  })

  test('repeated renewals keep assignee with the holder and stay on the same row', () => {
    const id = createTaskRow('KeepHolder')
    claimOrThrow(id, HOLDER)
    for (let beat = 0; beat < 2; beat++) {
      const res = leaseField(id, HOLDER, versionOf(id))
      expect(res.isError).toBeUndefined()
      expect(json(res).status).toBe('in_progress')
    }
    expect(row(id).assignee).toBe(HOLDER)
    expect(countAudit(id, 'lease_renewed')).toBe(2)
    expect(isValidTransition(row(id).status, 'review')).toBe(true)
  })
})

describe('attempts recovery: update_status reset_attempts (F3 #1066)', () => {
  test('the #1013 shape: attempts 3/3 parked in blocked is refunded to queued in one call', () => {
    const id = createTaskRow('Budget')
    for (let round = 0; round < 3; round++) burnAttempt(id)
    expect(row(id).attempts).toBe(3)
    expect(row(id).max_attempts).toBe(3)
    expect(row(id).status).toBe('queued')

    const parked = handleUpdateStatus(svc, { id, agent: 'operator', status: 'blocked', version: versionOf(id) })
    expect(json(parked).status).toBe('blocked')

    const before = row(id).attempts
    const res = handleUpdateStatus(svc, {
      id, agent: 'operator', status: 'queued', version: versionOf(id), reset_attempts: true,
      comment: 'attempts spent on accidental claims, not on work'
    })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, status: 'queued', version: row(id).version, attempts: 0 })

    expect(row(id).status).toBe('queued')
    expect(row(id).attempts).toBe(0)
    expect(row(id).max_attempts).toBe(3)
    expect(before).toBe(3)

    expect(timelineField(id, 'attempts_reset')).toBe('attempts_reset: 3->0')
    expect(timelineField(id, 'attempts_reset', 'agent')).toBe('operator')
  })

  test('reset_attempts without a comment is refused before anything is touched', () => {
    const id = createTaskRow('NoReason')
    burnAttempt(id)
    handleUpdateStatus(svc, { id, agent: 'operator', status: 'blocked', version: versionOf(id) })
    const before = row(id)

    const missing = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: before.version, reset_attempts: true })
    expect(text(missing)).toBe('INVALID: reset_attempts requires a comment')

    const blank = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: before.version, reset_attempts: true, comment: '   ' })
    expect(text(blank)).toBe('INVALID: content required')

    const after = row(id)
    expect(after.status).toBe('blocked')
    expect(after.attempts).toBe(before.attempts)
    expect(after.version).toBe(before.version)
    expect(countAudit(id, 'attempts_reset')).toBe(0)
  })

  test('terminal tasks are unreachable by a refund (no new guard, no reopened terminal)', () => {
    const cases: Array<{ title: string; drive: (id: number) => void }> = [
      { title: 'Done', drive: (id) => { claimOrThrow(id, HOLDER); handleUpdateStatus(svc, { id, agent: HOLDER, status: 'review', version: versionOf(id) }); handleUpdateStatus(svc, { id, agent: HOLDER, status: 'done', version: versionOf(id) }) } },
      { title: 'Canceled', drive: (id) => { handleUpdateStatus(svc, { id, agent: HOLDER, status: 'canceled', version: versionOf(id) }) } },
      { title: 'Failed', drive: (id) => { burnAttempt(id); burnAttempt(id); burnAttempt(id); burnAttempt(id) } }
    ]

    for (const c of cases) {
      const id = createTaskRow(c.title)
      c.drive(id)
      expect(row(id).status).toBe(c.title.toLowerCase())

      const res = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: versionOf(id), reset_attempts: true, comment: 'please' })
      expect(`${c.title}: ${text(res)}`).toBe(`${c.title}: INVALID: ${row(id).status} → queued`)
      expect(`${c.title}: ${row(id).attempts}`).toBe(`${c.title}: ${c.title === 'Failed' ? 4 : 0}`)
      expect(countAudit(id, 'attempts_reset')).toBe(0)
      expect(isValidTransition(row(id).status, 'queued')).toBe(false)
    }
  })

  test('a stale version on the refund path is refused and the budget is untouched', () => {
    const id = createTaskRow('StaleRefund')
    burnAttempt(id)
    burnAttempt(id)
    handleUpdateStatus(svc, { id, agent: 'operator', status: 'blocked', version: versionOf(id) })
    const before = row(id)
    const stale = before.version - 1

    const res = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: stale, reset_attempts: true, comment: 'accidental claims' })
    expect(text(res)).toBe(`CONFLICT: expected version ${before.version}, got ${stale}`)
    expect(row(id).attempts).toBe(before.attempts)
    expect(row(id).status).toBe('blocked')
    expect(row(id).version).toBe(before.version)
  })

  test('reset_attempts on an epic is refused (its attempts are always 0)', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    // no in_progress on-ramp (an epic is never leased): refund the epic from queued through blocked
    const before = row(epic)
    expect(before.status).toBe('queued')
    expect(before.attempts).toBe(0)

    const res = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'blocked', version: before.version, reset_attempts: true, comment: 'why' })
    expect(text(res)).toBe(`INVALID: cannot reset attempts on epic #${epic}`)
    expect(row(epic).status).toBe('queued')
    expect(row(epic).attempts).toBe(0)
    expect(row(epic).version).toBe(before.version)
    expect(countAudit(epic, 'attempts_reset')).toBe(0)
  })

  test('combined renew + reset_attempts: lease re-armed, attempts zeroed, audited as lease_renewed + attempts_reset', () => {
    const id = createTaskRow('Combined')
    burnAttempt(id)
    burnAttempt(id)
    burnAttempt(id)
    claimOrThrow(id, HOLDER)
    expect(row(id).attempts).toBe(3)
    pinLease(id, 1000)

    const res = leaseField(id, HOLDER, versionOf(id), { reset_attempts: true, comment: 'still working, the budget went on accidents' })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, status: 'in_progress', version: versionOf(id), attempts: 0 })

    expect(row(id).status).toBe('in_progress')
    expect(row(id).attempts).toBe(0)
    expect(row(id).max_attempts).toBe(3)
    expect(row(id).assignee).toBe(HOLDER)
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())

    expect(countAudit(id, 'lease_renewed')).toBe(1)
    expect(countAudit(id, 'attempts_reset')).toBe(1)
    expect(countAudit(id, 'update_status')).toBe(0)
  })

  test('#1013 replay: three expiries leave attempts 3/3, the task is still claimable, and only a refund restores headroom', () => {
    const id = createTaskRow('Replay')
    for (let round = 0; round < 3; round++) burnAttempt(id)

    expect(row(id).attempts).toBe(3)
    expect(row(id).max_attempts).toBe(3)
    expect(row(id).status).toBe('queued')
    expect(auditActions(id)).toEqual([
      'claim', 'lease_expired', 'claim', 'lease_expired', 'claim', 'lease_expired'
    ])

    // attempts never locks a task out: the budget is charged by the reap, so the task is one
    // expiry from `failed` and still claimable.
    claimOrThrow(id, HOLDER)
    expireLease(id)
    svc.reapExpiredLeases()
    expect(row(id).status).toBe('failed')
    expect(row(id).attempts).toBe(4)

    const doomed = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: versionOf(id), reset_attempts: true, comment: 'one more chance' })
    expect(text(doomed)).toBe('INVALID: failed → queued')
  })

  test('after a refund an expiry requeues instead of failing', () => {
    const id = createTaskRow('Refunded')
    for (let round = 0; round < 3; round++) burnAttempt(id)
    handleUpdateStatus(svc, { id, agent: 'operator', status: 'blocked', version: versionOf(id) })
    handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: versionOf(id), reset_attempts: true, comment: 'accidental claims' })
    expect(row(id).attempts).toBe(0)

    claimOrThrow(id, HOLDER)
    expireLease(id)
    svc.reapExpiredLeases()
    expect(row(id).status).toBe('queued')
    expect(row(id).attempts).toBe(1)
    expect(row(id).max_attempts).toBe(3)
  })

  test('a queued task needs a park through blocked (queued → queued is not an edge)', () => {
    const id = createTaskRow('Park')
    burnAttempt(id)
    const refused = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: versionOf(id), reset_attempts: true, comment: 'refund' })
    expect(text(refused)).toBe('INVALID: queued → queued')

    handleUpdateStatus(svc, { id, agent: 'operator', status: 'blocked', version: versionOf(id) })
    const refunded = handleUpdateStatus(svc, { id, agent: 'operator', status: 'queued', version: versionOf(id), reset_attempts: true, comment: 'refund' })
    expect(json(refunded)).toEqual({ id, status: 'queued', version: versionOf(id), attempts: 0 })
  })

  test('a refund without reset_attempts never zeroes attempts', () => {
    const id = createTaskRow('Plain')
    burnAttempt(id)
    burnAttempt(id)

    const plain = handleUpdateStatus(svc, { id, agent: 'operator', status: 'blocked', version: versionOf(id), comment: 'parking it' })
    expect('attempts' in json(plain)).toBe(false)
    expect(row(id).attempts).toBe(2)

    const flagged = handleUpdateStatus(svc, { id, agent: 'operator', status: 'in_progress', version: versionOf(id) })
    expect('attempts' in json(flagged)).toBe(false)
    expect(row(id).attempts).toBe(2)
  })
})

describe('reaper policy: a heartbeat is liveness, not progress (D-F3-5)', () => {
  test('a heartbeating task whose lease expires still pays the attempt', () => {
    const id = createTaskRow('Alive')
    claimOrThrow(id, HOLDER)
    leaseField(id, HOLDER, versionOf(id))
    leaseField(id, HOLDER, versionOf(id))
    expect(countAudit(id, 'lease_renewed')).toBe(2)

    expireLease(id)
    svc.reapExpiredLeases()

    const reaped = row(id)
    expect(reaped.status).toBe('queued')
    expect(reaped.attempts).toBe(1)
    expect(reaped.lease_expires_at).toBeNull()
    expect(countAudit(id, 'lease_expired')).toBe(1)
  })

  test('renew alone never zeroes attempts (the charge is not the holder\'s to forgive)', () => {
    const id = createTaskRow('SilentBudget')
    burnAttempt(id)
    burnAttempt(id)
    claimOrThrow(id, HOLDER)
    expect(row(id).attempts).toBe(2)

    for (let beat = 0; beat < 2; beat++) {
      const res = leaseField(id, HOLDER, versionOf(id))
      expect(res.isError).toBeUndefined()
      expect(json(res).status).toBe('in_progress')
      expect(row(id).attempts).toBe(2)
    }
    expect(countAudit(id, 'lease_renewed')).toBe(2)
    expect(countAudit(id, 'attempts_reset')).toBe(0)
  })

  test('heartbeats do not extend the budget: a working-but-silent task still lands in failed', () => {
    const id = createTaskRow('Zombie')
    // Four rounds of honest work + heartbeats, each followed by silence: the budget is four
    // expiries deep and the fourth is fatal, heartbeats or not.
    for (let beat = 0; beat < 4; beat++) {
      claimOrThrow(id, HOLDER)
      leaseField(id, HOLDER, versionOf(id))
      expireLease(id)
      svc.reapExpiredLeases()
    }
    expect(row(id).status).toBe('failed')
    expect(row(id).attempts).toBe(4)
    expect(countAudit(id, 'lease_renewed')).toBe(4)
  })
})

describe('metrics: a heartbeat must not cut the in_progress segment (D-F2-3)', () => {
  // statusDurations builds segments from audit actions claim/update_status/lease_expired and reads
  // new_value as the status. Timestamps are pinned to a synthetic day so the minutes are exact;
  // the actions under test are the ones the production heartbeat really wrote.
  const DAY = '2020-01-01T'
  function retime(id: number): void {
    const stamp = (action: string, at: string, nth = 0) => {
      const rows = db.query('SELECT id FROM audit_log WHERE task_id = ? AND action = ? ORDER BY id').all(id, action) as Array<{ id: number }>
      if (rows[nth]) db.run('UPDATE audit_log SET created_at = ? WHERE id = ?', [at, rows[nth].id])
    }
    stamp('create', `${DAY}00:00:00.000Z`)
    stamp('claim', `${DAY}00:10:00.000Z`)
    stamp('update_status', `${DAY}00:40:00.000Z`, 0)
    stamp('update_status', `${DAY}00:50:00.000Z`, 1)
    db.run('UPDATE tasks SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      [`${DAY}00:00:00.000Z`, `${DAY}00:50:00.000Z`, `${DAY}00:50:00.000Z`, id])
  }
  const driveToDone = (id: number, beats: number) => {
    claimOrThrow(id, HOLDER)
    for (let beat = 0; beat < beats; beat++) leaseField(id, HOLDER, versionOf(id))
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'review', version: versionOf(id) })
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'done', version: versionOf(id) })
    retime(id)
  }
  const durations = () => Object.fromEntries(
    metrics.statusDurations('0000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')
      .map(r => [r.status, Math.round(r.minutes)])
  )
  const SYNTHETIC = { queued: 10, in_progress: 30, review: 10 }

  test('baseline: a task that never heartbeats owns 30 in_progress minutes', () => {
    const quiet = createTaskRow('Quiet')
    driveToDone(quiet, 0)

    expect(countAudit(quiet, 'lease_renewed')).toBe(0)
    expect(auditActions(quiet)).toEqual(['claim', 'update_status', 'update_status'])
    expect(durations()).toEqual(SYNTHETIC)
  })

  test('three heartbeats leave the same in_progress minutes (no new segment, no bogus status)', () => {
    const beating = createTaskRow('Beating')
    driveToDone(beating, 3)

    expect(countAudit(beating, 'lease_renewed')).toBe(3)
    expect(countAudit(beating, 'update_status')).toBe(2)
    expect(auditActions(beating)).toEqual(['claim', 'lease_renewed', 'lease_renewed', 'lease_renewed', 'update_status', 'update_status'])
    // A lease_renewed row audited as update_status would carry an ISO lease as new_value, i.e. a
    // status name that does not exist and a 5-minute in_progress segment instead of 30.
    expect(durations()).toEqual(SYNTHETIC)
  })

  test('a lease_renewed audit row is invisible to statusDurations by action name', () => {
    const id = createTaskRow('OnlyHeartbeats')
    claimOrThrow(id, HOLDER)
    leaseField(id, HOLDER, versionOf(id))
    retime(id)

    const rows = metrics.statusDurations('0000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')
    expect(countAudit(id, 'lease_renewed')).toBe(1)
    expect(rows.map(r => r.status).sort()).toEqual(['in_progress', 'queued'])
    // in_progress started at 00:10 and is still open, so the only minutes it can own are the
    // 30 minutes up to the (real-now) clamp — never a heartbeat-shaped extra segment.
    expect(Math.round(rows.find(r => r.status === 'in_progress')!.minutes)).toBeGreaterThanOrEqual(30)
  })

  test('a refused acquisition contributes no in_progress minutes', () => {
    // The metrics window is a parameter, so the in_progress segment a *successful* acquisition would
    // have opened is exactly one hour wide: the control's 30 are all a refusal can leave behind.
    const control = createTaskRow('Control')
    driveToDone(control, 0)
    expect(durations()).toEqual(SYNTHETIC)

    const dep = createTaskRow('Dep')
    const subject = createDepTask('Subject', [dep])
    db.run("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?", [`${DAY}00:00:00.000Z`, `${DAY}00:00:00.000Z`, subject])

    const refused = handleUpdateStatus(svc, { id: subject, agent: HOLDER, status: 'in_progress', version: versionOf(subject) })
    expect(text(refused)).toBe('BLOCKED: dependencies not satisfied')
    expect(countAudit(subject, 'update_status')).toBe(0)

    const rows = metrics.statusDurations('0000-01-01T00:00:00.000Z', new Date(Date.now() + 3600_000).toISOString())
    expect(Math.round(rows.find(r => r.status === 'in_progress')!.minutes)).toBe(30)
  })
})

describe('reap invariants untouched by F2/F3 (D-F3-5: zero diff in _doReap)', () => {
  test('one expiry costs exactly one attempt and never refunds itself', () => {
    const id = createTaskRow('Charge')
    claimOrThrow(id, HOLDER)
    expireLease(id)
    svc.reapExpiredLeases()
    expect(row(id).attempts).toBe(1)

    claimOrThrow(id, HOLDER)
    expireLease(id)
    svc.reapExpiredLeases()
    expect(row(id).attempts).toBe(2)

    const expired = db.query('SELECT old_value, new_value FROM audit_log WHERE task_id = ? AND action = ?').all(id, 'lease_expired') as any[]
    expect(expired.map(r => r.new_value)).toEqual(['queued', 'queued'])
  })

  test('a renewal never advances attempts, max_attempts or completed_at', () => {
    const id = createTaskRow('Untouched')
    claimOrThrow(id, HOLDER)
    const before = row(id)
    expect(before.max_attempts).toBe(3)

    const res = leaseField(id, HOLDER, versionOf(id))
    expect(res.isError).toBeUndefined()
    expect(countAudit(id, 'lease_renewed')).toBe(1)

    const after = row(id)
    expect(after.attempts).toBe(before.attempts)
    expect(after.max_attempts).toBe(before.max_attempts)
    expect(after.completed_at).toBeNull()
    expect(after.lease_expires_at).not.toBeNull()
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
  })

  test('a heartbeat is an ordinary version-locked write (version and updated_at move, lease_ttl_min is not a parameter)', () => {
    const id = createTaskRow('Stamp')
    claimOrThrow(id, HOLDER)
    const before = row(id)

    const res = leaseField(id, HOLDER, before.version)
    expect(res.isError).toBeUndefined()
    expect(json(res).version).toBe(before.version + 1)
    expect(row(id).updated_at >= before.updated_at).toBe(true)
    expect(nowIso() > row(id).created_at).toBe(true)
  })
})

// Lease acquisition through update_status is claim-verb work: for a non-self-edge entry into
// in_progress the guard demands claim-grade eligibility (not an epic; deps satisfied from
// queued/blocked), reusing claimTask's two error strings verbatim. review → in_progress is a
// deliberate superset: work sent back is exactly the sanctioned case, and its deps are provably
// still satisfied (depends_on is immutable after create, terminals have no outgoing edge).
describe('acquiring a lease: update_status → in_progress needs claim-grade eligibility', () => {
  const HOUR = 3600_000

  // A dep-blocked pair: the dep is queued, so the dependant is invisible to list_queue and
  // un-claimable, yet still queued/blocked — the exact shape the door used to exploit.
  const depBlockedPair = () => {
    const dep = createTaskRow('Dep')
    const blocked = createDepTask('Dependent', [dep])
    expect(json(handleGetTask(svc, { id: blocked, fields: ['blocked_by'] })).blocked_by).toEqual([dep])
    return { dep, blocked }
  }

  test('an epic is refused on queued → in_progress, and the row does not move', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const before = row(epic)

    const res = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'in_progress', version: before.version })
    expect(text(res)).toBe(`INVALID: #${epic} is an epic, not claimable`)

    const after = row(epic)
    expect(after.status).toBe('queued')
    expect(after.version).toBe(before.version)
    expect(after.lease_expires_at).toBeNull()
    expect(after.assignee).toBeNull()
    expect(countAudit(epic, 'update_status')).toBe(0)
    // one wording, two call sites: identical to what claim_task says about the same row
    expect(claimError(epic, 'orchestrator')).toBe(`INVALID: #${epic} is an epic, not claimable`)
  })

  test('an epic is refused on blocked → in_progress too (the guard is not queued-only)', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const parked = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'blocked', version: versionOf(epic) })
    expect(json(parked).status).toBe('blocked')
    const before = row(epic)
    // the park is a real transition, so the baseline is what it wrote — the refusal must add nothing
    const auditBefore = auditActions(epic)
    expect(auditBefore).toEqual(['create', 'update_status'])

    const res = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'in_progress', version: before.version })
    expect(text(res)).toBe(`INVALID: #${epic} is an epic, not claimable`)
    expect(row(epic).status).toBe('blocked')
    expect(row(epic).version).toBe(before.version)
    expect(row(epic).lease_expires_at).toBeNull()
    expect(auditActions(epic)).toEqual(auditBefore)
    expect(countAudit(epic, 'lease_renewed')).toBe(0)
  })

  test('unsatisfied deps are refused on queued → in_progress, and the row does not move', () => {
    const { blocked } = depBlockedPair()
    const before = row(blocked)

    const res = handleUpdateStatus(svc, { id: blocked, agent: HOLDER, status: 'in_progress', version: before.version })
    expect(text(res)).toBe('BLOCKED: dependencies not satisfied')

    const after = row(blocked)
    expect(after.status).toBe('queued')
    expect(after.version).toBe(before.version)
    expect(after.lease_expires_at).toBeNull()
    expect(after.assignee).toBeNull()
    expect(after.attempts).toBe(0)
    expect(countAudit(blocked, 'update_status')).toBe(0)
    // the claim-verb agrees, word for word
    expect(claimError(blocked, HOLDER)).toBe('BLOCKED: dependencies not satisfied')
  })

  test('unsatisfied deps are refused on blocked → in_progress as well', () => {
    const { blocked } = depBlockedPair()
    const parked = handleUpdateStatus(svc, { id: blocked, agent: HOLDER, status: 'blocked', version: versionOf(blocked) })
    expect(json(parked).status).toBe('blocked')
    const before = row(blocked)
    const auditBefore = auditActions(blocked)

    const res = handleUpdateStatus(svc, { id: blocked, agent: HOLDER, status: 'in_progress', version: before.version })
    expect(text(res)).toBe('BLOCKED: dependencies not satisfied')
    expect(row(blocked).status).toBe('blocked')
    expect(row(blocked).version).toBe(before.version)
    expect(row(blocked).lease_expires_at).toBeNull()
    expect(auditActions(blocked)).toEqual(auditBefore)
    expect(countAudit(blocked, 'lease_renewed')).toBe(0)
  })

  test('a dep-blocked task refused at acquisition stays in list_queue terms: still un-claimable, still no attempt', () => {
    const { dep, blocked } = depBlockedPair()
    handleUpdateStatus(svc, { id: blocked, agent: HOLDER, status: 'in_progress', version: versionOf(blocked) })

    expect(claimError(blocked, HOLDER)).toBe('BLOCKED: dependencies not satisfied')
    svc.reapExpiredLeases()
    expect(row(blocked).status).toBe('queued')
    expect(row(blocked).attempts).toBe(0)
    expect(row(blocked).lease_expires_at).toBeNull()
    // and it is claimable the moment the dep closes — the door is closed, not the task
    driveToDone(svc, dep, HOLDER)
    expect(claimOrThrow(blocked, HOLDER).id).toBe(blocked)
  })

  test('a claim-eligible dependant still acquires the lease: satisfied deps, no epic, lease granted', () => {
    const dep = createTaskRow('Dep')
    driveToDone(svc, dep, HOLDER)
    const ready = createDepTask('Ready', [dep])

    const res = handleUpdateStatus(svc, { id: ready, agent: HOLDER, status: 'in_progress', version: versionOf(ready) })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('in_progress')
    expect(row(ready).lease_expires_at).not.toBeNull()
    expect(row(ready).assignee).toBe(HOLDER)
    expect(leaseMs(ready)).toBeGreaterThan(fullWindowFromNow())
    expect(countAudit(ready, 'update_status')).toBe(1)
  })

  test('a dep-free task still acquires the lease (the common case: no deps to ask about)', () => {
    const id = createTaskRow('Plain')
    const res = handleUpdateStatus(svc, { id, agent: HOLDER, status: 'in_progress', version: versionOf(id) })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('in_progress')
    expect(row(id).lease_expires_at).not.toBeNull()
    expect(row(id).assignee).toBe(HOLDER)
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
  })

  test('the sweep ignores a legacy leased epic row: stranded in in_progress, never charged, never killed', () => {
    // Defence in depth (expiredLeases carries is_epic = 0). A leased epic is unreachable through the
    // service now, so this row is seeded directly — the case a rolled-back deploy or a hand-edit makes.
    const epic = seedLeasedEpic('LegacyEpic', 'orchestrator', -HOUR)
    const before = row(epic)
    // Control: a real task in the same state, so the sweep below is provably live, not inert.
    const control = seedLease(createTaskRow('Control'), HOLDER, -HOUR)

    svc.reapExpiredLeases()

    expect(row(control).status).toBe('queued')
    expect(row(control).attempts).toBe(1)
    const after = row(epic)
    expect(after.status).toBe('in_progress')
    expect(after.attempts).toBe(before.attempts)
    expect(after.lease_expires_at).toBe(before.lease_expires_at)
    expect(after.assignee).toBe('orchestrator')
    expect(countAudit(epic, 'lease_expired')).toBe(0)
  })

  test('renewal on that legacy epic row is still refused, and it never renews into a longer life', () => {
    const epic = seedLeasedEpic('LegacyEpic', 'orchestrator', -HOUR)
    const before = row(epic)

    for (let beat = 0; beat < 2; beat++) {
      const res = leaseField(epic, 'orchestrator', versionOf(epic))
      expect(text(res)).toBe(`INVALID: #${epic} is an epic`)
    }
    expect(row(epic).version).toBe(before.version)
    expect(row(epic).lease_expires_at).toBe(before.lease_expires_at)
    expect(countAudit(epic, 'lease_renewed')).toBe(0)

    // the honest cost of the belt: stranded-and-visible, not terminal. It is listed, and a single
    // non-leased hop releases it.
    expect(json(handleListTasks(svc, { status: 'in_progress' })).tasks.map((t: any) => t.id)).toContain(epic)
    const freed = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'blocked', version: versionOf(epic) })
    expect(json(freed).status).toBe('blocked')
  })

  test('a refused acquisition writes no audit row at all — no update_status, no lease_renewed, no attempts_reset', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const { blocked } = depBlockedPair()
    const auditSnapshot = (id: number) => auditActions(id)

    const epicBefore = auditSnapshot(epic)
    const blockedBefore = auditSnapshot(blocked)
    handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'in_progress', version: versionOf(epic) })
    handleUpdateStatus(svc, { id: blocked, agent: HOLDER, status: 'in_progress', version: versionOf(blocked) })

    for (const id of [epic, blocked]) {
      expect(auditActions(id)).toEqual(id === epic ? epicBefore : blockedBefore)
      expect(countAudit(id, 'update_status')).toBe(0)
      expect(countAudit(id, 'lease_renewed')).toBe(0)
      expect(countAudit(id, 'attempts_reset')).toBe(0)
    }
    // the timeline is the free detection surface for "acquired without claim": no claim row, no
    // update_status row, and the row is not in_progress
    expect(text(handleGetTimeline(svc, { id: epic }))).not.toContain('update_status: queued->in_progress')
    expect(row(epic).status).toBe('queued')
  })

  test('refund on an epic stays refused with no state change, and there is no in-progress on-ramp left', () => {
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const before = row(epic)

    const res = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'blocked', version: before.version, reset_attempts: true, comment: 'why' })
    expect(text(res)).toBe(`INVALID: cannot reset attempts on epic #${epic}`)
    expect(row(epic).status).toBe('queued')
    expect(row(epic).attempts).toBe(0)
    expect(row(epic).version).toBe(before.version)
    expect(countAudit(epic, 'attempts_reset')).toBe(0)
    expect(auditActions(epic)).toEqual(['create'])
  })

  test('the acquisition guard sits above the refund branch, so the combined shape reports the acquisition', () => {
    // update_status(epic, in_progress, reset_attempts) is two requests in one call and the
    // acquisition is the stronger claim: it is refused for not being claimable, not for the refund.
    const epic = json(handleCreateTask(svc, { title: 'Epic', reporter: 'dev', epic: true })).id as number
    const before = row(epic)

    const res = handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'in_progress', version: before.version, reset_attempts: true, comment: 'why' })
    expect(text(res)).toBe(`INVALID: #${epic} is an epic, not claimable`)
    expect(row(epic).status).toBe('queued')
    expect(row(epic).version).toBe(before.version)
    expect(countAudit(epic, 'attempts_reset')).toBe(0)
    // the refund refusal is still reachable on its own, from a status that is not an acquisition
    expect(text(handleUpdateStatus(svc, { id: epic, agent: 'orchestrator', status: 'blocked', version: before.version, reset_attempts: true, comment: 'why' })))
      .toBe(`INVALID: cannot reset attempts on epic #${epic}`)
  })

  test('the acquisition guard is scoped to !selfEdge: a lease holder with deps still renews', () => {
    // A dependant that legitimately holds a lease must keep heartbeating — the guard reads deps only
    // on an acquisition, so a renewal on a dep-carrying row is untouched.
    const dep = createTaskRow('Dep')
    driveToDone(svc, dep, HOLDER)
    const id = createDepTask('Leased', [dep])
    handleUpdateStatus(svc, { id, agent: HOLDER, status: 'in_progress', version: versionOf(id) })
    pinLease(id, 1000)

    const res = leaseField(id, HOLDER, versionOf(id))
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('in_progress')
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
    expect(countAudit(id, 'lease_renewed')).toBe(1)
    expect(countAudit(id, 'update_status')).toBe(1)
  })

  test('combined renew + reset_attempts on a dep-carrying lease still works (both flags bypass the guard)', () => {
    const dep = createTaskRow('Dep')
    driveToDone(svc, dep, HOLDER)
    const id = createDepTask('Leased', [dep])
    for (let round = 0; round < 2; round++) burnAttempt(id)
    claimOrThrow(id, HOLDER)
    expect(row(id).attempts).toBe(2)
    pinLease(id, 1000)

    const res = leaseField(id, HOLDER, versionOf(id), { reset_attempts: true, comment: 'the budget went on accidents' })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ id, status: 'in_progress', version: versionOf(id), attempts: 0 })
    expect(row(id).assignee).toBe(HOLDER)
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
  })
})

// AC3: review → in_progress is the one sanctioned acquisition edge, and the guard deliberately skips
// the deps question on it (rejected alternative #6 in the spec). Cancelled task #1073's scope.
describe('review → in_progress: work sent back takes the lease', () => {
  const sentBack = () => {
    const id = createTaskRow('SentBack')
    claimOrThrow(id, 'developer')
    handleUpdateStatus(svc, { id, agent: 'developer', status: 'review', version: versionOf(id) })
    return id
  }

  test('a reviewer sending work back acquires the lease; the mover becomes the holder', () => {
    const id = sentBack()

    const res = handleUpdateStatus(svc, { id, agent: 'reviewer', status: 'in_progress', version: versionOf(id) })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('in_progress')
    expect(row(id).assignee).toBe('reviewer')
    expect(row(id).lease_expires_at).not.toBeNull()
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
    expect(countAudit(id, 'update_status')).toBe(2)
  })

  test('renew: true rides on the new lease for the holder, and only for the holder', () => {
    const id = sentBack()
    handleUpdateStatus(svc, { id, agent: 'reviewer', status: 'in_progress', version: versionOf(id) })

    const foreign = leaseField(id, 'developer', versionOf(id))
    expect(text(foreign)).toBe('CONFLICT: lease held by reviewer')
    expect(row(id).version).toBe(versionOf(id))
    expect(countAudit(id, 'lease_renewed')).toBe(0)

    const own = leaseField(id, 'reviewer', versionOf(id))
    expect(own.isError).toBeUndefined()
    expect(json(own).status).toBe('in_progress')
    expect(leaseMs(id)).toBeGreaterThan(fullWindowFromNow())
    expect(countAudit(id, 'lease_renewed')).toBe(1)
  })

  test('review → in_progress with renew: true in the same call is refused: renew needs the self-edge', () => {
    const id = sentBack()
    const before = row(id)
    expect(before.status).toBe('review')

    const res = handleUpdateStatus(svc, { id, agent: 'reviewer', status: 'in_progress', renew: true, version: before.version })
    expect(text(res)).toBe('INVALID: renew requires status=in_progress on an in_progress task')
    expect(row(id).status).toBe('review')
    expect(row(id).lease_expires_at).toBeNull()
    expect(countAudit(id, 'lease_renewed')).toBe(0)
  })

  test('the review edge asks no deps question, even on a row whose dep is open', () => {
    // Provably unnecessary rather than unchecked: depends_on is immutable after create and terminal
    // statuses have no outgoing edge, so a satisfied dep stays satisfied. The seeded row is the only
    // way to observe it, and it shows the edge makes no query — the entry succeeds with an open dep.
    const dep = createTaskRow('Open')
    const id = createDepTask('InReview', [dep])
    seedReview(id)

    const res = handleUpdateStatus(svc, { id, agent: 'reviewer', status: 'in_progress', version: versionOf(id) })
    expect(res.isError).toBeUndefined()
    expect(json(res).status).toBe('in_progress')
    expect(row(id).assignee).toBe('reviewer')
    expect(row(id).lease_expires_at).not.toBeNull()
    // same agent and same call, from queued: refused by the same guard
    const queued = createDepTask('StillQueued', [dep])
    expect(text(handleUpdateStatus(svc, { id: queued, agent: 'reviewer', status: 'in_progress', version: versionOf(queued) })))
      .toBe('BLOCKED: dependencies not satisfied')
  })
})
