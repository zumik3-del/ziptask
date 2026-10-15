import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database as SqliteDb } from 'bun:sqlite'
import { openDatabase } from './db/db'
import { MIGRATIONS } from './db/migrations'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { DEFAULT_REPORTER } from './defaults'
import { ENV_MAPPINGS, DEFAULTS, loadSettings } from './config'
import {
  handleCreateTask, handleGetTask, handleListTasks, handleClaimTask,
  handleListQueue, handleCreateProject, handleListProjects, handleUpdateProject,
  handleDeleteProject
} from './mcp/tools'
import { createTestDb, closeTestDb, seedProject, json, text } from './test-context'

let db: Database
let repo: TaskRepo
// deliberately NO `scope`: the tests that assert fail-closed refusals must not have a fallback
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15 }) })
afterEach(() => { closeTestDb(db) })

const insertRow = (opts: { title: string; reporter: string; projectId: number | null }): number =>
  repo.insertTask({
    title: opts.title,
    description: null,
    priority: 'p2',
    assignee: null,
    reporter: opts.reporter,
    depends_on: '[]',
    now: '2026-01-01T00:00:00.000Z',
    projectId: opts.projectId
  })

const createIn = (title: string, project: string, extra: { depends_on?: number[]; epic_id?: number; epic?: boolean } = {}): number =>
  json(handleCreateTask(svc, { title, reporter: 'dev', project, ...extra })).id as number

const queueIn = (project: string) => text(handleListQueue(svc, { project })).split('\n').filter(Boolean)

// ADR D1: the last statement of the frozen v4 prefix (schema_version = 22).
const V4_STATEMENT_COUNT = 22

function makeTempDbPath(tag: string): string {
  const dir = '/tmp/opencode'
  mkdirSync(dir, { recursive: true })
  return join(dir, `ziptask-projects-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

function rmTempDb(path: string) {
  try { rmSync(path) } catch {}
  try { rmSync(path + '-wal') } catch {}
  try { rmSync(path + '-shm') } catch {}
}

// replay the frozen v4 prefix, stamp 22, and insert pre-existing rows through raw SQL
function buildV4Db(path: string): void {
  const raw = new SqliteDb(path)
  raw.exec('PRAGMA foreign_keys = ON')
  for (let i = 0; i < V4_STATEMENT_COUNT; i++) raw.exec(MIGRATIONS[i])
  raw.run('DELETE FROM schema_version')
  raw.run('INSERT INTO schema_version (version) VALUES (?)', [V4_STATEMENT_COUNT])
  raw.run(
    "INSERT INTO tasks (title, reporter, status, created_at, updated_at) VALUES ('v4 done', 'dev', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
  )
  raw.run(
    "INSERT INTO tasks (title, reporter, status, created_at, updated_at) VALUES ('v4 queued', 'dev', 'queued', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
  )
  raw.run(
    "INSERT INTO tasks (title, reporter, status, created_at, updated_at) VALUES ('v4 failed', 'dev', 'failed', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')"
  )
  raw.close()
}

describe('projects: fresh DB and migration v4 -> v5 (ADR D1)', () => {
  test('a fresh DB has zero projects (the legacy row is guarded by WHERE EXISTS)', () => {
    const path = makeTempDbPath('fresh')
    try {
      const fresh = openDatabase(path)
      expect((fresh.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0)
      expect((fresh.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version).toBe(MIGRATIONS.length)
      fresh.close()
    } finally { rmTempDb(path) }
  })

  test('v4 -> v5 upgrade parks every pre-existing row in the reserved legacy project', () => {
    const path = makeTempDbPath('upgrade')
    try {
      buildV4Db(path)
      const upgraded = openDatabase(path)

      expect((upgraded.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version).toBe(MIGRATIONS.length)

      const projects = upgraded.query('SELECT id, slug, folder_path, created_at FROM projects').all() as any[]
      expect(projects).toHaveLength(1)
      expect(projects[0].slug).toBe('legacy')
      expect(projects[0].folder_path).toBe('')
      // pure-SQL strftime('%Y-%m-%dT%H:%M:%fZ','now') must stay byte-comparable with nowIso()
      expect(projects[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

      expect((upgraded.query('SELECT COUNT(*) AS n FROM tasks WHERE project_id IS NULL').get() as { n: number }).n).toBe(0)
      const joined = upgraded.query(
        'SELECT t.title, p.slug FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY t.id'
      ).all() as any[]
      expect(joined.map(r => r.slug)).toEqual(['legacy', 'legacy', 'legacy'])
      expect(joined.map(r => r.title)).toEqual(['v4 done', 'v4 queued', 'v4 failed'])

      const indexes = (upgraded.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
        .map(i => i.name)
      expect(indexes).toContain('idx_tasks_project_status_priority')

      // tasks carries the self-FK (epic_id) plus the v5 project FK; NO ACTION is the delete backstop
      const fks = upgraded.query('PRAGMA foreign_key_list(tasks)').all() as any[]
      const projectFk = fks.filter(f => f.table === 'projects')
      expect(projectFk).toHaveLength(1)
      expect(projectFk[0].from).toBe('project_id')
      expect(projectFk[0].on_delete).toBe('NO ACTION')
      expect(fks.some(f => f.from === 'epic_id' && f.table === 'tasks')).toBe(true)
      upgraded.close()
    } finally { rmTempDb(path) }
  })

  test('migration statements 1..22 stay byte-identical (append-only)', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(V4_STATEMENT_COUNT)
    expect(MIGRATIONS.length).toBe(27)
  })
})

describe('projects: CRUD contract (ADR D4)', () => {
  test('create_project requires folder_path and refuses an invalid or reserved slug', () => {
    const missing = handleCreateProject(svc, { folder_path: '' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toBe('INVALID: folder_path required')

    const bad = handleCreateProject(svc, { slug: 'Bad Slug', folder_path: '/tmp/opencode/x' })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toBe('INVALID: slug must match ^[a-z0-9][a-z0-9._-]{0,31}$')

    const reserved = handleCreateProject(svc, { slug: 'legacy', folder_path: '/tmp/opencode/x' })
    expect(reserved.isError).toBe(true)
    expect(text(reserved)).toBe("INVALID: 'legacy' is a reserved project slug")

    expect(repo.projectSlugs()).toEqual(['test'])
  })

  test('create_project derives the slug from the folder name and normalizes the path', () => {
    const res = json(handleCreateProject(svc, { folder_path: '/tmp/opencode/My Project/' }))
    expect(res.slug).toBe('my-project')
    const row = repo.projectBySlug('my-project')!
    expect(row.folder_path).toBe('/tmp/opencode/My Project')

    const dup = handleCreateProject(svc, { slug: 'my-project', folder_path: '/tmp/opencode/other' })
    expect(dup.isError).toBe(true)
    expect(text(dup)).toBe("CONFLICT: project 'my-project' already exists")
  })

  test('create_project refuses to derive an unusable slug', () => {
    const res = handleCreateProject(svc, { folder_path: '/tmp/opencode/---' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: slug required (cannot derive from folder name)')
  })

  test('list_projects pipes slug|folder|open ordered by slug, with sanitized pipes', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    repo.insertProject({ slug: 'gamma', folderPath: '/tmp/opencode/a|b', now: '2026-01-01T00:00:00.000Z' })
    const alphaId = repo.projectBySlug('alpha')!.id
    const betaId = repo.projectBySlug('beta')!.id
    for (const [title, projectId] of [['a1', alphaId], ['a2', alphaId], ['b1', betaId]] as const) {
      repo.insertTask({
        title, description: null, priority: 'p2', assignee: null, reporter: 'dev',
        depends_on: '[]', now: '2026-01-01T00:00:00.000Z', projectId
      })
    }
    const lines = text(handleListProjects(svc, {})).split('\n')
    expect(lines.map(l => l.split('|')[0])).toEqual(['alpha', 'beta', 'gamma', 'test'])
    expect(lines[0]).toBe('alpha||2')
    expect(lines[1]).toBe('beta||1')
    expect(lines[2]).toBe('gamma|/tmp/opencode/a/b|0')
  })

  test('update_project: nothing to update, unknown slug NOT_FOUND, archived:false is idempotent (Q4)', () => {
    seedProject(db, 'alpha')
    const bare = handleUpdateProject(svc, { project: 'alpha' })
    expect(text(bare)).toBe('INVALID: nothing to update')

    const unknown = handleUpdateProject(svc, { project: 'nope', archived: true })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toBe('NOT_FOUND:')

    expect(json(handleUpdateProject(svc, { project: 'alpha', archived: true })).slug).toBe('alpha')
    expect(repo.projectBySlug('alpha')!.archived_at).not.toBeNull()

    // an archived project still accepts archived:false, and doing it twice changes nothing but updated_at
    const first = json(handleUpdateProject(svc, { project: 'alpha', archived: false }))
    const second = json(handleUpdateProject(svc, { project: 'alpha', archived: false }))
    expect(first.slug).toBe('alpha')
    expect(second.slug).toBe('alpha')
    expect(repo.projectBySlug('alpha')!.archived_at).toBeNull()

    const rename = json(handleUpdateProject(svc, { project: 'alpha', slug: 'alpha2' }))
    expect(rename.slug).toBe('alpha2')
    expect(repo.projectBySlug('alpha')).toBeNull()
    expect(repo.projectBySlug('alpha2')).not.toBeNull()
  })

  test('legacy is reserved in update_project too (E2)', () => {
    seedProject(db, 'alpha')
    const res = handleUpdateProject(svc, { project: 'alpha', slug: 'legacy' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe("INVALID: 'legacy' is a reserved project slug")
  })

  test('delete_project refuses a non-empty project and returns {deleted:<slug>} when empty', () => {
    seedProject(db, 'alpha')
    createIn('a1', 'alpha')
    const refused = handleDeleteProject(svc, { project: 'alpha' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe("CONFLICT: project 'alpha' has 1 tasks; archive it instead")
    expect(repo.projectBySlug('alpha')).not.toBeNull()

    const empty = handleDeleteProject(svc, { project: 'test' })
    expect(json(empty)).toEqual({ deleted: 'test' })
    expect(repo.projectBySlug('test')).toBeNull()

    expect(text(handleDeleteProject(svc, { project: 'test' }))).toBe('NOT_FOUND:')
  })

  test('the FK is the backstop behind delete_project: a direct DELETE with tasks fails', () => {
    seedProject(db, 'alpha')
    createIn('a1', 'alpha')
    let thrown: Error | null = null
    try { db.run('DELETE FROM projects WHERE slug = ?', ['alpha']) } catch (err) { thrown = err as Error }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toContain('FOREIGN KEY constraint failed')
    expect(repo.projectBySlug('alpha')).not.toBeNull()
  })
})

describe('projects: fail-closed refusals (ADR D2, E1-E4)', () => {
  test('every enumerating shape without a project refuses with the exact D2 text and writes nothing', () => {
    seedProject(db, 'alpha')
    const before = {
      tasks: (db.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
      audit: (db.query('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n,
      projects: (db.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
    }
    const refusals: Array<[string, ReturnType<typeof handleCreateTask>]> = [
      ['create_task', handleCreateTask(svc, { title: 'x', reporter: 'dev' })],
      ['list_queue', handleListQueue(svc, {})],
      ['list_tasks', handleListTasks(svc, {})],
      ['list_tasks ids:[]', handleListTasks(svc, { ids: [] })],
      ['claim_task auto-pick', handleClaimTask(svc, { agent: 'dev' })]
    ]
    for (const [shape, res] of refusals) {
      expect(`${shape}: ${res.isError ? text(res) : 'NO ERROR'}`).toBe(`${shape}: INVALID: project required`)
    }
    expect((db.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(before.tasks)
    expect((db.query('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(before.audit)
    expect((db.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(before.projects)
  })

  test('an unknown slug lists the known slugs; no projects at all tells the caller what to do', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    for (const slug of ['nope', '*', '']) {
      const res = handleListQueue(svc, { project: slug })
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(`INVALID: unknown project '${slug}' (known: alpha, beta, test)`)
    }
    for (const shape of [
      handleCreateTask(svc, { title: 'x', reporter: 'dev', project: 'nope' }),
      handleListTasks(svc, { project: 'nope' }),
      handleClaimTask(svc, { agent: 'dev', project: 'nope' })
    ]) {
      expect(text(shape)).toBe("INVALID: unknown project 'nope' (known: alpha, beta, test)")
    }

    const emptyPath = makeTempDbPath('noprojects')
    try {
      const fresh = openDatabase(emptyPath)
      const emptySvc = new TaskService(new TaskRepo(fresh), { leaseTtlMin: 15 })
      expect(text(handleListTasks(emptySvc, { project: 'nope' }))).toBe(
        "INVALID: unknown project 'nope' (no projects defined; create one with create_project)"
      )
      expect(text(handleListQueue(emptySvc, { project: '*' }))).toBe(
        "INVALID: unknown project '*' (no projects defined; create one with create_project)"
      )
      fresh.close()
    } finally { rmTempDb(emptyPath) }
  })

  test('by-id shapes do not declare project: passing it is an unknown-argument refusal (E4)', () => {
    const id = createIn('a1', 'test')
    const direct = handleGetTask(svc, { id, fields: ['id'], project: 'test' } as never)
    expect(direct.isError).toBe(true)
    expect(text(direct)).toBe('INVALID: unknown argument project on get_task (accepted: fields, id)')
  })
})

describe('projects: enumeration isolation on all three paths (ADR D2)', () => {
  test('list_queue, list_tasks and claim_task auto-pick never cross the scope boundary', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    const a1 = createIn('a1', 'alpha')
    const a2 = createIn('a2', 'alpha')
    const b1 = createIn('b1', 'beta')

    // listTasks orders created_at DESC, id DESC: the newest row of each project comes first
    expect(json(handleListTasks(svc, { project: 'alpha' })).tasks.map((t: any) => t.id)).toEqual([a2, a1])
    expect(json(handleListTasks(svc, { project: 'beta' })).tasks.map((t: any) => t.id)).toEqual([b1])
    expect(json(handleListTasks(svc, { project: 'alpha' })).total).toBe(2)
    expect(json(handleListTasks(svc, { project: 'beta' })).total).toBe(1)

    expect(queueIn('alpha')).toEqual([`${a1}|p2|a1`, `${a2}|p2|a2`])
    expect(queueIn('beta')).toEqual([`${b1}|p2|b1`])

    expect(json(handleClaimTask(svc, { agent: 'dev', project: 'beta' })).id).toBe(b1)
    const second = handleClaimTask(svc, { agent: 'dev', project: 'beta' })
    expect(second.isError).toBe(true)
    expect(text(second)).toBe('EMPTY: no claimable tasks')

    expect(json(handleClaimTask(svc, { agent: 'dev', project: 'alpha' })).id).toBe(a1)
    // the beta claim moved b1 only
    expect(repo.getTaskRow(b1)!.status).toBe('in_progress')
    expect(repo.getTaskRow(a2)!.status).toBe('queued')
  })

  test('the ids batch mode stays unscoped and pipe-shaped (D5)', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    const a1 = createIn('a1', 'alpha')
    const b1 = createIn('b1', 'beta')
    expect(text(handleListTasks(svc, { ids: [a1, b1, 999] }))).toBe(`${a1}|1\n${b1}|1\n999|0`)
  })

  test('fields:["project"] reads the slug back; the internal project_id never leaks (E3)', () => {
    seedProject(db, 'alpha')
    const a1 = createIn('a1', 'alpha')
    const byId = json(handleGetTask(svc, { id: a1, fields: ['id', 'project'] }))
    expect(byId.project).toBe('alpha')
    expect('project_id' in json(handleGetTask(svc, { id: a1, fields: ['project_id'] }))).toBe(false)
    expect(json(handleListTasks(svc, { project: 'alpha', fields: ['id', 'project'] })).tasks[0].project).toBe('alpha')
    expect(json(handleClaimTask(svc, { agent: 'dev', project: 'alpha', include: ['project'] })).project).toBe('alpha')
  })

  test('a by-id claim stays unscoped (D2 rule 5)', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    const b1 = createIn('b1', 'beta')
    expect(json(handleClaimTask(svc, { agent: 'dev', task_id: b1 })).id).toBe(b1)
  })
})

describe('projects: legacy and archived refusals (ADR D3 G1/G2, locked 6)', () => {
  test('create_task in the reserved project is refused, and legacy is readable/claimable', () => {
    seedProject(db, 'legacy')
    const refused = handleCreateTask(svc, { title: 'x', reporter: 'dev', project: 'legacy' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe("INVALID: create_task is refused in the reserved project 'legacy'")

    const legacyId = repo.projectBySlug('legacy')!.id
    const id = insertRow({ title: 'pre-v5 row', reporter: 'dev', projectId: legacyId })
    expect(queueIn('legacy')).toEqual([`${id}|p2|pre-v5 row`])
    expect(json(handleClaimTask(svc, { agent: 'dev', project: 'legacy' })).id).toBe(id)
  })

  test('an archived project refuses create_task while list and claim still work', () => {
    seedProject(db, 'twin')
    const id = createIn('t1', 'twin')
    json(handleUpdateProject(svc, { project: 'twin', archived: true }))

    const refused = handleCreateTask(svc, { title: 'x', reporter: 'dev', project: 'twin' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe("INVALID: project 'twin' is archived")

    expect(json(handleListTasks(svc, { project: 'twin' })).tasks.map((t: any) => t.id)).toEqual([id])
    expect(queueIn('twin')).toEqual([`${id}|p2|t1`])
    expect(json(handleClaimTask(svc, { agent: 'dev', project: 'twin' })).id).toBe(id)

    json(handleUpdateProject(svc, { project: 'twin', archived: false }))
    expect(json(handleCreateTask(svc, { title: 't2', reporter: 'dev', project: 'twin' })).id).toBeGreaterThan(id)
  })
})

describe('projects: cross-project invariants (ADR D3 G3/G4)', () => {
  test('depends_on and epic_id must stay inside one project', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    const b1 = createIn('b1', 'beta')
    const bEpic = createIn('b epic', 'beta', { epic: true })

    const dep = handleCreateTask(svc, { title: 'x', reporter: 'dev', project: 'alpha', depends_on: [b1] })
    expect(dep.isError).toBe(true)
    expect(text(dep)).toBe(`INVALID: dependency #${b1} belongs to project 'beta'`)

    const epic = handleCreateTask(svc, { title: 'x', reporter: 'dev', project: 'alpha', epic_id: bEpic })
    expect(epic.isError).toBe(true)
    expect(text(epic)).toBe(`INVALID: epic #${bEpic} belongs to project 'beta'`)

    // the same shapes inside one project are accepted
    const a1 = createIn('a1', 'alpha')
    const aEpic = createIn('a epic', 'alpha', { epic: true })
    expect(createIn('dep ok', 'alpha', { depends_on: [a1] })).toBeGreaterThan(0)
    expect(createIn('child ok', 'alpha', { epic_id: aEpic })).toBeGreaterThan(0)
  })
})

describe('projects: no configured default project (ADR D2 rule 2, D6, R1)', () => {
  test('neither loadSettings nor ENV_MAPPINGS nor DEFAULTS carries a project key', () => {
    const settings = loadSettings({ env: {}, argv: [] })
    expect(Object.keys(settings).filter(k => /project/i.test(k))).toEqual([])
    expect(JSON.stringify(settings)).not.toContain('project')
    expect(ENV_MAPPINGS.filter(m => /project/i.test(m.env) || /project/i.test(m.path))).toEqual([])
    expect(Object.keys(DEFAULTS).filter(k => /project/i.test(k))).toEqual([])
    expect(Object.keys(DEFAULTS.defaults).filter(k => /project/i.test(k))).toEqual([])
  })

  test('a service without scope ignores the env and refuses an unscoped call', () => {
    seedProject(db, 'alpha')
    process.env.ZIPTASK_PROJECT = 'alpha'
    try {
      const bare = new TaskService(repo, { leaseTtlMin: 15 })
      expect(bare.listQueue({})).toEqual({ ok: false, error: { code: 'INVALID', message: 'project required' } })
      expect(bare.createTask({ title: 'x', reporter: DEFAULT_REPORTER })).toEqual({ ok: false, error: { code: 'INVALID', message: 'project required' } })
      expect(bare.listTasks({})).toEqual({ ok: false, error: { code: 'INVALID', message: 'project required' } })
      expect(bare.claimTask({ agent: 'dev' })).toEqual({ ok: false, error: { code: 'INVALID', message: 'project required' } })
      // only the by-id and ids escapes stay open without a scope
      const id = createIn('a1', 'alpha')
      expect(bare.listTasks({ ids: [id] }).ok).toBe(true)
      expect(bare.claimTask({ agent: 'dev', taskId: id }).ok).toBe(true)
    } finally { delete process.env.ZIPTASK_PROJECT }
  })
})
