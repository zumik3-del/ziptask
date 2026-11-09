import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SSE_KEEPALIVE_MS, HTTP_IDLE_TIMEOUT_SEC, trackStreamActivity } from './server'
import { createLogger } from './logger'
import type { Logger } from './logger'
import { SESSION_CLEANUP_INTERVAL_MS } from './defaults'
import { VERSION } from './version'
import { startTestServer } from './test-context'
import type { TestServer } from './test-context'

type JsonRecord = Record<string, unknown>

describe('observability logging', () => {
  let writeSpy: ReturnType<typeof spyOn>
  let lines: string[]

  function captureLines(): string[] {
    const snap = [...lines]
    lines.length = 0
    return snap
  }

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
    const found = records.find((r) => r.msg === msg)
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
      'dbPath',
      'host',
      'level',
      'logger',
      'msg',
      'port',
      'ts',
      'version'
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
    expect(String(open.session)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
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
    expect(close.session).toBe(open.session)
    expect(close.session).toBe(sessionId)
    expect(close.level).toBe('info')

    srv.stop()
  })

  test('fetch path throw logs an error record with err and stack, and returns 500', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })
    const port = srv.port

    ;(srv.svc as any).getTaskView = () => {
      throw new Error('boom')
    }

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
    ;(srv.svc as any).getTaskView = () => {
      throw circular
    }

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/1`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')

    const err = recordOf(captureRecords(), 'http handler error')
    expect(err.level).toBe('error')
    expect(err.logger).toBe('test')
    expect(Object.keys(err).includes('err')).toBe(false)
    expect(typeof err.fieldsUnserializable).toBe('string')
    expect(err.fieldsUnserializable as string).not.toBe('')
    expect(Object.keys(err).includes('self')).toBe(false)
    expect(Object.keys(err).includes('thrown')).toBe(false)

    srv.stop()
  })

  test('a non-Error throw keeps its provenance in a thrown field and still answers 500', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })

    ;(srv.svc as any).getTaskView = () => {
      throw { code: 'E_CUSTOM', detail: 'not an Error' }
    }

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/task/1`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')

    const err = recordOf(captureRecords(), 'http handler error')
    expect(err.level).toBe('error')
    expect(err.logger).toBe('test')
    expect(err.thrown).toEqual({ code: 'E_CUSTOM', detail: 'not an Error' })
    expect(Object.keys(err).includes('err')).toBe(false)
    expect(Object.keys(err).includes('stack')).toBe(false)

    srv.stop()
  })

  test('a newline in the agent name stays inside one record and forges no session open', async () => {
    const srv = startTestServer({ logger: makeCaptureLogger() })

    const evilName = 'evil\n{"level":"error","logger":"forged","msg":"forged record"}'
    const client = new Client({ name: evilName, version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    await client.connect(transport)

    const records = captureRecords()
    const open = recordOf(records, 'session open')
    expect(open.agent).toBe(evilName)
    expect(open.session).toBe(transport.sessionId)
    expect(records.filter((r) => r.msg === 'forged record')).toEqual([])
    expect(records.filter((r) => r.logger === 'forged')).toEqual([])

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
    expect(wrapped).not.toBe(res)
    expect(wrapped.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')

    const before = Date.now()
    const reader = wrapped.body!.getReader()
    const { value } = await reader.read()
    expect(value).toEqual(encoder.encode('data: hello\n\n'))
    expect(session.lastAccess).toBeGreaterThanOrEqual(before)
    expect(session.lastAccess).toBeLessThanOrEqual(Date.now())
  })

  test('trackStreamActivity passes through non-SSE responses unchanged', () => {
    const session = { lastAccess: 42, transport: {} as any, agent: 'test' }
    const res = new Response('{"id":1}', {
      headers: { 'content-type': 'application/json' }
    })
    const wrapped = trackStreamActivity(res, session)
    expect(wrapped).toBe(res)
    expect(session.lastAccess).toBe(42)
  })

  test('trackStreamActivity passes through responses with no body', () => {
    const session = { lastAccess: 0, transport: {} as any, agent: 'test' }
    const res = new Response(null, { status: 204 })
    const wrapped = trackStreamActivity(res, session)
    expect(wrapped).toBe(res)
    expect(session.lastAccess).toBe(0)
  })

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
      run: () => {
        for (const sweep of sweeps) sweep()
      },
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
    }).then((res) => res.status)
  }

  test('a request on an existing session refreshes lastAccess', async () => {
    const serverModule = await import('./server')
    const activity = spyOn(serverModule, 'trackStreamActivity')
    const srv = startTestServer()
    try {
      const { client, transport } = await connectClient(srv.port, 'keepalive-agent')
      const sessionId = transport.sessionId
      const session = activity.mock.calls.at(-1)?.[1]
      expect(session).toBeDefined()
      if (!session) throw new Error('trackStreamActivity was never called')
      const stale = session.lastAccess
      await Bun.sleep(5)

      const result = await client.callTool({ name: 'list_tasks', arguments: { project: 'test' } })
      expect(result).toBeDefined()

      expect(transport.sessionId).toBe(sessionId)
      expect(activity.mock.calls.at(-1)?.[1]).toBe(session)
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

      await Bun.sleep(300)
      const result = await active.client.callTool({
        name: 'list_tasks',
        arguments: { project: 'test' }
      })
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

  beforeEach(() => {
    srv = startTestServer()
  })
  afterEach(() => {
    srv.stop()
  })

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
    const res = await mcpRequest('bogus-stale-session', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
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

    const res = await mcpRequest(staleId!, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.error.code).toBe(-32001)
  })

  test('sessionless non-initialize request → 400 Mcp-Session-Id required', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
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

    const client1 = new Client({ name: 'cap-agent-1', version: '1.0.0' })
    const transport1 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client1.connect(transport1)
    expect(transport1.sessionId).toBeDefined()

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
