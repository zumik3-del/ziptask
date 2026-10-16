import type { Task } from './tasks'
import type { TaskStore } from './types'
import { parseDeps, depsSatisfied } from './deps'
import { CANDIDATES_PAGE_SIZE } from '../defaults'

// Deps-satisfied queued tasks in claim order, scoped to one project. Paginated so a long tail of
// unsatisfied candidates never loads the whole table; `ceiling` bounds the scan for a pathological
// queue at page granularity: the loop stops once the offset has reached the ceiling, so at most
// `ceiling + CANDIDATES_PAGE_SIZE - 1` rows are read before it gives up on the rest.
export function readyCandidates(store: TaskStore, limit: number, ceiling: number, projectId: number): Task[] {
  const ready: Task[] = []
  if (limit <= 0) return ready
  const depCache = new Map<number, number[]>()
  let offset = 0
  while (ready.length < limit && offset < ceiling) {
    const page = store.queuedCandidates(CANDIDATES_PAGE_SIZE, projectId, offset)
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
      // every row of this page was cached in the loop above
      if (depsSatisfied(depStatuses, depCache.get(row.id) ?? [])) ready.push(row)
    }
    offset += CANDIDATES_PAGE_SIZE
  }
  return ready
}
