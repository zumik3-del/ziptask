import { describe, test, expect } from 'bun:test'
import instructions from './mcp/instructions.md' with { type: 'text' }
import httpEndpoints from '../docs/http-endpoints.md' with { type: 'text' }
import { STATUS_CODES, TASK_STATUSES, TERMINAL_STATUSES } from './core/tasks'

// #2366: the shipped `instructions.md` is the client-facing contract, and `src/core/tasks.ts` is
// the state machine behind it. These tests parse the two clauses that carry the status vocabulary
// and compare them with the code, so a status added to `tasks.ts` cannot ship with stale
// instructions (the client would then receive a legend that lies).
// #2722: `docs/http-endpoints.md` is another copy of the vocabulary (the `/api/tasks` status
// parameter row), pinned the same code-derived way instead of a hand-copied list.

function legendLine(): string {
  const line = instructions.split('\n').find((candidate) => candidate.includes('`STATUS_CODES`'))
  if (line === undefined)
    throw new Error('src/mcp/instructions.md carries no `STATUS_CODES` legend')
  return line
}

function parsedLegend(): Array<{ name: string; code: number }> {
  return [...legendLine().matchAll(/`(\d+)`\s+([a-z_]+)/g)].map((match) => ({
    code: Number(match[1]),
    name: match[2]
  }))
}

function httpStatusParamStatuses(): string[] {
  const line = httpEndpoints.split('\n').find((candidate) => candidate.startsWith('| `status`'))
  if (line === undefined) throw new Error('docs/http-endpoints.md carries no `status` query row')
  const cells = line.split('|')
  const description = cells[3]
  if (description === undefined)
    throw new Error(`docs/http-endpoints.md status row carries no description cell: ${line}`)
  return [...description.matchAll(/`([a-z_]+)`/g)].map((match) => match[1])
}

function epicFlowTargets(): string[] {
  const line = instructions.split('\n').find((candidate) => candidate.includes('for epics'))
  if (line === undefined) throw new Error('src/mcp/instructions.md carries no epic flow clause')
  const match = line.match(/`open -> ([^`]+)` for epics/)
  if (match === null) throw new Error(`epic flow clause is not \`open -> ...\` for epics: ${line}`)
  return match[1].split('|')
}

describe('instructions parity (#2366)', () => {
  test('the STATUS_CODES legend names every status exactly once, in code order', () => {
    expect(parsedLegend().map((entry) => entry.name)).toEqual(['not_found', ...TASK_STATUSES])
  })

  test('the STATUS_CODES legend carries the code STATUS_CODES gives each name', () => {
    const legendCodes = Object.fromEntries(parsedLegend().map((entry) => [entry.name, entry.code]))
    expect(legendCodes).toEqual({ ...STATUS_CODES })
  })

  test('the epic flow line closes onto exactly the closed-for-work statuses', () => {
    // Membership of the closed-for-work set is pinned by the single-source test in tasks.test.ts;
    // this harness stays code-derived so it cannot drift with a hand-copied list (#2368 nit 5).
    expect(epicFlowTargets()).toEqual([...TERMINAL_STATUSES])
  })
})

describe('http-endpoints parity (#2722)', () => {
  test('the /api/tasks status row names every status exactly once, in code order', () => {
    expect(httpStatusParamStatuses()).toEqual([...TASK_STATUSES])
  })
})
