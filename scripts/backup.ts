import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DB_PATH = process.env.ZIPTASK_DB ?? './data/ziptask.db'
const BACKUP_DIR = process.env.ZIPTASK_BACKUP_DIR ?? './backups'
const BACKUP_PREFIX = process.env.ZIPTASK_BACKUP_PREFIX ?? 'ziptask'
const RETAIN_COUNT = parseInt(process.env.ZIPTASK_BACKUP_RETAIN ?? '7', 10)

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function doBackup(): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(BACKUP_DIR, `${BACKUP_PREFIX}-${ts}.db`)
  const tarName = `${BACKUP_PREFIX}-${ts}.db.tar.gz`

  log(`Backing up ${DB_PATH} → ${backupPath} (sqlite3 .backup)`)

  mkdirSync(dirname(backupPath), { recursive: true })
  mkdirSync(BACKUP_DIR, { recursive: true })

  // Pragma to truncate WAL before backup
  try {
    spawnSync('sqlite3', [DB_PATH, 'PRAGMA wal_checkpoint(TRUNCATE);'], { stdio: 'pipe' })
  } catch {
    // best-effort; continue
  }

  // Online backup via sqlite3 CLI .backup command
  try {
    const r = spawnSync('sqlite3', [DB_PATH, `.backup '${backupPath.replace(/'/g, "''")}'`], { stdio: 'pipe' })
    if (r.error || r.status !== 0) {
      const err = r.error?.message ?? (r.stderr?.toString().trim() || r.stdout?.toString().trim() || `code ${r.status}`)
      log(`sqlite3 .backup failed: ${err}`)
      process.exit(1)
    }
  } catch (e) {
    log(`sqlite3 .backup failed: ${e}`)
    process.exit(1)
  }

  log(`Backup written: ${backupPath}`)

  // Tar+gzip for space efficiency; remove raw .db after success
  try {
    const rawName = `${BACKUP_PREFIX}-${ts}.db`
    const r = spawnSync('tar', ['czf', join(BACKUP_DIR, tarName), '-C', BACKUP_DIR, rawName])
    if (r.status === 0) {
      rmSync(backupPath)
      log(`Archived and removed raw backup: ${tarName}`)
    } else {
      log(`tar failed (code ${r.status}), keeping raw backup at ${backupPath}`)
    }
  } catch {
    log(`tar failed, keeping raw backup at ${backupPath}`)
  }

  // Clean old backups (keep RETAIN_COUNT)
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(`${BACKUP_PREFIX}-`) && f.endsWith('.db.tar.gz'))
      .sort()
      .map(f => join(BACKUP_DIR, f))
    while (files.length > RETAIN_COUNT) {
      rmSync(files.shift()!)
    }
    if (files.length > 0) {
      log(`Backup complete. Retaining ${files.length} of ${RETAIN_COUNT}.`)
    } else {
      log(`Backup complete. Retaining ${RETAIN_COUNT}.`)
    }
  } catch {
    log(`Backup complete. Retaining ${RETAIN_COUNT}.`)
  }
}

doBackup()
