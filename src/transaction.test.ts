import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { fail, ok } from './core/result'
import { nowIso } from './core/tasks'
import { openDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { makeTempDbPath, removeTempDb, seedProject, testProjectId } from './test-context'

const INSERT_PROJECT =
  "INSERT INTO projects (slug, folder_path, created_at, updated_at) VALUES (?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"

let dbPath: string
let db: Database
let rival: Database

beforeEach(() => {
  dbPath = makeTempDbPath('txn')
  db = openDatabase(dbPath)
  seedProject(db)
  rival = openDatabase(dbPath)
  rival.exec('PRAGMA busy_timeout = 0')
})

afterEach(() => {
  rival.close()
  db.close()
  removeTempDb(dbPath)
})

function projectSlugs(conn: Database): string[] {
  return (
    conn.query('SELECT slug FROM projects ORDER BY slug').all() as Array<{ slug: string }>
  ).map((r) => r.slug)
}

function insertRow(repo: TaskRepo, title: string): number {
  return repo.insertTask({
    title,
    description: null,
    priority: 'p2',
    reporter: 'dev',
    depends_on: '[]',
    now: nowIso(),
    projectId: testProjectId(repo)
  }).id
}

function storeCounts(conn: Database): { tasks: number; comments: number; audit: number } {
  const count = (table: string) =>
    (conn.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { tasks: count('tasks'), comments: count('comments'), audit: count('audit_log') }
}

describe('TaskRepo.transaction is IMMEDIATE (#2243)', () => {
  test('a read-then-write transaction holds the write lock, so the rival is refused and then commits', () => {
    const repo = new TaskRepo(db)
    let rivalBlocked = false
    repo.transaction(() => {
      expect(projectSlugs(db)).toEqual(['test'])
      try {
        rival.run(INSERT_PROJECT, ['rival'])
      } catch (err) {
        rivalBlocked = /database is locked/.test(String(err))
      }
      db.run(INSERT_PROJECT, ['ours'])
      return ok(undefined)
    })
    expect(rivalBlocked).toBe(true)
    rival.transaction(() => {
      rival.run(INSERT_PROJECT, ['rival'])
    })()
    expect(projectSlugs(db)).toEqual(['ours', 'rival', 'test'])
  })

  test('control: a deferred read-then-write on the same database fails with database is locked', () => {
    db.exec('BEGIN DEFERRED')
    try {
      expect(projectSlugs(db)).toEqual(['test'])
      rival.run(INSERT_PROJECT, ['rival'])
      expect(() => db.run(INSERT_PROJECT, ['ours'])).toThrow(/database is locked/)
    } finally {
      db.exec('ROLLBACK')
    }
    expect(projectSlugs(db)).toEqual(['rival', 'test'])
  })
})

describe('TaskRepo.transaction honours the SvcResult contract', () => {
  test('an ok body commits its writes and hands back the same result', () => {
    const repo = new TaskRepo(db)
    let handed: unknown = null
    const result = repo.transaction(() => {
      const created = ok({ id: insertRow(repo, 'Committed') })
      handed = created
      return created
    })

    expect(result).toBe(handed as typeof result)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('an ok body must return ok')
    expect(storeCounts(db).tasks).toBe(1)
    expect(
      (db.query('SELECT title FROM tasks WHERE id = ?').get(result.data.id) as any).title
    ).toBe('Committed')
  })

  test('a body that writes and then fails rolls the writes back and returns that exact failure', () => {
    const repo = new TaskRepo(db)
    const failure = fail('CONFLICT', 'refused after the write')
    const result = repo.transaction(() => {
      const id = insertRow(repo, 'Must vanish')
      repo.insertComment(id, 'dev', 'must vanish too')
      repo.auditAppend(id, 'dev', 'create', undefined, 'queued')
      return failure
    })

    expect(result).toBe(failure)
    expect(result).toEqual(fail('CONFLICT', 'refused after the write'))
    expect(storeCounts(db)).toEqual({ tasks: 0, comments: 0, audit: 0 })
  })

  test('a body that throws a real Error propagates the same instance and commits nothing', () => {
    const repo = new TaskRepo(db)
    const boom = new Error('boom after the write')
    let caught: unknown = null

    try {
      repo.transaction(() => {
        insertRow(repo, 'Must vanish')
        throw boom
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(boom)
    expect((caught as Error).message).toBe('boom after the write')
    expect(storeCounts(db)).toEqual({ tasks: 0, comments: 0, audit: 0 })
  })
})
