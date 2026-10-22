import { describe, test, expect } from 'bun:test'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { asClock, monotonicNowMs, resetMonotonicClock } from './core/tasks'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { LeaseReaper } from './core/reaper'
import { InMemoryEventStore } from './server'
import { formatError } from './core/result'
import { createTestDb, closeTestDb, getTaskRow, taskStoreStubs } from './test-context'

// The clock contract (task #1848): asClock is the single owner of the accepted clock shapes and
// every clock consumer (TaskRepo, TaskService, LeaseReaper) normalises through it, so the service
// and its reaper cannot disagree about the time source. These tests drive every accepted shape
// through both halves, plus the reset seam that puts the process-wide counter back on the wall
// clock. The injected time is in the past on purpose: a stamp that equals the wall clock would
// pass even if the injection were ignored.

const INJECTED_ISO = '2020-01-01T00:00:00.000Z'
const INJECTED_MS = Date.parse(INJECTED_ISO)
const LEASE_TTL_MIN = 15
const MINUTE_MS = 60_000
const REAP_COOLDOWN_SEC = 60

type ClockShape = { name: string; clock: unknown }

// Every shape asClock documents (src/core/tasks.ts), in the order of that doc block.
const SHAPES: ClockShape[] = [
  { name: 'a bare nowMs function', clock: () => INJECTED_MS },
  { name: '{ nowIso }', clock: { nowIso: () => INJECTED_ISO } },
  { name: '{ nowMs }', clock: { nowMs: () => INJECTED_MS } },
  { name: '{ now }', clock: { now: () => INJECTED_MS } },
  { name: '{ monotonicNowMs }', clock: { monotonicNowMs: () => INJECTED_MS } },
  { name: '{ clock: { nowMs } }', clock: { clock: { nowMs: () => INJECTED_MS } } },
  { name: '{ clock: { nowIso } }', clock: { clock: { nowIso: () => INJECTED_ISO } } }
]

// The reset seam is process-wide, so a test that uses it puts the counter back where it was: the
// ordering guarantee holds between two resets, and a later file must not inherit a dropped counter.
// The counter only moves forward, so restoring it means advancing it back up.
const restoreCounter = (to: number): void => {
  let current = monotonicNowMs()
  while (current < to) current = monotonicNowMs()
}

// A store that records the stamp the reaper hands it, so the sweep time is observed and not
// inferred from a row that may have been written by something else.
const capturingStore = () => {
  const stamps: string[] = []
  const store = taskStoreStubs({
    expiredLeases: (now: string) => {
      stamps.push(now)
      return []
    },
    reapTransition: () => 0
  })
  return { store, stamps }
}

describe('asClock: the accepted shapes', () => {
  test('a bare function becomes a clock whose nowIso is derived from it', () => {
    const clock = asClock(() => INJECTED_MS)
    expect(clock).not.toBeNull()
    expect(clock!.nowMs()).toBe(INJECTED_MS)
    expect(clock!.nowIso()).toBe(INJECTED_ISO)
  })

  test('{ nowIso } keeps its stamp and gets nowMs parsed out of it', () => {
    const clock = asClock({ nowIso: () => INJECTED_ISO })
    expect(clock).not.toBeNull()
    expect(clock!.nowIso()).toBe(INJECTED_ISO)
    expect(clock!.nowMs()).toBe(INJECTED_MS)
  })

  test('an explicit millisecond source wins over the parsed nowIso', () => {
    const clock = asClock({ nowIso: () => INJECTED_ISO, nowMs: () => INJECTED_MS + 1000 })
    expect(clock!.nowMs()).toBe(INJECTED_MS + 1000)
    expect(clock!.nowIso()).toBe(INJECTED_ISO)
  })

  test('{ now } and { monotonicNowMs } are aliases of nowMs', () => {
    expect(asClock({ now: () => INJECTED_MS })!.nowMs()).toBe(INJECTED_MS)
    expect(asClock({ monotonicNowMs: () => INJECTED_MS })!.nowMs()).toBe(INJECTED_MS)
    expect(asClock({ now: () => INJECTED_MS })!.nowIso()).toBe(INJECTED_ISO)
  })

  test('a { clock } envelope is unwrapped and normalised', () => {
    expect(asClock({ clock: { nowMs: () => INJECTED_MS } })!.nowMs()).toBe(INJECTED_MS)
    expect(asClock({ clock: { nowIso: () => INJECTED_ISO } })!.nowMs()).toBe(INJECTED_MS)
    expect(asClock({ clock: () => INJECTED_MS })!.nowIso()).toBe(INJECTED_ISO)
  })

  test('a shape asClock does not accept normalises to null', () => {
    expect(asClock(null)).toBeNull()
    expect(asClock(undefined)).toBeNull()
    expect(asClock('now')).toBeNull()
    expect(asClock({})).toBeNull()
    expect(asClock({ nowIso: 'not a function' })).toBeNull()
    expect(asClock({ now: 'not a function' })).toBeNull()
  })
})

describe('the service and its reaper share one clock', () => {
  for (const shape of SHAPES) {
    test(`the service stamps with the injected time source (${shape.name})`, () => {
      const db = createTestDb()
      try {
        const svc = new TaskService(new TaskRepo(db), {
          leaseTtlMin: LEASE_TTL_MIN,
          scope: 'test',
          clock: shape.clock
        })
        const created = svc.createTask({ title: 'Clocked', reporter: 'dev' })
        if (!created.ok) throw new Error(`createTask failed: ${formatError(created.error)}`)
        expect(getTaskRow(db, created.data.id).created_at).toBe(INJECTED_ISO)

        const claimed = svc.claimTask({ agent: 'dev', taskId: created.data.id })
        if (!claimed.ok) throw new Error(`claimTask failed: ${formatError(claimed.error)}`)
        // The lease window is computed from the millisecond source, so it pins the injected now
        // and not just the injected stamp: a service that read the wall clock here would put the
        // deadline years ahead of the injected one.
        expect(getTaskRow(db, created.data.id).lease_expires_at).toBe(
          new Date(INJECTED_MS + LEASE_TTL_MIN * MINUTE_MS).toISOString()
        )
      } finally {
        closeTestDb(db)
      }
    })

    test(`the reaper sweeps with the injected time source (${shape.name})`, () => {
      const db = createTestDb()
      try {
        const svc = new TaskService(new TaskRepo(db), {
          leaseTtlMin: LEASE_TTL_MIN,
          scope: 'test',
          clock: shape.clock
        })
        const created = svc.createTask({ title: 'Reaped', reporter: 'dev' })
        if (!created.ok) throw new Error(`createTask failed: ${formatError(created.error)}`)
        const id = created.data.id
        const claimed = svc.claimTask({ agent: 'dev', taskId: id })
        if (!claimed.ok) throw new Error(`claimTask failed: ${formatError(claimed.error)}`)
        // A lease that expired one minute before the injected now: only a sweep that reads the
        // injected clock finds this row.
        db.run('UPDATE tasks SET lease_expires_at = ? WHERE id = ?', [
          new Date(INJECTED_MS - MINUTE_MS).toISOString(),
          id
        ])

        svc.lifecycle.reapExpiredLeases()

        const reaped = getTaskRow(db, id)
        expect(reaped.status).toBe('queued')
        expect(reaped.attempts).toBe(1)
        // The sweep stamp is the injected time, not the wall clock: the reaper and the service
        // must not fall apart on the same row.
        expect(reaped.updated_at).toBe(INJECTED_ISO)
      } finally {
        closeTestDb(db)
      }
    })
  }

  test('a clock asClock rejects falls back to the process-wide source', () => {
    const db = createTestDb()
    try {
      const svc = new TaskService(new TaskRepo(db), {
        leaseTtlMin: LEASE_TTL_MIN,
        scope: 'test',
        clock: { now: 'not a function' }
      })
      const created = svc.createTask({ title: 'Unclocked', reporter: 'dev' })
      if (!created.ok) throw new Error(`createTask failed: ${formatError(created.error)}`)
      const createdAt = Date.parse(getTaskRow(db, created.data.id).created_at)
      expect(Math.abs(createdAt - Date.now())).toBeLessThan(60_000)
      expect(() => svc.lifecycle.reapExpiredLeases()).not.toThrow()
    } finally {
      closeTestDb(db)
    }
  })
})

describe('the reaper accepts every accepted shape', () => {
  for (const shape of SHAPES) {
    test(`the first sweep does not throw (${shape.name})`, () => {
      const { store, stamps } = capturingStore()
      const reaper = new LeaseReaper(store, REAP_COOLDOWN_SEC, true, shape.clock)
      expect(() => reaper.reap()).not.toThrow()
      // The sweep stamp is the injected time: a reaper that ignores the shape would sweep with
      // the wall clock instead, which is the silent half of the old defect.
      expect(stamps).toEqual([INJECTED_ISO])
    })

    test(`the stale check does not throw (${shape.name})`, () => {
      const { store, stamps } = capturingStore()
      const reaper = new LeaseReaper(store, REAP_COOLDOWN_SEC, true, shape.clock)
      expect(() => reaper.reapIfStale()).not.toThrow()
      expect(stamps).toEqual([INJECTED_ISO])
    })
  }
})

describe('the process-wide clock reset seam', () => {
  test('resetMonotonicClock() puts the counter back on the wall clock', () => {
    const prior = monotonicNowMs()
    try {
      // Push the counter a second past the wall clock: the reset has to drop those steps, so a
      // stamp back on the wall clock proves the counter was reset and not merely read.
      for (let i = 0; i < 1000; i++) monotonicNowMs()
      const ahead = monotonicNowMs()
      resetMonotonicClock()
      const before = Date.now()
      const stamp = monotonicNowMs()
      const after = Date.now()
      expect(stamp).toBeGreaterThanOrEqual(before)
      expect(stamp).toBeLessThanOrEqual(after)
      expect(stamp).toBeLessThan(ahead - 500)
    } finally {
      restoreCounter(prior)
    }
  })

  test('the stamps stay strictly increasing after a reset', () => {
    const prior = monotonicNowMs()
    try {
      resetMonotonicClock()
      const stamps = [monotonicNowMs(), monotonicNowMs(), monotonicNowMs()]
      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i]).toBeGreaterThan(stamps[i - 1])
      }
    } finally {
      restoreCounter(prior)
    }
  })

  test('the transport does not advance the domain counter', async () => {
    const prior = monotonicNowMs()
    try {
      resetMonotonicClock()
      const wallStart = Date.now()
      const baseline = monotonicNowMs()
      const store = new InMemoryEventStore()
      const message = { jsonrpc: '2.0', method: 'notifications/initialized' } as unknown as JSONRPCMessage
      await store.storeEvent('stream-1', message)
      await store.storeEvent('stream-1', message)
      await store.storeEvent('stream-1', message)
      const after = monotonicNowMs()
      const wallDrift = Date.now() - wallStart
      // The counter advances by one per call and by whatever the wall clock gained meanwhile.
      // Transport traffic must not spend a step of its own, so three stored events may not move
      // the counter by three.
      expect(after).toBeGreaterThan(baseline)
      expect(after - baseline).toBeLessThanOrEqual(wallDrift + 1)
    } finally {
      restoreCounter(prior)
    }
  })
})
