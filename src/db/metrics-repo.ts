import type { Database } from 'bun:sqlite'
import type { MetricsStore } from '../core/metrics'
import { DAY_MINUTES } from '../defaults'

export class MetricsRepo implements MetricsStore {
  constructor(private db: Database) {}

  doneCount(sinceIso: string): number {
    const row = this.db.query(
      "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'done' AND is_epic = 0 AND completed_at >= ?"
    ).get(sinceIso) as { cnt: number }
    return row.cnt
  }

  canceledCount(sinceIso: string): number {
    const row = this.db.query(
      "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'canceled' AND is_epic = 0 AND completed_at >= ?"
    ).get(sinceIso) as { cnt: number }
    return row.cnt
  }

  auditLogCount(): number {
    const row = this.db.query('SELECT COUNT(*) as cnt FROM audit_log').get() as { cnt: number }
    return row.cnt
  }

  statusDurations(sinceIso: string, nowIsoStr: string): Array<{ status: string; minutes: number }> {
    return this.db.query(`
      WITH events AS (
        SELECT t.id AS task_id, t.created_at AS at, 'queued' AS status, 0 AS ord, -1 AS eid
        FROM tasks t WHERE t.is_epic = 0
        UNION ALL
        SELECT a.task_id, a.created_at, a.new_value, 1 AS ord, a.id AS eid
        FROM audit_log a JOIN tasks t ON t.id = a.task_id
        WHERE t.is_epic = 0 AND a.action IN ('claim', 'update_status', 'lease_expired')
      ),
      ordered AS (
        SELECT e.task_id, e.status, e.at AS seg_start,
          LEAD(e.at) OVER (PARTITION BY e.task_id ORDER BY e.at, e.ord, e.eid) AS next_at,
          t.completed_at AS completed_at
        FROM events e JOIN tasks t ON t.id = e.task_id
      ),
      clamped AS (
        SELECT status,
          MAX(seg_start, ?) AS s,
          MIN(COALESCE(next_at, completed_at, ?), ?) AS e
        FROM ordered
      )
      SELECT status, SUM((julianday(e) - julianday(s)) * ${DAY_MINUTES}) AS minutes
      FROM clamped
      WHERE e > s
      GROUP BY status
    `).all(sinceIso, nowIsoStr, nowIsoStr) as Array<{ status: string; minutes: number }>
  }
}
