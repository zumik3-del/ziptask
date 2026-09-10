import type { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso } from './core/tasks'
import { openDatabase } from './db/db'
import type { TaskRepo } from './db/repo'
import type { TaskService } from './core/service'
import {
  handleClaimTask, handleGetTask, handleUpdateStatus
} from './mcp/tools'

export type CreateTaskRowOpts = {
  title: string
  reporter: string
  priority?: string
  depends_on?: number[]
}

export function createTestDb(): Database {
  const dir = '/tmp/opencode'
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `ziptask-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = openDatabase(path)
  ;(db as any).__path = path
  return db
}

export function closeTestDb(db: Database) {
  const path = (db as any).__path as string
  db.close()
  try { rmSync(path) } catch {}
  try { rmSync(path + '-wal') } catch {}
  try { rmSync(path + '-shm') } catch {}
}

export function insertTaskRow(repo: TaskRepo, opts: CreateTaskRowOpts): number {
  const deps = opts.depends_on ?? []
  const now = nowIso()
  const id = repo.insertTask({
    title: opts.title,
    description: null,
    priority: opts.priority ?? 'p2',
    assignee: null,
    reporter: opts.reporter,
    depends_on: JSON.stringify(deps),
    now
  })
  return id
}

export function getTaskRow(db: Database, id: number) {
  return db.query('SELECT * FROM tasks WHERE id = ?').get(id) as any
}

export function json(res: any): any {
  return JSON.parse(res.content[0].text)
}

export function text(res: any): string {
  return res.content[0].text
}

export function driveToDone(svc: TaskService, id: number, agent: string) {
  handleClaimTask(svc, { agent, task_id: id })
  const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
  handleUpdateStatus(svc, { id, agent, status: 'review', version: v1 })
  const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
  return handleUpdateStatus(svc, { id, agent, status: 'done', version: v2 })
}
