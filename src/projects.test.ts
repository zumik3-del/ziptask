import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { Database as SqliteDb } from 'bun:sqlite'
import { openDatabase } from './db/db'
import { MIGRATIONS } from './db/migrations'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { TERMINAL_STATUSES } from './core/tasks'
import { DEFAULT_REPORTER } from './defaults'
import { ENV_MAPPINGS, DEFAULTS, loadSettings } from './config'
import {
  handleCreateTask, handleGetTask, handleListTasks, handleClaimTask,
  handleListQueue, handleUpdateStatus
} from './mcp/task-tools'
import { handleAddComment, handleGetTimeline } from './mcp/comment-tools'
import {
  handleCreateProject, handleListProjects, handleUpdateProject, handleDeleteProject
} from './mcp/project-tools'
import { createTestDb, closeTestDb, seedProject, json, text, makeTempDbPath, removeTempDb } from './test-context'

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
  }).id

const createIn = (title: string, project: string, extra: { depends_on?: number[]; epic_id?: number; epic?: boolean } = {}): number =>
  json(handleCreateTask(svc, { title, reporter: 'dev', project, ...extra })).id as number

const queueIn = (project: string) => text(handleListQueue(svc, { project })).split('\n').filter(Boolean)

// ADR D1: the last statement of the frozen v4 prefix (schema_version = 22).
const V4_STATEMENT_COUNT = 22

// SHA-256 over JSON.stringify(MIGRATIONS.slice(0, 22)) at the v5 release. The released prefix is
// frozen, so an edit to any of the 22 statements must fail here; appended statements (index >= 22)
// are not covered. Regenerate the constant (it prints on one line) with:
//   bun -e 'import {MIGRATIONS} from "./src/db/migrations"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(JSON.stringify(MIGRATIONS.slice(0,22))).digest("hex"))'
const FROZEN_V4_PREFIX_SHA256 = '15b4ea25663d669f5fcb6fec57e0d85cd8433994a9b56c369f811029cb1fb016'

// `list_projects` pipes `slug|folder|open`; the open column is the only thing these tests read.
function openCountOf(slug: string): string | undefined {
  const line = text(handleListProjects(svc, {})).split('\n').find(l => l.startsWith(`${slug}|`))
  return line?.split('|')[2]
}

// A raw status flip: the fixture is the state, not the transition (the counter does not care how
// a row reached a terminal status, and driving each one through the full lifecycle only adds flake).
function setStatus(id: number, status: string): void {
  db.run('UPDATE tasks SET status = ? WHERE id = ?', [status, id])
}

// Pin a past timestamp so "updated_at moved" is decidable without racing the millisecond clock.
function setUpdatedAt(slug: string, iso: string): void {
  db.run('UPDATE projects SET updated_at = ? WHERE slug = ?', [iso, slug])
}

// The `open` counter as a predicate rather than a number, built from the production status tuple
// (not a re-typed literal): it names which rows the tool counted, so a filter that keeps or drops
// the wrong status fails on the member list and not only on the total.
function openTaskTitles(project: string): string[] {
  const terminal = TERMINAL_STATUSES.map(s => `'${s}'`).join(', ')
  return (db.query(`
    SELECT t.title FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.slug = ? AND t.status NOT IN (${terminal})
    ORDER BY t.id
  `).all(project) as { title: string }[]).map(r => r.title)
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

// A successful `ToolResult` carries no `isError` at all, so `toBe(false)` is not an available
// assertion on the success path; parse the body instead, which fails loudly on an error payload.
function okJson(res: ToolResult): any {
  expect(res.isError).toBeUndefined()
  return json(res)
}

// replay the frozen v4 prefix, stamp 22, and insert pre-existing rows through raw SQL
function buildV4Db(path: string): void {
  const raw = new SqliteDb(path)
  // PRAGMA foreign_keys stays OUTSIDE the transaction: it is a no-op while a transaction is open.
  raw.exec('PRAGMA foreign_keys = ON')
  // One transaction: the replay is 22 DDL statements plus 5 writes, and one commit per statement
  // is what made this fixture slow. DDL inside a transaction is what production does too
  // (src/db/db.ts applyMigrations).
  const build = raw.transaction(() => {
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
  })
  build()
  raw.close()
}

describe('projects: fresh DB and migration v4 -> v5 (ADR D1)', () => {
  test('a fresh DB has zero projects (the legacy row is guarded by WHERE EXISTS)', () => {
    const path = makeTempDbPath('projects-fresh')
    try {
      const fresh = openDatabase(path)
      expect((fresh.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0)
      expect((fresh.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version).toBe(MIGRATIONS.length)
      fresh.close()
    } finally { removeTempDb(path) }
  })

  test('v4 -> v5 upgrade parks every pre-existing row in the reserved legacy project', () => {
    const path = makeTempDbPath('projects-upgrade')
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
    } finally { removeTempDb(path) }
  })

  test('migration statements 1..22 stay byte-identical (append-only)', () => {
    const frozen = MIGRATIONS.slice(0, V4_STATEMENT_COUNT)
    expect(frozen).toHaveLength(V4_STATEMENT_COUNT)
    expect(createHash('sha256').update(JSON.stringify(frozen)).digest('hex')).toBe(FROZEN_V4_PREFIX_SHA256)
    // a released statement must never be dropped or rewritten in place; only appended
    expect(MIGRATIONS.length).toBeGreaterThan(V4_STATEMENT_COUNT)
    expect(MIGRATIONS.length).toBe(32)
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

  test('create_project derives the slug from the folder name and strips the trailing slash', () => {
    const res = json(handleCreateProject(svc, { folder_path: '/tmp/opencode/My Project/' }))
    expect(res.slug).toBe('my-project')
    const row = repo.projectBySlug('my-project')!
    expect(row.folder_path).toBe('/tmp/opencode/My Project')

    // an explicit slug does not skip normalization
    expect(json(handleCreateProject(svc, { slug: 'rawname', folder_path: '/srv/only-slash/' })).slug).toBe('rawname')
    expect(repo.projectBySlug('rawname')!.folder_path).toBe('/srv/only-slash')
    expect(openCountOf('rawname')).toBe('0')

    const dup = handleCreateProject(svc, { slug: 'my-project', folder_path: '/tmp/opencode/other' })
    expect(dup.isError).toBe(true)
    expect(text(dup)).toBe("CONFLICT: project 'my-project' already exists")
  })

  test('create_project refuses a relative folder_path and accepts any absolute one (no existence check)', () => {
    const relative = handleCreateProject(svc, { folder_path: 'relative/folder' })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toBe('INVALID: folder_path must be an absolute path')

    const dotRelative = handleCreateProject(svc, { slug: 'rel2', folder_path: './x' })
    expect(dotRelative.isError).toBe(true)
    expect(text(dotRelative)).toBe('INVALID: folder_path must be an absolute path')

    expect(repo.projectBySlug('rel2')).toBeNull()
    expect(repo.projectSlugs()).toEqual(['test'])
    // empty stays a different refusal, not the new one
    expect(text(handleCreateProject(svc, { folder_path: '' }))).toBe('INVALID: folder_path required')

    // RL1: folder_path is a caller-side annotation, so nothing is stat()ed and nothing must exist
    const missing = json(handleCreateProject(svc, { slug: 'ghost', folder_path: '/nope/does/not/exist' }))
    expect(missing.slug).toBe('ghost')
    expect(repo.projectBySlug('ghost')!.folder_path).toBe('/nope/does/not/exist')
  })

  test('create_project refuses to derive an unusable slug', () => {
    const res = handleCreateProject(svc, { folder_path: '/tmp/opencode/---' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: slug required (cannot derive from folder name)')
  })

  test('list_projects pipes slug|folder|open ordered by slug, with sanitized pipes', () => {
    // One transaction for the whole fixture: one WAL commit instead of one per seeded row.
    repo.transaction(() => {
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
    })
    const lines = text(handleListProjects(svc, {})).split('\n')
    expect(lines.map(l => l.split('|')[0])).toEqual(['alpha', 'beta', 'gamma', 'test'])
    expect(lines[0]).toBe('alpha||2')
    expect(lines[1]).toBe('beta||1')
    expect(lines[2]).toBe('gamma|/tmp/opencode/a/b|0')
  })

  test('the open column counts non-terminal tasks only, through the tool shape the reader sees', () => {
    // One transaction for the whole fixture: one WAL commit instead of one per seeded row.
    let a2 = 0
    repo.transaction(() => {
      seedProject(db, 'alpha')
      seedProject(db, 'beta')
      seedProject(db, 'gamma')
      createIn('a1', 'alpha')                  // queued
      a2 = createIn('a2', 'alpha')             // in_progress
      const a3 = createIn('a3', 'alpha')       // done
      const a4 = createIn('a4', 'alpha')       // failed
      const a5 = createIn('a5', 'alpha')       // canceled
      createIn('b1', 'beta')                   // queued
      const g1 = createIn('g1', 'gamma')       // done
      const g2 = createIn('g2', 'gamma')       // failed
      const g3 = createIn('g3', 'gamma')       // canceled
      json(handleClaimTask(svc, { agent: 'dev', task_id: a2 }))
      for (const [id, status] of [[a3, 'done'], [a4, 'failed'], [a5, 'canceled'], [g1, 'done'], [g2, 'failed'], [g3, 'canceled']] as const) {
        setStatus(id, status)
      }
    })
    // a2's in_progress comes from the real claim, so an over-broad "open = queued only" fails here
    expect(repo.getTaskRow(a2)!.status).toBe('in_progress')
    // the counted set, as an oracle: a filter that keeps a terminal status counts 3+, one that
    // counts every row counts 5; only the exact non-terminal set gives these members
    expect(openTaskTitles('alpha')).toEqual(['a1', 'a2'])
    expect(openTaskTitles('beta')).toEqual(['b1'])
    expect(openTaskTitles('gamma')).toEqual([])

    // alpha: 5 rows, 2 live -> the three terminal statuses are all excluded, not just one spelling
    expect(openCountOf('alpha')).toBe('2')
    expect(openCountOf('beta')).toBe('1')
    // gamma: every row terminal -> the count must reach zero, so a missing filter is visible
    expect(openCountOf('gamma')).toBe('0')
    expect(text(handleListProjects(svc, {}))).toBe(
      ['alpha||2', 'beta||1', 'gamma||0', 'test||0'].join('\n')
    )
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

  test('update_project with only folder_path rewrites that column alone and bumps updated_at', () => {
    seedProject(db, 'alpha')
    // pin the pre-state to a past instant: comparing two nowIso() calls in the same millisecond is
    // the known lease flake, so the assertion must not depend on the clock ticking between two calls
    setUpdatedAt('alpha', '2026-01-01T00:00:00.000Z')
    const before = repo.projectBySlug('alpha')!
    const res = handleUpdateProject(svc, { project: 'alpha', folder_path: '/srv/work/alpha/' })
    expect(res.isError).toBeUndefined()
    expect(json(res)).toEqual({ slug: 'alpha' })

    const after = repo.projectBySlug('alpha')!
    expect(after.folder_path).toBe('/srv/work/alpha')        // trailing slash stripped
    expect(after.slug).toBe(before.slug)
    expect(after.created_at).toBe(before.created_at)
    expect(after.archived_at).toBe(before.archived_at)
    expect(after.archived_at).toBeNull()
    expect(after.updated_at).not.toBe(before.updated_at)

    // archived_at untouched means staying archived, not being silently unarchived
    seedProject(db, 'beta')
    json(handleUpdateProject(svc, { project: 'beta', archived: true }))
    const archivedAt = repo.projectBySlug('beta')!.archived_at
    expect(archivedAt).not.toBeNull()
    expect(json(handleUpdateProject(svc, { project: 'beta', folder_path: '/srv/work/beta' })).slug).toBe('beta')
    expect(repo.projectBySlug('beta')!.archived_at).toBe(archivedAt)
    expect(repo.projectBySlug('beta')!.folder_path).toBe('/srv/work/beta')
  })

  test('update_project refuses a relative folder_path and keeps the stored one (E7)', () => {
    seedProject(db, 'alpha')
    setUpdatedAt('alpha', '2026-01-01T00:00:00.000Z')
    const before = repo.projectBySlug('alpha')!
    const res = handleUpdateProject(svc, { project: 'alpha', folder_path: 'sub/dir' })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe('INVALID: folder_path must be an absolute path')
    expect(repo.projectBySlug('alpha')!.folder_path).toBe(before.folder_path)
    expect(repo.projectBySlug('alpha')!.updated_at).toBe(before.updated_at)

    // an existing directory is still not enough: absolute is the whole rule
    const relativeToCwd = handleUpdateProject(svc, { project: 'alpha', folder_path: 'src' })
    expect(text(relativeToCwd)).toBe('INVALID: folder_path must be an absolute path')

    // an absolute path is accepted with no existence check here either
    expect(json(handleUpdateProject(svc, { project: 'alpha', folder_path: '/nope/does/not/exist' })).slug).toBe('alpha')
    expect(repo.projectBySlug('alpha')!.folder_path).toBe('/nope/does/not/exist')
  })

  test('two projects may share one folder_path (RL1: folder_path is not a key)', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    const shared = '/srv/work/shared'
    expect(okJson(handleUpdateProject(svc, { project: 'alpha', folder_path: shared }))).toEqual({ slug: 'alpha' })
    expect(okJson(handleUpdateProject(svc, { project: 'beta', folder_path: shared }))).toEqual({ slug: 'beta' })
    expect(repo.projectBySlug('alpha')!.folder_path).toBe(shared)
    expect(repo.projectBySlug('beta')!.folder_path).toBe(shared)

    const created = handleCreateProject(svc, { slug: 'gamma', folder_path: shared })
    expect(created.isError).toBeUndefined()
    expect(repo.projectBySlug('gamma')!.folder_path).toBe(shared)
    expect(text(handleListProjects(svc, {}))).toBe(
      ['alpha|/srv/work/shared|0', 'beta|/srv/work/shared|0', 'gamma|/srv/work/shared|0', 'test||0'].join('\n')
    )
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

  test('delete_project is gated on projectTaskCount: terminal tasks still block, an empty project passes', () => {
    // a task that is terminal is still a task: the precondition counts rows, not open work
    seedProject(db, 'alpha')
    const a1 = createIn('a1', 'alpha')
    setStatus(a1, 'done')
    const refused = handleDeleteProject(svc, { project: 'alpha' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe("CONFLICT: project 'alpha' has 1 tasks; archive it instead")
    expect(repo.projectTaskCount(repo.projectBySlug('alpha')!.id)).toBe(1)
    expect(repo.projectBySlug('alpha')).not.toBeNull()

    // the same project with its last row gone drops to zero and becomes deletable
    db.run('DELETE FROM tasks WHERE id = ?', [a1])
    expect(repo.projectTaskCount(repo.projectBySlug('alpha')!.id)).toBe(0)
    expect(json(handleDeleteProject(svc, { project: 'alpha' }))).toEqual({ deleted: 'alpha' })
    expect(repo.projectBySlug('alpha')).toBeNull()

    // an empty project that never held a task: count 0, deleted, and its folder is free again
    const empty = json(handleCreateProject(svc, { slug: 'empty', folder_path: '/srv/work/empty' }))
    expect(empty.slug).toBe('empty')
    expect(repo.projectTaskCount(repo.projectBySlug('empty')!.id)).toBe(0)
    expect(json(handleDeleteProject(svc, { project: 'empty' }))).toEqual({ deleted: 'empty' })
    expect(repo.projectBySlug('empty')).toBeNull()
    expect(repo.projectSlugs()).toEqual(['test'])
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

    const emptyPath = makeTempDbPath('projects-noprojects')
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
    } finally { removeTempDb(emptyPath) }
  })

  test('by-id shapes do not declare project: passing it is an unknown-argument refusal (E4)', () => {
    const id = createIn('a1', 'test')
    const direct = handleGetTask(svc, { id, fields: ['id'], project: 'test' } as never)
    expect(direct.isError).toBe(true)
    expect(text(direct)).toBe('INVALID: unknown argument project on get_task (accepted: fields, id)')

    // one enum per by-id tool: the guard reads the shape literal, so the accepted list is the contract
    const refusal = 'INVALID: unknown argument project on'
    expect(text(handleUpdateStatus(svc, { id, agent: 'dev', status: 'review', project: 'test' } as never)))
      .toBe(`${refusal} update_status (accepted: agent, comment, id, renew, reset_attempts, status, version)`)
    expect(text(handleAddComment(svc, { id, agent: 'dev', content: 'x', project: 'test' } as never)))
      .toBe(`${refusal} add_comment (accepted: agent, comment, content, id, text)`)
    expect(text(handleGetTimeline(svc, { id, project: 'test' } as never)))
      .toBe(`${refusal} get_timeline (accepted: id, limit)`)

    // refused, not applied: the row and its version are untouched, and no comment was appended
    expect(json(handleGetTask(svc, { id, fields: ['status', 'version'] }))).toEqual({ status: 'queued', version: 1 })
    expect((db.query('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })

  test('a by-id claim ignores the project argument entirely: a bogus slug still claims (D2 rule 5)', () => {
    seedProject(db, 'alpha')
    seedProject(db, 'beta')
    const b1 = createIn('b1', 'beta')
    const bogus = handleClaimTask(svc, { agent: 'dev', task_id: b1, project: 'bogus-slug' })
    expect(json(bogus).id).toBe(b1)
    expect(json(bogus).lease_ttl_min).toBe(15)
    expect(repo.getTaskRow(b1)!.status).toBe('in_progress')
    expect(repo.getTaskRow(b1)!.assignee).toBe('dev')

    // the same value on the auto-pick branch is validated, because that branch is the scoped one
    expect(text(handleClaimTask(svc, { agent: 'dev', project: 'bogus-slug' })))
      .toBe("INVALID: unknown project 'bogus-slug' (known: alpha, beta, test)")
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
      expect(bare.getTasksByIds([id]).ok).toBe(true)
      expect(bare.claimTask({ agent: 'dev', taskId: id }).ok).toBe(true)
    } finally { delete process.env.ZIPTASK_PROJECT }
  })
})
