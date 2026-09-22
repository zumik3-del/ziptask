import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { openDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { startHttp } from './server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from './version'
import { createLogger } from './logger'

const TMP = '/tmp/opencode'

function makeServer() {
  mkdirSync(TMP, { recursive: true })
  const dbPath = join(TMP, `server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = openDatabase(dbPath)
  const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15 })
  const server = startHttp({ svc, port: 0, host: '127.0.0.1' })
  const port = server.port
  return { db, svc, port, dbPath, stop: () => { server.stop(); db.close(); try { rmSync(dbPath) } catch {} try { rmSync(dbPath + '-wal') } catch {} try { rmSync(dbPath + '-shm') } catch {} } }
}

function getId(result: ReturnType<TaskService['createTask']>): number {
  if (!result.ok) throw new Error('createTask failed')
  return result.data.id
}

function getVersion(db: ReturnType<typeof openDatabase>, id: number): number {
  return (db.query('SELECT version FROM tasks WHERE id = ?').get(id) as { version: number }).version
}

describe('GET /api/task/:id HTTP endpoint', () => {
  let srv: ReturnType<typeof makeServer>

  beforeEach(() => { srv = makeServer() })
  afterEach(() => { srv.stop() })

  test('health returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
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
    const claimOk = srv.svc.claimTask({ agent: 'tester', task_id: id })
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
    const claimOk = srv.svc.claimTask({ agent: 'dev', task_id: depId })
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
  let srv: ReturnType<typeof makeServer>
  let client: Client

  beforeEach(async () => {
    srv = makeServer()
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
    const all = await client.callTool({ name: 'list_tasks', arguments: { updated_since: 0 } })
    expect((all as any).content[0].text).not.toBeNull()

    const future = await client.callTool({ name: 'list_tasks', arguments: { updated_since: Date.now() + 60_000 } })
    expect((future as any).content[0].text).toContain('0')
  })
})

describe('observability logging', () => {
  let writeSpy: ReturnType<typeof spyOn>
  let lines: string[]

  function captureLines(): string[] {
    const snap = [...lines]
    lines.length = 0
    return snap
  }

  function makeCaptureLogger(): import('./logger').Logger {
    return createLogger('test', 'debug')
  }

  beforeEach(() => {
    lines = []
    writeSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      if (typeof chunk === 'string') lines.push(chunk)
      return true
    })
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  test('startup line contains version, host, port, dbPath', () => {
    const dbPath = join(TMP, `obs-startup-${Date.now()}.db`)
    const db = openDatabase(dbPath)
    const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15 })
    const logger = makeCaptureLogger()
    const server = startHttp({ svc, port: 0, host: '127.0.0.1', dbPath, logger })
    const port = server.port

    const startupLines = captureLines()
    const startup = startupLines.find(l => l.includes('ziptask started'))
    expect(startup).toBeDefined()
    expect(startup).toContain(`version=${VERSION}`)
    expect(startup).toContain('host=127.0.0.1')
    expect(startup).toContain(`port=${port}`)
    expect(startup).toContain(`dbPath=${dbPath}`)

    server.stop()
    db.close()
    try { rmSync(dbPath) } catch {}
    try { rmSync(dbPath + '-wal') } catch {}
    try { rmSync(dbPath + '-shm') } catch {}
  })

  test('session open logs id and agent name from clientInfo.name', async () => {
    const dbPath = join(TMP, `obs-session-${Date.now()}.db`)
    const db = openDatabase(dbPath)
    const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15 })
    const logger = makeCaptureLogger()
    const server = startHttp({ svc, port: 0, host: '127.0.0.1', dbPath, logger })
    const port = server.port

    const client = new Client({ name: 'agent-verify', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)

    const openLines = captureLines()
    const openLine = openLines.find(l => l.includes('session open'))
    expect(openLine).toBeDefined()
    expect(openLine).toContain('agent=agent-verify')
    expect(openLine).toMatch(/session open id=[a-f0-9-]+/)

    await client.close()
    server.stop()
    db.close()
    try { rmSync(dbPath) } catch {}
    try { rmSync(dbPath + '-wal') } catch {}
    try { rmSync(dbPath + '-shm') } catch {}
  })

  test('session close logs id and agent name on disconnect', async () => {
    const dbPath = join(TMP, `obs-close-${Date.now()}.db`)
    const db = openDatabase(dbPath)
    const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15 })
    const logger = makeCaptureLogger()
    const server = startHttp({ svc, port: 0, host: '127.0.0.1', dbPath, logger })
    const port = server.port

    const client = new Client({ name: 'close-agent', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)
    await transport.terminateSession()

    const closeLines = captureLines()
    const closeLine = closeLines.find(l => l.includes('session close'))
    expect(closeLine).toBeDefined()
    expect(closeLine).toContain('agent=close-agent')
    expect(closeLine).toMatch(/session close id=[a-f0-9-]+/)

    server.stop()
    db.close()
    try { rmSync(dbPath) } catch {}
    try { rmSync(dbPath + '-wal') } catch {}
    try { rmSync(dbPath + '-shm') } catch {}
  })

  test('fetch path throw logs error and returns 500', async () => {
    const dbPath = join(TMP, `obs-500-${Date.now()}.db`)
    const db = openDatabase(dbPath)
    const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15 })
    const logger = makeCaptureLogger()
    const server = startHttp({ svc, port: 0, host: '127.0.0.1', dbPath, logger })
    const port = server.port

    // Inject a throwing getTaskView to trigger the error path
    ;(svc as any).getTaskView = () => { throw new Error('boom') }

    const res = await fetch(`http://127.0.0.1:${port}/api/task/1`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toBe('Internal Server Error')

    const errLines = captureLines()
    const errLine = errLines.find(l => l.includes('http handler error'))
    expect(errLine).toBeDefined()
    expect(errLine).toContain('boom')

    server.stop()
    db.close()
    try { rmSync(dbPath) } catch {}
    try { rmSync(dbPath + '-wal') } catch {}
    try { rmSync(dbPath + '-shm') } catch {}
  })
})
