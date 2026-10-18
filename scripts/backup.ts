import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const DB_PATH = process.env.ZIPTASK_DB ?? './data/ziptask.db'
const BACKUP_DIR = process.env.ZIPTASK_BACKUP_DIR ?? './backups'
const BACKUP_PREFIX = process.env.ZIPTASK_BACKUP_PREFIX ?? 'ziptask'
const RETAIN_COUNT = parseInt(process.env.ZIPTASK_BACKUP_RETAIN ?? '7', 10)

// sqlite3 dot-command destination; never derived from user-controlled paths.
const TEMP_BACKUP_NAME = '.ziptask-backup.tmp.db'

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function validatePath(p: string, label: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  if (p.includes('\0')) {
    throw new Error(`${label} contains a NUL byte`)
  }
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`${label} contains control characters`)
    }
  }
  return resolve(p)
}

function validateBackupLocation(backupPath: string, backupDir: string): void {
  const resolvedDir = resolve(backupDir)
  const resolvedPath = resolve(backupPath)
  if (resolvedPath === resolvedDir) {
    throw new Error('backup path must not equal the backup directory')
  }
  if (!resolvedPath.startsWith(resolvedDir + sep)) {
    throw new Error(`backup path escapes backup directory: ${backupPath}`)
  }
}

function doBackup(): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(BACKUP_DIR, `${BACKUP_PREFIX}-${ts}.db`)
  const tarName = `${BACKUP_PREFIX}-${ts}.db.tar.gz`

  try {
    validatePath(DB_PATH, 'DB_PATH')
    validatePath(BACKUP_DIR, 'BACKUP_DIR')
    validateBackupLocation(backupPath, BACKUP_DIR)
    if (!Number.isFinite(RETAIN_COUNT) || RETAIN_COUNT < 0) {
      throw new Error(`RETAIN_COUNT must be a non-negative number, got: ${process.env.ZIPTASK_BACKUP_RETAIN ?? '7'}`)
    }
  } catch (e) {
    log(`invalid configuration: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  log(`Backing up ${DB_PATH} → ${backupPath} (sqlite3 .backup)`)

  mkdirSync(dirname(backupPath), { recursive: true })
  mkdirSync(BACKUP_DIR, { recursive: true })

  // Pragma to truncate WAL before backup
  try {
    spawnSync('sqlite3', [DB_PATH, 'PRAGMA wal_checkpoint(TRUNCATE);'], { stdio: 'pipe' })
  } catch {
    // best-effort; continue
  }

  // Online backup via sqlite3 CLI .backup command into a fixed, safe temp file
  // (never interpolate the destination path into the dot-command).
  const tempBackupPath = join(BACKUP_DIR, TEMP_BACKUP_NAME)
  try {
    rmSync(tempBackupPath, { force: true })
  } catch {
    // ignore
  }

  try {
    const r = spawnSync('sqlite3', [DB_PATH, `.backup '${TEMP_BACKUP_NAME}'`], { cwd: BACKUP_DIR, stdio: 'pipe' })
    if (r.error || r.status !== 0) {
      const err = r.error?.message ?? (r.stderr?.toString().trim() || r.stdout?.toString().trim() || `code ${r.status}`)
      log(`sqlite3 .backup failed: ${err}`)
      process.exit(1)
    }
  } catch (e) {
    log(`sqlite3 .backup failed: ${e}`)
    process.exit(1)
  }

  try {
    renameSync(tempBackupPath, backupPath)
  } catch (e) {
    log(`failed to finalize backup file: ${e}`)
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

if (import.meta.main) {
  doBackup()
}

export { doBackup, validatePath, validateBackupLocation, TEMP_BACKUP_NAME }
export function validateBackupPath(p: string): string {
  return validatePath(p, 'backupPath')
}
