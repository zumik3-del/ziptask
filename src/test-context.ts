import type { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso } from './core/tasks'
import type { TaskPriority } from './core/tasks'
import { openDatabase } from './db/db'
import type { ProjectRow, TaskStore } from './core/types'
import type { TaskRepo } from './db/repo'
import type { TaskService } from './core/service'
import {
  handleClaimTask, handleGetTask, handleUpdateStatus
} from './mcp/tools'

export type CreateTaskRowOpts = {
  title: string
  reporter: string
  priority?: TaskPriority
  depends_on?: number[]
}

export const TEST_PROJECT_SLUG = 'test'

// The seeded row every test-scoped service resolves through `scope`; a fresh DB has no projects.
export function seedProject(db: Database, slug: string = TEST_PROJECT_SLUG): number {
  const now = nowIso()
  const result = db.run(
    'INSERT INTO projects (slug, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [slug, '', now, now]
  )
  return Number(result.lastInsertRowid)
}

export function testProjectId(repo: TaskRepo): number {
  return repo.projectBySlug(TEST_PROJECT_SLUG)!.id
}

export function testProjectRow(): ProjectRow {
  return { id: 1, slug: TEST_PROJECT_SLUG, folder_path: '', created_at: '', updated_at: '', archived_at: null }
}

// The project half of a hand-rolled TaskStore literal: only `test` resolves, so a fixture store
// behaves like a seeded test DB without duplicating seven stubs per literal.
export function projectStoreStubs(): Pick<TaskStore,
  'insertProject' | 'projectBySlug' | 'projectSlugs' | 'listProjects' | 'updateProject' | 'deleteProject' | 'projectTaskCount'> {
  return {
    insertProject: () => 1,
    projectBySlug: (slug: string) => slug === TEST_PROJECT_SLUG ? testProjectRow() : null,
    projectSlugs: () => [TEST_PROJECT_SLUG],
    listProjects: () => [],
    updateProject: () => 0,
    deleteProject: () => 0,
    projectTaskCount: () => 0
  }
}

export function createTestDb(): Database {
  const dir = '/tmp/opencode'
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `ziptask-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = openDatabase(path)
  seedProject(db)
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
    now,
    projectId: testProjectId(repo)
  })
  return id
}

export function getTaskRow(db: Database, id: number) {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(id) as any
  return row ? { ...row, is_epic: row.is_epic !== 0 } : null
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
