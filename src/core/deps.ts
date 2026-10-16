import type { TaskStatus } from './tasks'
import { TERMINAL_STATUSES } from './tasks'

export function parseDeps(raw: string): number[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (Array.isArray(parsed)) return parsed.filter((x): x is number => typeof x === 'number')
  return []
}

export function createsCycle(depsOf: (id: number) => string | null, taskId: number, dependsOn: number[]): boolean {
  if (dependsOn.length === 0) return false
  const visited = new Set<number>()
  const stack = [...dependsOn]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === taskId) return true
    if (visited.has(current)) continue
    visited.add(current)

    const raw = depsOf(current)
    if (!raw) continue
    const deps = parseDeps(raw)
    for (const dep of deps) {
      if (!visited.has(dep)) stack.push(dep)
    }
  }
  return false
}

// The single source of the dependency-satisfaction rule: a dep is blocking while it is unknown or
// non-terminal. `depsSatisfied` and the `blocked_by` view are both derived from this list.
export function blockingDeps(statuses: Map<number, TaskStatus>, dependsOn: number[]): number[] {
  return dependsOn.filter(depId => {
    const status = statuses.get(depId)
    return status === undefined || !TERMINAL_STATUSES.includes(status)
  })
}

export function depsSatisfied(statuses: Map<number, TaskStatus>, dependsOn: number[]): boolean {
  return blockingDeps(statuses, dependsOn).length === 0
}
