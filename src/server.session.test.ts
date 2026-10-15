import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSE_KEEPALIVE_MS, HTTP_IDLE_TIMEOUT_SEC, trackStreamActivity } from './server'
import { createLogger } from './logger'
import type { Logger } from './logger'
import { SESSION_CLEANUP_INTERVAL_MS } from './defaults'
import { VERSION } from './version'
import { startTestServer } from './test-context'
import type { TestServer } from './test-context'

// Session lifecycle and the records it emits: keep-alive/reaping, recovery from a stale id, the
// session cap, and the JSON observability stream (open/close/500) that pins those transitions.
// The HTTP/MCP contract itself lives in server.http.test.ts, the event store in
// server.event-store.test.ts.

type JsonRecord = Record<string, unknown>

describe('observability logging', () => {
  let writeSpy: ReturnType<typeof spyOn>
  let lines: string[]

  function captureLines(): string[] {
    const snap = [...lines]
    lines.length = 0
    return snap
  }

  // A non-JSON line (a stray stderr write from the runtime or the SDK) is skipped rather
  // than thrown on: a regression that drops back to text logging then fails the lookup
  // below instead of the parser. A `{`-line that does NOT parse is the opposite case —
  // it is a broken or forged record, so it is reported instead of dropped.
  function captureRecords(): JsonRecord[] {
    const records: JsonRecord[] = []
    const unparseable: string[] = []
    for (const line of captureLines()) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        records.push(JSON.parse(trimmed) as JsonRecord)
      } catch {
        unparseable.push(trimmed)
      }
    }
    if (unparseable.length > 0) {
      throw new Error(`unparseable stderr record(s): ${unparseable.join(' | ')}`)
    }
    return records
  }

  function recordOf(records: JsonRecord[], msg: string): JsonRecord {
    const found = records.find(r => r.msg === msg)
    if (found === undefined) throw new Error(`no "${msg}" record in: ${JSON.stringify(records)}`)
    return found
  }

  function makeCaptureLogger(): Logger {
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

  test('startup emits one JSON record carrying version, host, port and dbPath as fields', () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })
    const port = srv.port

    const startup = recordOf(captureRecords(), 'ziptask started')
    expect(Object.keys(startup).sort()).toEqual([
      'dbPath', 'host', 'level', 'logger', 'msg', 'port', 'ts', 'version'
    ])
    expect(startup.version).toBe(VERSION)
    expect(startup.host).toBe('127.0.0.1')
    expect(startup.port).toBe(port)
    expect(startup.dbPath).toBe(srv.dbPath)
    expect(startup.level).toBe('info')
    expect(startup.logger).toBe('test')
    expect(new Date(startup.ts as string).toISOString()).toBe(startup.ts as string)

    srv.stop()
  })

  test('session open logs the session id and agent name from clientInfo.name', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })
    const port = srv.port

    const client = new Client({ name: 'agent-verify', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)

    const open = recordOf(captureRecords(), 'session open')
    expect(open.agent).toBe('agent-verify')
    expect(open.session).toBe(transport.sessionId)
    expect(String(open.session)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(open.level).toBe('info')
    expect(open.logger).toBe('test')

    await client.close()
    srv.stop()
  })

  test('session close logs the same session id and agent on disconnect', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })
    const port = srv.port

    const client = new Client({ name: 'close-agent', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(transport)
    const open = recordOf(captureRecords(), 'session open')
    const sessionId = transport.sessionId
    await transport.terminateSession()

    const close = recordOf(captureRecords(), 'session close')
    expect(close.agent).toBe('close-agent')
    // the close must name the same session the open did, or the pair cannot be correlated
    expect(close.session).toBe(open.session)
    expect(close.session).toBe(sessionId)
    expect(close.level).toBe('info')

    srv.stop()
  })

  test('fetch path throw logs an error record with err and stack, and returns 500', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })
    const port = srv.port

    // Inject a throwing getTaskView to trigger the error path
    ;(srv.svc as any).getTaskView = () => { throw new Error('boom') }

    const res = await fetch(`http://127.0.0.1:${port}/api/task/1`)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toBe('Internal Server Error')

    const err = recordOf(captureRecords(), 'http handler error')
    expect(err.level).toBe('error')
    expect(err.err).toBe('boom')
    expect(err.stack as string).toContain('boom')
    expect(err.logger).toBe('test')

    srv.stop()
  })

  test('a non-Error object throw is stringified away by the serializer fallback and still answers 500', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    ;(srv.svc as any).getTaskView = () => { throw circular }

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/1`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')

    const err = recordOf(captureRecords(), 'http handler error')
    expect(err.level).toBe('error')
    expect(err.logger).toBe('test')
    // normalizeError wraps the non-Error throw as { thrown }, so it lands in the fields
    // slot, not the err one: the record carries no err key, and the circular reference
    // is caught by the serializer, which drops the structured fields and reports why.
    expect(Object.keys(err).includes('err')).toBe(false)
    expect(typeof err.fieldsUnserializable).toBe('string')
    expect(err.fieldsUnserializable as string).not.toBe('')
    expect(Object.keys(err).includes('self')).toBe(false)
    expect(Object.keys(err).includes('thrown')).toBe(false)

    srv.stop()
  })

  test('a non-Error throw keeps its provenance in a thrown field and still answers 500', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })

    // A serializable non-Error throw: the shape survives, so the record can be acted on
    // instead of collapsing to the "[object Object]" the err slot would have produced.
    ;(srv.svc as any).getTaskView = () => { throw { code: 'E_CUSTOM', detail: 'not an Error' } }

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/1`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')

    const err = recordOf(captureRecords(), 'http handler error')
    expect(err.level).toBe('error')
    expect(err.logger).toBe('test')
    expect(err.thrown).toEqual({ code: 'E_CUSTOM', detail: 'not an Error' })
    // the err slot is reserved for Errors: no message/stack pair is invented here
    expect(Object.keys(err).includes('err')).toBe(false)
    expect(Object.keys(err).includes('stack')).toBe(false)

    srv.stop()
  })

  test('a newline in the agent name stays inside one record and forges no session open', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })

    // clientInfo.name is caller-controlled, so it is the one field a client can aim at
    // the log stream with. captureRecords() throws on an unparseable { line, so the
    // forged payload showing up as its own record is the other way this test fails.
    const evilName = 'evil\n{"level":"error","logger":"forged","msg":"forged record"}'
    const client = new Client({ name: evilName, version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    await client.connect(transport)

    const records = captureRecords()
    const open = recordOf(records, 'session open')
    expect(open.agent).toBe(evilName)
    expect(open.session).toBe(transport.sessionId)
    expect(records.filter(r => r.msg === 'forged record')).toEqual([])
    expect(records.filter(r => r.logger === 'forged')).toEqual([])

    await client.close()
    srv.stop()
  })
})

describe('session keep-alive fix (#753/#754)', () => {
  test('SSE_KEEPALIVE_MS is 10_000', () => {
    expect(SSE_KEEPALIVE_MS).toBe(10_000)
  })

  test('HTTP_IDLE_TIMEOUT_SEC is 60', () => {
    expect(HTTP_IDLE_TIMEOUT_SEC).toBe(60)
  })

  test('trackStreamActivity wraps SSE response and refreshes lastAccess', async () => {
    const session = { lastAccess: 0, transport: {} as any, agent: 'test' }
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello\n\n'))
        controller.close()
      }
    })
    const res = new Response(body, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    })
    const wrapped = trackStreamActivity(res, session)
    expect(wrapped).not.toBe(res) // new Response created
    expect(wrapped.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')

    // Consume the body to trigger the TransformStream
    const before = Date.now()
    const reader = wrapped.body!.getReader()
    const { value } = await reader.read()
    expect(value).toEqual(encoder.encode('data: hello\n\n'))
    // The refresh is a real clock read, not a non-zero sentinel: a chunk must move lastAccess
    // into the window this read happened in.
    expect(session.lastAccess).toBeGreaterThanOrEqual(before)
    expect(session.lastAccess).toBeLessThanOrEqual(Date.now())
  })

  test('trackStreamActivity passes through non-SSE responses unchanged', () => {
    const session = { lastAccess: 42, transport: {} as any, agent: 'test' }
    const res = new Response('{"id":1}', {
      headers: { 'content-type': 'application/json' }
    })
    const wrapped = trackStreamActivity(res, session)
    expect(wrapped).toBe(res) // same reference — no wrapping
    expect(session.lastAccess).toBe(42) // not mutated
  })

  test('trackStreamActivity passes through responses with no body', () => {
    const session = { lastAccess: 0, transport: {} as any, agent: 'test' }
    const res = new Response(null, { status: 204 })
    const wrapped = trackStreamActivity(res, session)
    expect(wrapped).toBe(res)
    expect(session.lastAccess).toBe(0)
  })

  // The session sweeper is driven directly instead of waited for: it runs on a 60s interval, so
  // any wall-clock wait short enough for a test would only prove the interval had not fired yet.
  function captureSessionSweeper() {
    const sweeps: Array<() => void> = []
    const realSetInterval = globalThis.setInterval
    const spy = spyOn(globalThis, 'setInterval').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      if (ms === SESSION_CLEANUP_INTERVAL_MS) sweeps.push(fn)
      return realSetInterval(fn, ms as number)
    }) as unknown as typeof setInterval)
    return {
      run: () => { for (const sweep of sweeps) sweep() },
      restore: () => spy.mockRestore()
    }
  }

  function connectClient(port: number | undefined, name: string) {
    const client = new Client({ name, version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    return client.connect(transport).then(() => ({ client, transport }))
  }

  function postStatus(port: number | undefined, sessionId: string): Promise<number> {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-06-18'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4711, method: 'tools/list', params: {} })
    }).then(res => res.status)
  }

  test('a request on an existing session refreshes lastAccess', async () => {
    const serverModule = await import('./server')
    const activity = spyOn(serverModule, 'trackStreamActivity')
    const srv = startTestServer()
    try {
      const { client, transport } = await connectClient(srv.port, 'keepalive-agent')
      const sessionId = transport.sessionId
      // The spy hands over the live Session the server keeps in its map, so the refresh is read
      // directly instead of being inferred from a second call merely succeeding.
      const session = activity.mock.calls.at(-1)?.[1]
      expect(session).toBeDefined()
      if (!session) throw new Error('trackStreamActivity was never called')
      const stale = session.lastAccess
      await Bun.sleep(5)

      const result = await client.callTool({ name: 'list_tasks', arguments: { project: 'test' } })
      expect(result).toBeDefined()

      expect(transport.sessionId).toBe(sessionId) // the existing session was reused, not re-initialized
      expect(activity.mock.calls.at(-1)?.[1]).toBe(session) // one shared Session object, all along
      expect(session.lastAccess).toBeGreaterThan(stale)
      await client.close()
    } finally {
      activity.mockRestore()
      srv.stop()
    }
  })

  test('the sweeper drops an idle session and spares one whose lastAccess a request refreshed', async () => {
    const sweeper = captureSessionSweeper()
    const srv = startTestServer({ sessionTtlMs: 200 })
    try {
      const active = await connectClient(srv.port, 'keepalive-agent')
      const idle = await connectClient(srv.port, 'quiet-agent')

      // Both sessions are now older than the 200ms TTL, so both are sweep-eligible before the
      // request below: the surviving session is spared by the refresh, not by an inert sweep.
      await Bun.sleep(300)
      const result = await active.client.callTool({ name: 'list_tasks', arguments: { project: 'test' } })
      expect(result).toBeDefined()

      sweeper.run()

      expect(await postStatus(srv.port, idle.transport.sessionId as string)).toBe(404)
      expect(await postStatus(srv.port, active.transport.sessionId as string)).toBe(200)
      await active.client.close()
      await idle.client.close()
    } finally {
      sweeper.restore()
      srv.stop()
    }
  })
})

describe('stale session recovery', () => {
  let srv: TestServer

  beforeEach(() => { srv = startTestServer() })
  afterEach(() => { srv.stop() })

  function mcpRequest(sessionId: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId
      },
      body: JSON.stringify(body)
    })
  }

  test('unknown mcp-session-id → 404 Session not found (client re-init trigger)', async () => {
    const res = await mcpRequest('bogus-stale-session', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error.code).toBe(-32001)
    expect(body.error.message).toBe('Session not found')
  })

  test('terminated session id is rejected with 404, not 400 Server not initialized', async () => {
    const client = new Client({ name: 'stale-agent', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    await client.connect(transport)
    const staleId = transport.sessionId
    expect(staleId).toBeDefined()
    await transport.terminateSession()

    const res = await mcpRequest(staleId!, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body.error.code).toBe(-32001)
  })

  test('sessionless non-initialize request → 400 Mcp-Session-Id required', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error.code).toBe(-32000)
    expect(body.error.message).toContain('Mcp-Session-Id')
  })

  test('sessionless initialize still opens a usable session', async () => {
    const client = new Client({ name: 'fresh-agent', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    await client.connect(transport)
    expect(transport.sessionId).toBeDefined()
    const result = await client.callTool({ name: 'list_tasks', arguments: { project: 'test' } })
    expect(result).toBeDefined()
    await client.close()
  })
})

describe('session cap (#767)', () => {
  test('concurrent initialize beyond maxSessions returns 429', async () => {
    const srv = startTestServer({ maxSessions: 1 })
    const port = srv.port

    // First client connects fine
    const client1 = new Client({ name: 'cap-agent-1', version: '1.0.0' })
    const transport1 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client1.connect(transport1)
    expect(transport1.sessionId).toBeDefined()

    // Second client should get 429 (session cap reached)
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'cap-agent-2', version: '1.0.0' }
        }
      })
    })
    expect(res.status).toBe(429)
    const body = await res.text()
    expect(body.toLowerCase()).toContain('session')

    await client1.close()
    srv.stop()
  })
})
