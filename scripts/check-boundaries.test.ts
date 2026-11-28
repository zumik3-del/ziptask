import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findViolations } from './check-boundaries'

const TMP = '/tmp/opencode'

const created: string[] = []

function fixtureSrc(files: Record<string, string>): string {
  mkdirSync(TMP, { recursive: true })
  const root = mkdtempSync(join(TMP, 'check-boundaries-'))
  created.push(root)
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, 'src', path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return join(root, 'src')
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

const CLEAN_TREE: Record<string, string> = {
  'core/tasks.ts': 'export const STATUS = 1\n',
  'core/types.ts': 'export type TaskRow = { id: number }\n',
  'core/service.ts': "import { STATUS } from './tasks'\nexport const svc = STATUS\n",
  'db/repo.ts':
    "import type { TaskRow } from '../core/types'\n" +
    "import { STATUS } from '../core/tasks'\n" +
    'export type Row = TaskRow\n' +
    'export const repo = { STATUS }\n',
  'mcp/server.ts': "import { svc } from '../core/service'\nexport const server = svc\n"
}

describe('findViolations', () => {
  test('clean tree passes and counts every scanned file', () => {
    const report = findViolations(fixtureSrc(CLEAN_TREE))

    expect(report.failures).toEqual([])
    expect(report.filesScanned).toBe(5)
  })

  test('db/ importing a stateful core module fails with rule 3', () => {
    const report = findViolations(
      fixtureSrc({
        ...CLEAN_TREE,
        'db/repo.ts': "import { svc } from '../core/service'\nexport const repo = svc\n"
      })
    )

    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toStartWith('src/db/repo.ts:1 ')
    expect(report.failures[0]).toContain('rule 3')
    expect(report.failures[0]).toContain('core/service is not allowlisted')
  })

  test('db/ importing a core module that does not exist yet fails with rule 3', () => {
    const report = findViolations(
      fixtureSrc({
        ...CLEAN_TREE,
        'db/repo.ts': "import { leases } from '../core/leases'\nexport const repo = leases\n"
      })
    )

    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toContain('rule 3')
    expect(report.failures[0]).toContain('core/leases is not allowlisted')
  })

  test('core/ importing db/ fails with rule 1', () => {
    const report = findViolations(
      fixtureSrc({
        ...CLEAN_TREE,
        'core/service.ts': "import { repo } from '../db/repo'\nexport const svc = repo\n"
      })
    )

    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toStartWith('src/core/service.ts:1 ')
    expect(report.failures[0]).toContain('rule 1: core/ must not import db/')
  })

  test('mcp/ importing db/ fails with rule 1', () => {
    const report = findViolations(
      fixtureSrc({
        ...CLEAN_TREE,
        'mcp/server.ts': "import { repo } from '../db/repo'\nexport const server = repo\n"
      })
    )

    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toStartWith('src/mcp/server.ts:1 ')
    expect(report.failures[0]).toContain('rule 1: mcp/ must not import db/')
  })
})
