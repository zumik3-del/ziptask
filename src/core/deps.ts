import type { TaskStatus } from './tasks'
import { TERMINAL_STATUSES } from './tasks'

export function parseDeps(raw: string): number[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (Array.isArray(parsed)) return parsed.filter((x): x is number => typeof x === 'number')
  return []
}

export function checkCycles(depsOf: (id: number) => string | null, taskId: number, dependsOn: number[]): boolean {
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

export function depsSatisfied(statuses: Map<number, TaskStatus>, dependsOn: number[]): boolean {
  for (const depId of dependsOn) {
    const status = statuses.get(depId)
    if (!status || !TERMINAL_STATUSES.includes(status)) return false
  }
  return true
}
