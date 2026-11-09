import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { openDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { makeTempDbPath, removeTempDb, seedProject } from './test-context'

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
