import type { TaskStatus } from './tasks'
import { nowIso } from './tasks'
import type { LeaseStore } from './types'
import { SECOND_MS } from '../defaults'

// Lease reaping is its own responsibility: it owns the cooldown clock and the sweep, so the
// service no longer carries that state. The cooldown is bypassed deliberately by the write
// paths via reap(); read paths use reapIfStale().
export class LeaseReaper {
  private lastReapAt = 0

  constructor(
    private readonly store: LeaseStore,
    private readonly reapCooldownSec: number,
    private readonly auditLog: boolean
  ) {}

  private _shouldReap(): boolean {
    return Date.now() - this.lastReapAt >= this.reapCooldownSec * SECOND_MS
  }

  reapIfStale(): void {
    if (this._shouldReap()) this.reap()
  }

  reap(): void {
    const now = nowIso()
    const expired = this.store.expiredLeases(now)
    for (const task of expired) {
      const newAttempts = task.attempts + 1
      const newStatus: TaskStatus = newAttempts > task.max_attempts ? 'failed' : 'queued'
      const changes = this.store.reapTransition(task.id, task.version, newStatus, newAttempts, now)
      if (changes === 1 && this.auditLog) this.store.auditAppend(task.id, 'system', 'lease_expired', 'in_progress', newStatus)
    }
    this.lastReapAt = Date.now()
  }
}
