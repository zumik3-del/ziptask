import { describe, test, expect, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryEventStore, MAX_EVENT_STORE_EVENTS } from './server'
import { startTestServer } from './test-context'

describe('HTTP replay window', () => {
  test('rejects evicted, unknown and cross-session cursors without damaging sessions', async () => {
    const stores: InMemoryEventStore[] = []
    const original = InMemoryEventStore.prototype.storeEvent
    const spy = spyOn(InMemoryEventStore.prototype, 'storeEvent').mockImplementation(async function (this: InMemoryEventStore, stream, message) {
      if (!stores.includes(this)) stores.push(this)
      return original.call(this, stream, message)
    })
    const srv = startTestServer()
    const url = new URL(`http://127.0.0.1:${srv.port}/mcp`)
    const a = new Client({ name: 'replay-a', version: '1' })
    const b = new Client({ name: 'replay-b', version: '1' })
    const ta = new StreamableHTTPClientTransport(url)
    const tb = new StreamableHTTPClientTransport(url)
    try {
      await a.connect(ta)
      await a.listTools()
      const storeA = stores[0]
      await b.connect(tb)
      await b.listTools()
      const storeB = stores.find(s => s !== storeA)!
      expect(storeB).toBeDefined()
      const foreign = await storeB.storeEvent('foreign', { jsonrpc: '2.0', method: 'notifications/test' })
      const evicted = await storeA.storeEvent('test-stream', { jsonrpc: '2.0', method: 'notifications/test' })
      let retained = ''
      for (let i = 0; i < MAX_EVENT_STORE_EVENTS; i++) {
        retained = await storeA.storeEvent('test-stream', { jsonrpc: '2.0', method: 'notifications/test' })
      }
      await storeA.storeEvent('test-stream', { jsonrpc: '2.0', method: 'notifications/test' })
      const controller = new AbortController()
      const get = (session: string | undefined, cursor?: string) => fetch(url, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(cursor ? { 'last-event-id': cursor } : {}) }
      })
      for (const cursor of [evicted, 'never-issued', foreign]) {
        const res = await get(ta.sessionId, cursor)
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: "Bad Request: Last-Event-ID is not in this session's replay window" } })
      }
      expect((await get('missing-session', 'never-issued')).status).toBe(404)
      expect((await get(undefined, 'never-issued')).status).toBe(400)
      const noCursor = await get(ta.sessionId)
      expect(noCursor.status).toBe(409)
      expect((await a.listTools()).tools.length).toBeGreaterThan(0)
      expect((await b.listTools()).tools.length).toBeGreaterThan(0)
      const replay = await get(ta.sessionId, retained)
      expect(replay.status).toBe(200)
      expect(replay.headers.get('content-type')).toContain('text/event-stream')
      const reader = replay.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('notifications/test')
      const takeover = await get(ta.sessionId, retained)
      expect(takeover.status).toBe(200)
      const successor = takeover.body!.getReader()
      expect(new TextDecoder().decode((await successor.read()).value)).toContain('notifications/test')
      expect((await reader.read()).done).toBe(true)
      controller.abort()
    } finally {
      await a.close()
      await b.close()
      spy.mockRestore()
      srv.stop()
    }
  })

  test('SDK resumeStream rejects a missing cursor and leaves the client usable', async () => {
    const srv = startTestServer()
    const client = new Client({ name: 'resume', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    try {
      await client.connect(transport)
      const session = transport.sessionId
      await expect(transport.resumeStream('never-issued')).rejects.toMatchObject({ code: 400, message: 'Streamable HTTP error: Failed to open SSE stream: Bad Request' })
      expect(transport.sessionId).toBe(session)
      expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    } finally {
      await client.close()
      srv.stop()
    }
  })
})
