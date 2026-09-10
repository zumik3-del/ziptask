import { nowIso } from './tasks'

export type MetricsResult = {
  doneCount: number
  statusTime: Record<string, number>
  bottleneck: { status: string; minutes: number } | null
}

export interface MetricsStore {
  doneCount(sinceIso: string): number
  statusDurations(sinceIso: string, nowIsoStr: string): Array<{ status: string; minutes: number }>
}

export function computeMetrics(store: MetricsStore, period?: number | 'all'): MetricsResult {
  const now = nowIso()
  const periodHours = period === 'all' ? 0 : (period ?? 24)
  const since = periodHours === 0 ? '0001-01-01T00:00:00.000Z' : new Date(Date.now() - periodHours * 3600_000).toISOString()

  const doneCount = store.doneCount(since)

  const statusTime: Record<string, number> = {}
  for (const { status, minutes } of store.statusDurations(since, now)) {
    statusTime[status] = (statusTime[status] ?? 0) + minutes
  }

  let bottleneck: { status: string; minutes: number } | null = null
  for (const [status, mins] of Object.entries(statusTime)) {
    if (!bottleneck || mins > bottleneck.minutes) {
      bottleneck = { status, minutes: mins }
    }
  }

  return { doneCount, statusTime, bottleneck }
}
