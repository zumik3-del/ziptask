import type { TaskStatus, Clock } from './tasks'
import { asClock, clockNowIso, clockNowMs } from './tasks'
import type { AuditStore, LeaseStore } from './types'
import { SECOND_MS } from '../defaults'

export class LeaseReaper {
  private lastReapAt = 0
  private readonly clock: Clock | null

  constructor(
    private readonly store: LeaseStore & Pick<AuditStore, 'auditAppend'>,
    private readonly reapCooldownSec: number,
    private readonly auditLog: boolean,
    clock?: unknown
  ) {
    this.clock = asClock(clock)
  }

  private _shouldReap(): boolean {
    return clockNowMs(this.clock) - this.lastReapAt >= this.reapCooldownSec * SECOND_MS
  }

  reapIfStale(): void {
    if (this._shouldReap()) this.reap()
  }

  reap(): void {
    const now = clockNowIso(this.clock)
    const expired = this.store.expiredLeases(now)
    for (const task of expired) {
      const newAttempts = task.attempts + 1
      const newStatus: TaskStatus = newAttempts > task.max_attempts ? 'failed' : 'queued'
      const changes = this.store.reapTransition(task.id, task.version, newStatus, newAttempts, now)
      if (changes === 1 && this.auditLog)
        this.store.auditAppend(task.id, 'system', 'lease_expired', 'in_progress', newStatus)
    }
    this.lastReapAt = clockNowMs(this.clock)
  }
}
