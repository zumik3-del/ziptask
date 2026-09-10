import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from './db/db'
import { MIGRATIONS } from './db/migrations'
import { createTestDb, closeTestDb } from './test-context'

let db: Database
beforeEach(() => { db = createTestDb() })
afterEach(() => { closeTestDb(db) })

describe('schema migration (v2)', () => {
  test('fresh db has correct tables', () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain('tasks')
    expect(names).toContain('comments')
    expect(names).toContain('audit_log')
    expect(names).toContain('schema_version')
  })

  test('tasks table has no removed columns, no parent_id index (v2)', () => {
    const cols = db.query('PRAGMA table_info(tasks)').all() as any[]
    const names = cols.map(c => c.name)
    expect(names).not.toContain('task_path')
    expect(names).not.toContain('result_path')
    expect(names).not.toContain('parent_id')
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    expect(indexes.map(i => i.name)).not.toContain('idx_tasks_parent_id')
  })

  test('comments table has type column default comment (v2)', () => {
    const cols = db.query('PRAGMA table_info(comments)').all() as any[]
    const typeCol = cols.find(c => c.name === 'type')
    expect(typeCol).toBeDefined()
    expect(typeCol.notnull).toBe(1)
    expect(typeCol.dflt_value).toBe("'comment'")
  })
})

describe('schema guard (v1.6)', () => {
  function makeTempDbPath(): string {
    const dir = '/tmp/opencode'
    mkdirSync(dir, { recursive: true })
    return join(dir, `ziptask-schema-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  }

  function openAndClose(path: string) {
    const db = openDatabase(path)
    db.close()
  }

  function rmTempDb(path: string) {
    try { rmSync(path) } catch {}
    try { rmSync(path + '-wal') } catch {}
    try { rmSync(path + '-shm') } catch {}
  }

  test('fresh empty DB opens and stamps MIGRATIONS.length', () => {
    const path = makeTempDbPath()
    try {
      const db = openDatabase(path)
      const row = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(row?.version).toBe(MIGRATIONS.length)
      db.close()
    } finally { rmTempDb(path) }
  })

  test('V < L upgrades: applies missing migrations and stamps L', () => {
    const path = makeTempDbPath()
    try {
      const db = openDatabase(path)
      db.close()
      const db2 = openDatabase(path)
      db2.run('DROP INDEX IF EXISTS idx_tasks_epic_id')
      db2.run('ALTER TABLE tasks DROP COLUMN epic_id')
      db2.run('ALTER TABLE tasks DROP COLUMN is_epic')
      db2.run('DELETE FROM schema_version')
      db2.run('INSERT INTO schema_version (version) VALUES (?)', [2])
      db2.close()
      const db3 = openDatabase(path)
      const row = db3.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(row?.version).toBe(MIGRATIONS.length)
      const cols = db3.query('PRAGMA table_info(tasks)').all() as any[]
      expect(cols.map(c => c.name)).toContain('is_epic')
      const idx = (db3.query("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map(r => r.name)
      expect(idx).toContain('idx_audit_log_task_id')
      expect(idx).toContain('idx_comments_task_id')
      expect(idx).toContain('idx_tasks_status_completed')
      db3.close()
    } finally { rmTempDb(path) }
  })

  test('V > L throws exact R4 message, DB unchanged', () => {
    const path = makeTempDbPath()
    try {
      openAndClose(path)
      const db = openDatabase(path)
      db.run('DELETE FROM schema_version')
      db.run('INSERT INTO schema_version (version) VALUES (?)', [99])
      db.close()
      let thrown: Error | null = null
      try { openDatabase(path) } catch (err) { thrown = err as Error }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown!.message).toBe(
        `SCHEMA: database schema version 99 is newer than this binary supports (${MIGRATIONS.length}); upgrade ziptask or restore the database from backup`
      )
      const raw = new Database(path)
      const ver = raw.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(ver?.version).toBe(99)
      const int = raw.query('SELECT * FROM sqlite_master').all() as { type: string; name: string }[]
      expect(int.some(r => r.type === 'table' && r.name === 'tasks')).toBe(true)
      raw.close()
    } finally { rmTempDb(path) }
  })

  test('divergent DB stamps a lower version on full schema fires R5', () => {
    const path = makeTempDbPath()
    try {
      openAndClose(path)
      const db = openDatabase(path)
      db.run('DELETE FROM schema_version')
      db.run('INSERT INTO schema_version (version) VALUES (?)', [2])
      db.close()
      let thrown: Error | null = null
      try { openDatabase(path) } catch (err) { thrown = err as Error }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown!.message).toMatch(/^SCHEMA: migration to version \d+ failed at step \d+ \(from \d+\)/)
      expect(thrown!.message).toMatch(/original: /)
      const raw = new Database(path)
      const ver = raw.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
      expect(ver?.version).toBe(2)
      raw.close()
    } finally { rmTempDb(path) }
  })
})
