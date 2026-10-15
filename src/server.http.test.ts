import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TaskService } from './core/service'
import { VERSION } from './version'
import { startTestServer, textOf } from './test-context'
import type { TestServer } from './test-context'

// The HTTP/MCP surface: the task-view endpoint, the schema guards in front of the tools, and the
// argument contract as it reaches the wire. Session lifecycle and the event store live in the
// sibling files (server.session.test.ts, server.event-store.test.ts).

function getId(result: ReturnType<TaskService['createTask']>): number {
  if (!result.ok) throw new Error('createTask failed')
  return result.data.id
}

function getVersion(db: Database, id: number): number {
  return (db.query('SELECT version FROM tasks WHERE id = ?').get(id) as { version: number }).version
}

describe('GET /api/task/:id HTTP endpoint', () => {
  let srv: TestServer

  beforeEach(() => { srv = startTestServer() })
  afterEach(() => { srv.stop() })

  test('health returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.version).toBe(VERSION)
  })

  test('GET /api/task/:id → 200 with task, blocked_by, comments', async () => {
    const id = getId(srv.svc.createTask({ title: 'Test task', reporter: 'dev', description: 'a desc' }))
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/${id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.task).toBeDefined()
    expect(body.task.id).toBe(id)
    expect(body.task.title).toBe('Test task')
    expect(Array.isArray(body.blocked_by)).toBe(true)
    expect(body.blocked_by).toEqual([])
    expect(Array.isArray(body.comments)).toBe(true)
    expect(body.comments.length).toBe(0)
  })

  test('comments are in chronological order with expected shape', async () => {
    const id = getId(srv.svc.createTask({ title: 'Commented', reporter: 'dev', description: 'initial desc' }))
    srv.svc.addComment({ id, agent: 'alice', content: 'first comment' })
    srv.svc.addComment({ id, agent: 'bob', content: 'second comment' })

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/${id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.comments.length).toBe(2)
    expect(body.comments[0].content).toBe('first comment')
    expect(body.comments[0].agent).toBe('alice')
    expect(body.comments[0].type).toBe('comment')
    expect(body.comments[0]).toHaveProperty('id')
    expect(body.comments[0]).toHaveProperty('created_at')
    expect(body.comments[1].content).toBe('second comment')
    expect(body.comments[1].agent).toBe('bob')
    expect(new Date(body.comments[0].created_at) <= new Date(body.comments[1].created_at)).toBe(true)
  })

  test('resolution comment type is preserved', async () => {
    const id = getId(srv.svc.createTask({ title: 'Resolution task', reporter: 'dev' }))
    // drive through claim + review to done
    const claimOk = srv.svc.claimTask({ agent: 'tester', taskId: id })
    expect(claimOk.ok).toBe(true)
    const v1 = getVersion(srv.db, id)
    const reviewOk = srv.svc.updateStatus({ id, agent: 'tester', status: 'review', version: v1 })
    expect(reviewOk.ok).toBe(true)
    const v2 = getVersion(srv.db, id)
    const doneOk = srv.svc.updateStatus({ id, agent: 'tester', status: 'done', version: v2, comment: 'all good' })
    expect(doneOk.ok).toBe(true)

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/${id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const resolutionComment = body.comments.find((c: any) => c.type === 'resolution')
    expect(resolutionComment).toBeDefined()
    expect(resolutionComment.content).toBe('all good')
    expect(resolutionComment.agent).toBe('tester')
  })

  test('subtasks present for epic, omitted for plain task', async () => {
    const plainId = getId(srv.svc.createTask({ title: 'Plain', reporter: 'dev' }))
    const plainRes = await fetch(`http://127.0.0.1:${srv.port}/api/task/${plainId}`)
    const plainBody = await plainRes.json() as any
    expect(plainBody.subtasks).toBeUndefined()

    const epicResult = srv.svc.createTask({ title: 'Epic root', reporter: 'dev', epic: true })
    expect(epicResult.ok).toBe(true)
    const epicId = (epicResult as { ok: true; data: { id: number } }).data.id
    const subResult = srv.svc.createTask({ title: 'Sub of epic', reporter: 'dev', epic_id: epicId })
    expect(subResult.ok).toBe(true)
    const epicRes = await fetch(`http://127.0.0.1:${srv.port}/api/task/${epicId}`)
    const epicBody = await epicRes.json() as any
    expect(epicBody.subtasks).toBeDefined()
    expect(epicBody.subtasks.total).toBe(1)
    expect(epicBody.subtasks.open).toBe(1)
  })

  test('non-numeric id → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/abc`)
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBeDefined()
  })

  test('empty id → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/`)
    expect(res.status).toBe(400)
  })

  test('unknown id → 404', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/99999`)
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error).toBeDefined()
  })

  test('blocked_by populated for task with unsatisfied deps', async () => {
    const depId = getId(srv.svc.createTask({ title: 'Dependency', reporter: 'dev' }))
    const id = getId(srv.svc.createTask({ title: 'Dependent', reporter: 'dev', depends_on: [depId] }))
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/${id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.blocked_by).toEqual([depId])
  })

  test('blocked_by empty when all deps satisfied', async () => {
    const depId = getId(srv.svc.createTask({ title: 'Done dep', reporter: 'dev' }))
    // drive dep to done via claim + two status transitions
    const claimOk = srv.svc.claimTask({ agent: 'dev', taskId: depId })
    expect(claimOk.ok).toBe(true)
    const v1 = getVersion(srv.db, depId)
    const reviewOk = srv.svc.updateStatus({ id: depId, agent: 'dev', status: 'review', version: v1 })
    expect(reviewOk.ok).toBe(true)
    const v2 = getVersion(srv.db, depId)
    const doneOk = srv.svc.updateStatus({ id: depId, agent: 'dev', status: 'done', version: v2 })
    expect(doneOk.ok).toBe(true)

    const id = getId(srv.svc.createTask({ title: 'Satisfied', reporter: 'dev', depends_on: [depId] }))
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/${id}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.blocked_by).toEqual([])
  })
})

describe('MCP schema guards (#431)', () => {
  let srv: TestServer
  let client: Client

  beforeEach(async () => {
    srv = startTestServer()
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    client = new Client({ name: 'schema-guard-test', version: '1.0.0' })
    await client.connect(transport)
  })

  afterEach(async () => {
    try { await client.close() } catch {}
    srv.stop()
  })

  test('updated_since out of zod range is rejected by MCP layer', async () => {
    const tooHigh = await client.callTool({
      name: 'list_tasks',
      arguments: { updated_since: 8.64e15 + 1 }
    })
    expect(tooHigh.isError).toBe(true)

    const tooLow = await client.callTool({
      name: 'list_tasks',
      arguments: { updated_since: -8.64e15 - 1 }
    })
    expect(tooLow.isError).toBe(true)
  })

  test('updated_since 0 and in-range future are accepted by MCP layer', async () => {
    await client.callTool({
      name: 'create_task',
      arguments: { title: 'SinceTest', reporter: 'dev' }
    })
    const all = await client.callTool({ name: 'list_tasks', arguments: { updated_since: 0, project: 'test' } })
    expect(textOf(all)).not.toBeNull()

    const future = await client.callTool({ name: 'list_tasks', arguments: { updated_since: Date.now() + 60_000, project: 'test' } })
    expect(textOf(future)).toContain('0')
  })

  test('list_tasks status enum rejects an unknown status and accepts a valid one', async () => {
    const bad = await client.callTool({ name: 'list_tasks', arguments: { status: 'invalid_status' } })
    expect(bad.isError).toBe(true)

    const good = await client.callTool({ name: 'list_tasks', arguments: { status: 'queued', project: 'test' } })
    expect(good.isError).toBeUndefined()
  })
})

describe('argument contract over MCP (F1 #1040)', () => {
  let srv: TestServer
  let client: Client

  beforeEach(async () => {
    srv = startTestServer()
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    client = new Client({ name: 'arg-contract-test', version: '1.0.0' })
    await client.connect(transport)
  })

  afterEach(async () => {
    try { await client.close() } catch {}
    srv.stop()
  })

  function storeSnapshot() {
    return {
      tasks: srv.db.query('SELECT id, status, version, assignee, attempts, lease_expires_at FROM tasks ORDER BY id').all(),
      audit: srv.db.query('SELECT id, task_id, agent, action FROM audit_log ORDER BY id').all(),
      comments: srv.db.query('SELECT id, task_id, content FROM comments ORDER BY id').all()
    }
  }

  describe('claim_task id alias', () => {
    test('id alone claims exactly that task over the wire (alias survives parsing)', async () => {
      const bait = getId(srv.svc.createTask({ title: 'Bait', reporter: 'dev', priority: 'p0' }))
      const target = getId(srv.svc.createTask({ title: 'Alias target', reporter: 'dev', priority: 'p3' }))

      const res: any = await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', id: target } })
      expect(res.isError).toBeUndefined()
      expect(JSON.parse(textOf(res)).id).toBe(target)
      expect((srv.db.query('SELECT status FROM tasks WHERE id = ?').get(target) as any).status).toBe('in_progress')
      // The p0 bait is what auto-pick would have taken: it must be untouched.
      expect((srv.db.query('SELECT status FROM tasks WHERE id = ?').get(bait) as any).status).toBe('queued')
    })

    test('task_id alone still claims that task (canonical name byte-identical)', async () => {
      const target = getId(srv.svc.createTask({ title: 'Canonical', reporter: 'dev', priority: 'p0' }))
      const res: any = await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', task_id: target } })
      expect(JSON.parse(textOf(res)).id).toBe(target)
    })

    test('id and task_id equal → claims without error', async () => {
      const target = getId(srv.svc.createTask({ title: 'BothEqual', reporter: 'dev' }))
      const res: any = await client.callTool({
        name: 'claim_task', arguments: { agent: 'tester', id: target, task_id: target }
      })
      expect(res.isError).toBeUndefined()
      expect(JSON.parse(textOf(res)).id).toBe(target)
    })

    test('id and task_id disagree → isError, nothing claimed', async () => {
      const a = getId(srv.svc.createTask({ title: 'A', reporter: 'dev' }))
      const b = getId(srv.svc.createTask({ title: 'B', reporter: 'dev' }))
      const before = storeSnapshot()

      const res: any = await client.callTool({
        name: 'claim_task', arguments: { agent: 'tester', id: a, task_id: b }
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toBe(`INVALID: claim_task id/task_id conflict (id=${a} task_id=${b}); task_id is canonical`)
      expect(storeSnapshot()).toEqual(before)
    })
  })

  describe('unknown-argument rejection', () => {
    test('claim_task with a bogus key is rejected and the task stays claimable', async () => {
      const target = getId(srv.svc.createTask({ title: 'Intended', reporter: 'dev', priority: 'p0' }))

      const res: any = await client.callTool({
        name: 'claim_task', arguments: { agent: 'tester', id: target, bogus: 1 }
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('INVALID: unknown argument bogus')

      const queue = textOf(await client.callTool({ name: 'list_queue', arguments: { project: 'test' } }))
      expect(queue).toContain(`${target}|p0|Intended`)

      // Still genuinely claimable afterwards — no lease, no attempts bump.
      const claim: any = await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', id: target } })
      expect(JSON.parse(textOf(claim)).id).toBe(target)
    })

    test('get_task with a bogus key is rejected (rejection is global, not claim_task-specific)', async () => {
      const id = getId(srv.svc.createTask({ title: 'Read', reporter: 'dev' }))
      const res: any = await client.callTool({ name: 'get_task', arguments: { id, field: 'x' } })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toBe('INVALID: unknown argument field on get_task (accepted: fields, id)')
    })

    test('every one of the 13 tools rejects an unknown key, and the accepted list matches tools/list', async () => {
      const id = getId(srv.svc.createTask({ title: 'Base', reporter: 'dev', priority: 'p0' }))
      const version = getVersion(srv.db, id)
      const listed = await client.listTools()
      const schemas = new Map<string, any>(
        (listed.tools as any[]).map(t => [t.name, t.inputSchema as any])
      )
      expect(schemas.size).toBe(13)

      const calls: Array<[string, Record<string, unknown>]> = [
        ['create_task', { title: 'Nope', reporter: 'dev', bogus: 1 }],
        ['get_task', { id, bogus: 1 }],
        ['list_tasks', { bogus: 1 }],
        ['claim_task', { agent: 'tester', bogus: 1 }],
        ['update_status', { id, agent: 'tester', status: 'review', version, bogus: 1 }],
        ['list_queue', { bogus: 1 }],
        ['add_comment', { id, agent: 'tester', content: 'nope', bogus: 1 }],
        ['get_timeline', { id, bogus: 1 }],
        ['get_template', { name: 'task', bogus: 1 }],
        ['create_project', { folder_path: '/tmp/nope', bogus: 1 }],
        ['list_projects', { bogus: 1 }],
        ['update_project', { project: 'test', bogus: 1 }],
        ['delete_project', { project: 'test', bogus: 1 }]
      ]
      expect(calls.length).toBe(13)

      const before = storeSnapshot()
      for (const [tool, args] of calls) {
        const schema = schemas.get(tool)!
        const accepted = Object.keys(schema.properties ?? {}).sort().join(', ')
        const res: any = await client.callTool({ name: tool, arguments: args })
        expect(`${tool}: ${res.isError}`).toBe(`${tool}: true`)
        expect(`${tool}: ${textOf(res)}`).toBe(
          `${tool}: INVALID: unknown argument bogus on ${tool} (accepted: ${accepted})`
        )
      }
      expect(storeSnapshot()).toEqual(before)
    })
  })

  describe('advertised schema (R7 guard against a later .strict() "fix")', () => {
    test('no tool advertises additionalProperties: false, all 13 advertise it', async () => {
      const listed = await client.listTools()
      const tools = listed.tools as any[]
      expect(tools.length).toBe(13)
      for (const t of tools) {
        expect(`${t.name}:${JSON.stringify(t.inputSchema.additionalProperties)}`)
          .toBe(`${t.name}:{}`)
        expect(`${t.name}:${t.inputSchema.additionalProperties}`).not.toBe(`${t.name}:false`)
      }
    })

    test('claim_task advertises the id alias and keeps task_id', async () => {
      const listed = await client.listTools()
      const claim = (listed.tools as any[]).find(t => t.name === 'claim_task')!
      const props = claim.inputSchema.properties
      expect(Object.keys(props).sort()).toEqual(['agent', 'id', 'include', 'lease_ttl_min', 'project', 'task_id'])
      expect(props.id.description).toContain('alias of task_id')
    })

    test('update_status advertises renew and reset_attempts as booleans', async () => {
      const listed = await client.listTools()
      const update = (listed.tools as any[]).find(t => t.name === 'update_status')!
      const props = update.inputSchema.properties
      expect(Object.keys(props).sort()).toEqual(['agent', 'comment', 'id', 'renew', 'reset_attempts', 'status', 'version'])
      expect(props.renew.type).toBe('boolean')
      expect(props.reset_attempts.type).toBe('boolean')
    })
  })

  describe('renew / reset_attempts over the wire (F2 #1065 + F3 #1066)', () => {
    async function claimOverWire(title: string): Promise<number> {
      const id = getId(srv.svc.createTask({ title, reporter: 'dev', priority: 'p0' }))
      const claim = JSON.parse(textOf(await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', task_id: id } })))
      expect(claim.id).toBe(id)
      return id
    }

    test('a heartbeat over MCP re-arms the lease and bumps the version', async () => {
      const id = await claimOverWire('Wire')
      const version = getVersion(srv.db, id)

      const res = JSON.parse(textOf(await client.callTool({
        name: 'update_status',
        arguments: { id, agent: 'tester', status: 'in_progress', renew: true, version }
      })))
      expect(res).toEqual({ id, status: 'in_progress', version: version + 1 })
      const row = srv.db.query('SELECT lease_expires_at, attempts, assignee FROM tasks WHERE id = ?').get(id) as any
      expect(row.lease_expires_at).not.toBeNull()
      expect(row.attempts).toBe(0)
      expect(row.assignee).toBe('tester')
    })

    test('a refund over MCP echoes attempts and refunds the row', async () => {
      const id = getId(srv.svc.createTask({ title: 'Wire refund', reporter: 'dev', priority: 'p0' }))
      await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', task_id: id } })
      srv.db.run('UPDATE tasks SET attempts = 3 WHERE id = ?', [id])

      const res = JSON.parse(textOf(await client.callTool({
        name: 'update_status',
        arguments: { id, agent: 'tester', status: 'blocked', version: getVersion(srv.db, id), reset_attempts: true, comment: 'spent on accidental claims' }
      })))
      expect(res.attempts).toBe(0)
      const row = srv.db.query('SELECT attempts, max_attempts FROM tasks WHERE id = ?').get(id) as any
      expect(row.attempts).toBe(0)
      expect(row.max_attempts).toBe(3)
    })

    test('a non-boolean renew is a schema validation error and changes nothing', async () => {
      const id = getId(srv.svc.createTask({ title: 'Type', reporter: 'dev', priority: 'p0' }))
      await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', task_id: id } })
      const before = storeSnapshot()

      const res: any = await client.callTool({
        name: 'update_status',
        arguments: { id, agent: 'tester', status: 'in_progress', version: getVersion(srv.db, id), renew: 'yes' }
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('expected boolean, received string at renew')
      expect(storeSnapshot()).toEqual(before)
    })

    test('a non-boolean reset_attempts is a schema validation error and changes nothing', async () => {
      const id = getId(srv.svc.createTask({ title: 'Type2', reporter: 'dev', priority: 'p0' }))
      await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', task_id: id } })
      const before = storeSnapshot()

      const res: any = await client.callTool({
        name: 'update_status',
        arguments: { id, agent: 'tester', status: 'blocked', version: getVersion(srv.db, id), reset_attempts: 1, comment: 'x' }
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('expected boolean, received number at reset_attempts')
      expect(storeSnapshot()).toEqual(before)
    })
  })

  describe('task_id 0 must not auto-pick', () => {
    test('claim_task with task_id 0 is a range error and claims nothing', async () => {
      const bait = getId(srv.svc.createTask({ title: 'Bait', reporter: 'dev', priority: 'p0' }))
      const before = storeSnapshot()

      const res: any = await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', task_id: 0 } })
      expect(res.isError).toBe(true)
      expect(textOf(res)).not.toContain('INTERNAL')
      expect(storeSnapshot()).toEqual(before)
      expect((srv.db.query('SELECT status FROM tasks WHERE id = ?').get(bait) as any).status).toBe('queued')
    })

    test('claim_task with id 0 is rejected and claims nothing', async () => {
      const bait = getId(srv.svc.createTask({ title: 'Bait', reporter: 'dev', priority: 'p0' }))
      const res: any = await client.callTool({ name: 'claim_task', arguments: { agent: 'tester', id: 0 } })
      expect(res.isError).toBe(true)
      expect((srv.db.query('SELECT status FROM tasks WHERE id = ?').get(bait) as any).status).toBe('queued')
    })
  })
})
