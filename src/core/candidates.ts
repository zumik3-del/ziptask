import type { Task } from './tasks'
import type { TaskStore } from './types'
import { parseDeps, depsSatisfied } from './deps'
import { CANDIDATES_PAGE_SIZE } from '../defaults'

// Deps-satisfied queued tasks in claim order. Paginated so a long tail of unsatisfied
// candidates never loads the whole table; `ceiling` bounds the scan for a pathological queue.
export function readyCandidates(store: TaskStore, limit: number, ceiling: number): Task[] {
  const ready: Task[] = []
  if (limit <= 0) return ready
  const depCache = new Map<number, number[]>()
  let offset = 0
  while (ready.length < limit && offset < ceiling) {
    const page = store.queuedCandidates(CANDIDATES_PAGE_SIZE, offset)
    if (page.length === 0) break
    const allDeps = new Set<number>()
    for (const row of page) {
      let deps = depCache.get(row.id)
      if (deps === undefined) { deps = parseDeps(row.depends_on); depCache.set(row.id, deps) }
      for (const dep of deps) allDeps.add(dep)
    }
    const depStatuses = store.statusesOf(Array.from(allDeps))
    for (const row of page) {
      if (ready.length >= limit) break
      if (depsSatisfied(depStatuses, depCache.get(row.id)!)) ready.push(row)
    }
    offset += CANDIDATES_PAGE_SIZE
  }
  return ready
}
