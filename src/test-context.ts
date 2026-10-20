import type { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso } from './core/tasks'
import type { TaskPriority } from './core/tasks'
import { openDatabase } from './db/db'
import type { ProjectRow, ProjectStore, Store } from './core/types'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { createLogger } from './logger'
import type { Logger } from './logger'
import { startHttp } from './server'
import type { StartHttpOptions } from './server'
import {
  handleClaimTask, handleGetTask, handleUpdateStatus
} from './mcp/task-tools'

export type CreateTaskRowOpts = {
  title: string
  reporter: string
  priority?: TaskPriority
  depends_on?: number[]
}

export const TEST_PROJECT_SLUG = 'test'

const TMP_DIR = '/tmp/opencode'

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
export function projectStoreStubs(): ProjectStore {
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

// A TaskStore whose every method is inert, so a test can hand a service a store without a DB
// and override only the calls it is about. Callers describe behaviour, not twenty default stubs.
// The stubs cover every store slice, so the narrowed service dependencies are satisfied by one.
export function taskStoreStubs(overrides: Partial<Store> = {}): Store {
  return {
    getTaskRow: () => null,
    insertTask: () => ({ id: 1, status: 'queued' }),
    deleteTask: () => {},
    listTasks: () => ({ rows: [], total: 0 }),
    queuedCandidates: () => [],
    depsOf: () => null,
    statusesOf: () => new Map(),
    batchTasks: () => new Map(),
    markClaimed: () => 0,
    transitionStatus: () => 0,
    transaction: <T>(fn: () => T) => fn(),
    expiredLeases: () => [],
    reapTransition: () => 0,
    insertComment: () => 1,
    auditAppend: () => {},
    timelineEntries: () => [],
    commentsOf: () => [],
    nonTerminalChildCount: () => 0,
    childStatusCounts: () => ({ total: 0, open: 0, done: 0, failed: 0, canceled: 0 }),
    promoteEpicWithMirror: () => 0,
    appendEpicAuditMirror: () => {},
    ...projectStoreStubs(),
    ...overrides
  }
}

// Test DBs live under /tmp/opencode: SQLite fsyncs on /mnt/external are ~30x slower.
export function makeTempDbPath(tag: string = 'test'): string {
  mkdirSync(TMP_DIR, { recursive: true })
  return join(TMP_DIR, `ziptask-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

export function removeTempDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(path + suffix) } catch {}
  }
}

export function createTestDb(): Database {
  const path = makeTempDbPath('test')
  const db = openDatabase(path)
  seedProject(db)
  ;(db as any).__path = path
  return db
}

export function closeTestDb(db: Database) {
  const path = (db as any).__path as string | undefined
  db.close()
  if (path !== undefined) removeTempDb(path)
}

export function insertTaskRow(repo: TaskRepo, opts: CreateTaskRowOpts): number {
  const deps = opts.depends_on ?? []
  const now = nowIso()
  const created = repo.insertTask({
    title: opts.title,
    description: null,
    priority: opts.priority ?? 'p2',
    assignee: null,
    reporter: opts.reporter,
    depends_on: JSON.stringify(deps),
    now,
    projectId: testProjectId(repo)
  })
  return created.id
}

export function getTaskRow(db: Database, id: number) {
  const row = db.query('SELECT * FROM tasks WHERE id = ?').get(id) as any
  return row ? { ...row, is_epic: row.is_epic !== 0 } : null
}

// The single `content[0].text` reader: every MCP tool result is unpacked through it.
export function textOf(res: any): string {
  return (res.content as any[])[0].text
}

export function text(res: any): string {
  return textOf(res)
}

export function json(res: any): any {
  return JSON.parse(textOf(res))
}

export function driveToDone(svc: TaskService, id: number, agent: string) {
  handleClaimTask(svc, { agent, task_id: id })
  const v1 = json(handleGetTask(svc, { id, fields: ['version'] })).version
  handleUpdateStatus(svc, { id, agent, status: 'review', version: v1 })
  const v2 = json(handleGetTask(svc, { id, fields: ['version'] })).version
  return handleUpdateStatus(svc, { id, agent, status: 'done', version: v2 })
}

export type TestServerOpts = {
  tag?: string
  logger?: Logger
  sessionTtlMs?: number
  maxSessions?: number
  host?: string
}

export type TestServer = {
  db: Database
  svc: TaskService
  port: number
  dbPath: string
  logger: Logger
  stop: () => void
}

// Boot/teardown for every HTTP test: temp DB + seeded project + service + logger + listener in
// one call, and a stop() that reverses all of it. Tests pass only what they vary (a capture
// logger, a session TTL, a session cap); everything else is the shared default.
export function startTestServer(opts: TestServerOpts = {}): TestServer {
  const dbPath = makeTempDbPath(opts.tag ?? 'server-test')
  const db = openDatabase(dbPath)
  seedProject(db)
  const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15, scope: TEST_PROJECT_SLUG })
  const logger = opts.logger ?? createLogger('test', 'off')
  const httpOpts: StartHttpOptions = { svc, port: 0, host: opts.host ?? '127.0.0.1', dbPath, logger }
  if (opts.sessionTtlMs !== undefined) httpOpts.sessionTtlMs = opts.sessionTtlMs
  if (opts.maxSessions !== undefined) httpOpts.maxSessions = opts.maxSessions
  const server = startHttp(httpOpts)
  let stopped = false
  return {
    db,
    svc,
    port: server.port ?? 0,
    dbPath,
    logger,
    stop: () => {
      if (stopped) return
      stopped = true
      server.stop()
      db.close()
      removeTempDb(dbPath)
    }
  }
}
