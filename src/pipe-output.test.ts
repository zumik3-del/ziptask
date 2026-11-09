import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import {
  handleCreateTask,
  handleListTasks,
  handleClaimTask,
  handleListQueue
} from './mcp/task-tools'
import { handleAddComment, handleGetTimeline } from './mcp/comment-tools'
import { handleCreateProject, handleListProjects } from './mcp/project-tools'
import { createTestDb, closeTestDb, json, text } from './test-context'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => {
  db = createTestDb()
  repo = new TaskRepo(db)
  svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' })
})
afterEach(() => {
  closeTestDb(db)
})

const NASTY = 'line1\r\n|line2\nline3\r'
const NASTY_SAFE = 'line1 /line2 line3 '

function rows(out: string): string[][] {
  return out.split('\n').map((line) => line.split('|'))
}

describe('pipe output cannot be broken by a value (#2243)', () => {
  test('list_queue renders a CR/LF/pipe title as one line of three columns', () => {
    const res = json(handleCreateTask(svc, { title: NASTY, reporter: 'dev' }))
    expect(res.id).toBeGreaterThan(0)
    const out = text(handleListQueue(svc, {}))
    expect(rows(out)).toHaveLength(1)
    const cols = rows(out)[0]
    expect(cols).toHaveLength(3)
    expect(cols[2]).toBe(NASTY_SAFE)
    expect(out).not.toContain('\r')
  })

  test('list_tasks ids mode keeps a CR/LF/pipe assignee inside its own column', () => {
    const id = json(handleCreateTask(svc, { title: 'Claimed', reporter: 'dev' })).id
    const claim = handleClaimTask(svc, { agent: NASTY, task_id: id })
    expect(claim.isError).toBeUndefined()
    const out = text(handleListTasks(svc, { ids: [id], fields: ['assignee'] }))
    expect(rows(out)).toHaveLength(1)
    const cols = rows(out)[0]
    expect(cols).toHaveLength(3)
    expect(cols[0]).toBe(String(id))
    expect(cols[2]).toBe(NASTY_SAFE)
    expect(out).not.toContain('\r')
  })

  test('get_timeline keeps a CR/LF/pipe agent and comment inside five columns per line', () => {
    const id = json(handleCreateTask(svc, { title: 'Timeline', reporter: 'dev' })).id
    const added = handleAddComment(svc, { id, agent: NASTY, content: NASTY })
    expect(added.isError).toBeUndefined()
    const out = text(handleGetTimeline(svc, { id }))
    const lines = rows(out)
    expect(lines).toHaveLength(2)
    for (const cols of lines) expect(cols).toHaveLength(5)
    expect(lines[1][2]).toBe(NASTY_SAFE)
    expect(lines[1][4]).toBe(NASTY_SAFE)
    expect(out).not.toContain('\r')
  })

  test('list_projects keeps a CR/LF/pipe folder path inside its own column', () => {
    const created = json(handleCreateProject(svc, { slug: 'evil', folder_path: `/tmp/x\r\n|y\nz` }))
    expect(created.slug).toBe('evil')
    const out = text(handleListProjects(svc, {}))
    const lines = rows(out)
    expect(lines).toHaveLength(2)
    for (const cols of lines) expect(cols).toHaveLength(3)
    const evil = lines.find((cols) => cols[0] === 'evil')
    expect(evil).toBeDefined()
    expect(evil![1]).toBe('/tmp/x /y z')
    expect(out).not.toContain('\r')
  })
})
