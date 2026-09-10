import { openDatabase, closeDatabase } from '../src/db/db'
import { TaskRepo } from '../src/db/repo'
import { computeMetrics } from '../src/core/metrics'

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}

const dbPath = parseArg('--db') ?? process.env.ZIPTASK_DB ?? './data/ziptask.db'
const periodRaw = parseArg('--period') ?? '24'

let period: number | 'all'
if (periodRaw === 'all') {
  period = 'all'
} else {
  const n = Number(periodRaw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Error: --period must be a positive number of hours or "all", got: ${periodRaw}`)
    process.exit(1)
  }
  period = n
}

const db = openDatabase(dbPath)
try {
  const repo = new TaskRepo(db)
  const m = computeMetrics(repo, period)
  const lines: string[] = [`done_count|${m.doneCount}`]
  for (const [status, mins] of Object.entries(m.statusTime).sort()) {
    lines.push(`status_time|${status}:${Math.round(mins)}`)
  }
  if (m.bottleneck) {
    lines.push(`bottleneck|${m.bottleneck.status}:${Math.round(m.bottleneck.minutes)}`)
  }
  console.log(lines.join('\n'))
} finally {
  closeDatabase(db)
}
