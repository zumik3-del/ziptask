import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import type { Logger } from './logger'
import { createLogger } from './logger'
import { VERSION } from './version'
import { DEFAULT_HTTP_MAX_SESSIONS, DEFAULT_HTTP_SESSION_TTL_MS, SESSION_CLEANUP_INTERVAL_MS } from './defaults'

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
  agent: string
}

export const SSE_KEEPALIVE_MS = 10_000
export const HTTP_IDLE_TIMEOUT_SEC = 60
export const MAX_EVENT_STORE_EVENTS = 1000

export function trackStreamActivity(response: Response, session: Session): Response {
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) return response
  const tracked = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        session.lastAccess = Date.now()
        controller.enqueue(chunk)
      }
    })
  )
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export class InMemoryEventStore implements EventStore {
  private events = new Map<string, { streamId: string; message: JSONRPCMessage }>()

  private generateEventId(streamId: string): string {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = this.generateEventId(streamId)
    this.events.set(eventId, { streamId, message })
    // One store per session and sessions are capped, but a single long-lived session
    // can still emit unbounded events, so keep memory bounded by evicting the oldest
    // (Map preserves insertion order). If a client resumes after its last event id was
    // evicted, replayEventsAfter returns '' and the client re-initializes instead of
    // replaying — degraded but bounded, never a memory leak.
    while (this.events.size > MAX_EVENT_STORE_EVENTS) {
      const oldest = this.events.keys().next().value
      if (oldest === undefined) break
      this.events.delete(oldest)
    }
    return eventId
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) return ''
    const streamId = this.events.get(lastEventId)!.streamId
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let found = false
    for (const [id, { streamId: sId, message }] of sorted) {
      if (sId !== streamId) continue
      if (id === lastEventId) { found = true; continue }
      if (found) await send(id, message)
    }
    return streamId
  }

  clear(): void {
    this.events.clear()
  }
}

export interface StartHttpOptions {
  svc: TaskService
  port: number
  host: string
  dbPath?: string
  maxSessions?: number
  sessionTtlMs?: number
  logger?: Logger
  onShutdown?: () => void
}

async function peekInitialize(req: Request): Promise<{ request: Request; agentName: string; isInitialize: boolean }> {
  if (req.method !== 'POST') return { request: req, agentName: 'unknown', isInitialize: false }
  const body = await req.text()
  const request = new Request(req.url, { method: req.method, headers: req.headers, body })
  let agentName = 'unknown'
  let isInitialize = false
  try {
    const parsed = JSON.parse(body)
    const init = Array.isArray(parsed) ? parsed.find(m => m?.method === 'initialize') : parsed
    isInitialize = init?.method === 'initialize'
    const name = init?.params?.clientInfo?.name
    if (typeof name === 'string' && name.length > 0) agentName = name
  } catch {}
  return { request, agentName, isInitialize }
}

const SESSION_NOT_FOUND = { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }
const SESSION_REQUIRED = { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null }

export function startHttp(opts: StartHttpOptions) {
  const { svc, port, host, dbPath, maxSessions = DEFAULT_HTTP_MAX_SESSIONS, sessionTtlMs = DEFAULT_HTTP_SESSION_TTL_MS, logger, onShutdown } = opts
  const svcLogger = logger ?? createLogger('http', 'off')
  const sessions = new Map<string, Session>()
  let reservedSessions = 0
  const logSessionClose = (id: string, agent: string) => {
    svcLogger.info(`session close id=${id} agent=${agent}`)
  }

  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > sessionTtlMs) {
        logSessionClose(id, session.agent)
        session.transport.close().catch(() => {})
        sessions.delete(id)
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS)

  const server = Bun.serve({
    port,
    hostname: host,
    idleTimeout: HTTP_IDLE_TIMEOUT_SEC,
    async fetch(req) {
      try {
        const url = new URL(req.url)

        if (url.pathname === '/health' && req.method === 'GET') {
          return Response.json({ ok: true })
        }

        // EXPERIMENTAL: provisional read-only endpoint, response shape subject to change.
        if (req.method === 'GET' && url.pathname.startsWith('/api/task/')) {
          const rawId = url.pathname.slice('/api/task/'.length)
          const id = Number(rawId)
          if (rawId.length === 0 || !Number.isInteger(id)) {
            return Response.json({ error: 'Invalid task id' }, { status: 400 })
          }
          const view = svc.getTaskView(id)
          if (!view.ok) {
            return Response.json({ error: view.error }, { status: 404 })
          }
          const comments = svc.listComments(id)
          return Response.json({
            task: view.data.task,
            blocked_by: view.data.blockedBy,
            ...(view.data.subtasks !== undefined ? { subtasks: view.data.subtasks } : {}),
            comments: comments.ok ? comments.data : []
          })
        }

        if (url.pathname !== '/mcp') {
          return new Response('Not Found', { status: 404 })
        }

        const sessionId = req.headers.get('mcp-session-id')

        if (sessionId) {
          const session = sessions.get(sessionId)
          if (!session) {
            return Response.json(SESSION_NOT_FOUND, { status: 404 })
          }
          session.lastAccess = Date.now()
          return trackStreamActivity(await session.transport.handleRequest(req), session)
        }

        if (sessions.size + reservedSessions >= maxSessions) {
          return Response.json({ error: 'Too many sessions' }, { status: 429 })
        }
        reservedSessions++
        try {
          const { request, agentName, isInitialize } = await peekInitialize(req)
          if (!isInitialize) {
            return Response.json(SESSION_REQUIRED, { status: 400 })
          }

          const mcpServer = createMcpServer(svc)
          const eventStore = new InMemoryEventStore()
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            keepAliveMs: SSE_KEEPALIVE_MS,
            eventStore,
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, lastAccess: Date.now(), agent: agentName })
              svcLogger.info(`session open id=${id} agent=${agentName}`)
            },
            onsessionclosed: (id) => {
              const session = sessions.get(id)
              logSessionClose(id, session?.agent ?? 'unknown')
              sessions.delete(id)
            }
          })
          transport.onclose = () => eventStore.clear()

          await mcpServer.connect(transport)
          const response = await transport.handleRequest(request)
          const session = transport.sessionId ? sessions.get(transport.sessionId) : undefined
          if (!session) {
            transport.close().catch(() => {})
            mcpServer.close().catch(() => {})
            return response
          }
          return trackStreamActivity(response, session)
        } finally {
          reservedSessions--
        }
      } catch (err) {
        svcLogger.error(`http handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        return new Response('Internal Server Error', { status: 500 })
      }
    }
  })

  const shutdown = () => {
    clearInterval(cleanup)
    for (const [id, session] of sessions) {
      logSessionClose(id, session.agent)
      session.transport.close().catch(() => {})
    }
    sessions.clear()
    server.stop(true)
    onShutdown?.()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  svcLogger.info(`ziptask started version=${VERSION} host=${host} port=${server.port} dbPath=${dbPath ?? ''}`)
  return server
}
