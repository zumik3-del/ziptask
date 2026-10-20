import { openDatabase, closeDatabase } from '../src/db/db'
import { parseDeps } from '../src/core/deps'
import { TERMINAL_STATUSES_SQL } from '../src/db/sql'
import { DEFAULT_DB_PATH } from '../src/defaults'

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

const dbPath = parseArg('--db') ?? process.env.ZIPTASK_DB ?? DEFAULT_DB_PATH
const daysRaw = parseArg('--days') ?? process.env.PRUNE_OLDER_THAN_DAYS ?? '30'
const days = Number(daysRaw)
const apply = process.argv.includes('--apply')

if (!Number.isFinite(days) || days < 0) {
  console.error(`Error: --days must be a non-negative number of days, got: ${daysRaw}`)
  process.exit(1)
}

const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

const db = openDatabase(dbPath)
try {
  // A deleted dependency id would block its dependent forever (statusesOf reads a missing id as
  // "not terminal"), and epic_id has no ON DELETE CASCADE, so a parent epic cannot go before its
  // children: prune only terminal tasks older than the cutoff that no live task references and
  // that have no children of their own. comments/audit_log cascade on task delete (schema v4).
  const liveDeps = new Set<number>()
  for (const row of db.query(`SELECT depends_on FROM tasks WHERE status NOT IN ${TERMINAL_STATUSES_SQL}`).all() as Array<{ depends_on: string }>) {
    for (const id of parseDeps(row.depends_on)) liveDeps.add(id)
  }
  const candidates = db.query(
    `SELECT id, title, status, completed_at FROM tasks
     WHERE status IN ${TERMINAL_STATUSES_SQL} AND completed_at IS NOT NULL AND completed_at < ?
       AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.epic_id = tasks.id)
     ORDER BY id`
  ).all(cutoff) as Array<{ id: number; title: string; status: string; completed_at: string }>
  const prunable = candidates.filter(t => !liveDeps.has(t.id))

  if (!apply) {
    console.log(`Dry run: ${prunable.length} task(s) older than ${days}d would be deleted (re-run with --apply):`)
    for (const t of prunable) console.log(`  #${t.id} ${t.status} ${t.completed_at} ${t.title}`)
  } else {
    const txn = db.transaction(() => {
      for (const t of prunable) db.run('DELETE FROM tasks WHERE id = ?', [t.id])
    })
    txn()
    console.log(`Deleted ${prunable.length} task(s) older than ${days}d (cutoff ${cutoff})`)
  }
} finally {
  closeDatabase(db)
}
