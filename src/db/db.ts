import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './migrations'

let dbRef: Database | null = null

export function openDatabase(path?: string): Database {
  const dbPath = path ?? './data/ziptask.db'
  const { mkdirSync } = require('node:fs')
  const { dirname } = require('node:path')
  mkdirSync(dirname(dbPath), { recursive: true })
  dbRef = new Database(dbPath)
  dbRef.exec('PRAGMA journal_mode = WAL')
  dbRef.exec('PRAGMA busy_timeout = 5000')
  dbRef.exec('PRAGMA foreign_keys = ON')
  applyMigrations(dbRef)
  return dbRef
}

export function closeDatabase(db: Database): void {
  db.close()
  dbRef = null
}

function applyMigrations(db: Database) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
  const current = row?.version ?? 0
  const last = MIGRATIONS.length
  if (current === last) return
  if (current > last) {
    throw new Error(`SCHEMA: database schema version ${current} is newer than this binary supports (${last}); upgrade ziptask or restore the database from backup`)
  }
  const migrate = db.transaction(() => {
    for (let i = current; i < last; i++) {
      db!.exec(MIGRATIONS[i])
    }
    db!.run('DELETE FROM schema_version')
    db!.run('INSERT INTO schema_version (version) VALUES (?)', [last])
  })
  try {
    migrate()
  } catch (err) {
    throw new Error(`SCHEMA: migration failed; database does not match this binary's migration history (created by an older or dev build?) — restore from backup or recreate the database; original: ${err}`)
  }
}
