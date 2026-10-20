import type { TaskStatus, Clock } from './tasks'
import { asClock, nowIso, monotonicNowMs } from './tasks'
import type { AuditStore, LeaseStore } from './types'
import { SECOND_MS } from '../defaults'

// Lease reaping is its own responsibility: it owns the cooldown clock and the sweep, so the
// service no longer carries that state. The cooldown is bypassed deliberately by the write
// paths via reap(); read paths use reapIfStale().
export class LeaseReaper {
  private lastReapAt = 0
  private readonly clock: Clock | null

  constructor(
    private readonly store: LeaseStore & AuditStore,
    private readonly reapCooldownSec: number,
    private readonly auditLog: boolean,
    clock?: unknown
  ) {
    // One normalisation for every clock consumer: the accepted shapes are documented on asClock
    // (src/core/tasks.ts), so the reaper can never accept less than the service half does.
    this.clock = asClock(clock)
  }

  private _nowMs(): number {
    return this.clock ? this.clock.nowMs() : monotonicNowMs()
  }

  private _nowIso(): string {
    return this.clock ? this.clock.nowIso() : nowIso()
  }

  private _shouldReap(): boolean {
    return this._nowMs() - this.lastReapAt >= this.reapCooldownSec * SECOND_MS
  }

  reapIfStale(): void {
    if (this._shouldReap()) this.reap()
  }

  reap(): void {
    const now = this._nowIso()
    const expired = this.store.expiredLeases(now)
    for (const task of expired) {
      const newAttempts = task.attempts + 1
      const newStatus: TaskStatus = newAttempts > task.max_attempts ? 'failed' : 'queued'
      const changes = this.store.reapTransition(task.id, task.version, newStatus, newAttempts, now)
      if (changes === 1 && this.auditLog) this.store.auditAppend(task.id, 'system', 'lease_expired', 'in_progress', newStatus)
    }
    this.lastReapAt = this._nowMs()
  }
}
