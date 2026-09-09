// Metrics tool kept provisionally; keep/drop decision deferred to issue #25.
import type { Task } from './tasks'
import { nowIso } from './tasks'

export type MetricsResult = {
  doneCount: number
  statusTime: Record<string, number>
  bottleneck: { status: string; minutes: number } | null
}

export interface MetricsStore {
  doneCount(sinceIso: string): number
  taskSummaries(): Array<Pick<Task, 'id' | 'status' | 'created_at' | 'updated_at' | 'completed_at' | 'is_epic'>>
  auditTransitionsForTasks(): Array<{ task_id: number; new_value: string; created_at: string }>
}

export function computeMetrics(store: MetricsStore, period?: number | 'all'): MetricsResult {
  const now = nowIso()
  const periodHours = period === 'all' ? 0 : (period ?? 24)
  const since = periodHours === 0 ? '0001-01-01T00:00:00.000Z' : new Date(Date.now() - periodHours * 3600_000).toISOString()

  const done_count = store.doneCount(since)
  const allTasks = store.taskSummaries()
  const tasks = allTasks.filter(t => t.is_epic === 0)
  const allTransitions = store.auditTransitionsForTasks()

  const transitionsByTask = new Map<number, Array<{ new_value: string; created_at: string }>>()
  for (const t of allTransitions) {
    let arr = transitionsByTask.get(t.task_id)
    if (!arr) { arr = []; transitionsByTask.set(t.task_id, arr) }
    arr.push({ new_value: t.new_value, created_at: t.created_at })
  }

  const statusTime: Record<string, number> = {}

  for (const task of tasks) {
    const transitions = transitionsByTask.get(task.id) ?? []

    let currentStatus = 'queued'
    let currentTime = task.created_at

    for (const t of transitions) {
      if (t.created_at < currentTime) continue
      addMinutes(statusTime, currentStatus, currentTime, t.created_at, since, now)
      currentStatus = t.new_value
      currentTime = t.created_at
    }

    const endTime = task.completed_at ?? now
    addMinutes(statusTime, currentStatus, currentTime, endTime, since, now)
  }

  let bottleneck: { status: string; minutes: number } | null = null
  for (const [status, mins] of Object.entries(statusTime)) {
    if (!bottleneck || mins > bottleneck.minutes) {
      bottleneck = { status, minutes: mins }
    }
  }

  return { doneCount: done_count, statusTime, bottleneck }
}

function addMinutes(statusTime: Record<string, number>, status: string, segStart: string, segEnd: string, since: string, now: string): void {
  const start = segStart > since ? segStart : since
  const end = segEnd < now ? segEnd : now
  if (end > start) {
    statusTime[status] = (statusTime[status] ?? 0) + (new Date(end).getTime() - new Date(start).getTime()) / 60000
  }
}
