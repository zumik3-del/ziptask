import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { readRequestBody } from '@modelcontextprotocol/sdk/server/requestBody.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { TaskService } from './core/service'
import { formatError } from './core/result'
import { TASK_STATUS_VALUES, monotonicNowMs } from './core/tasks'
import { createMcpServer } from './mcp/server'
import type { Logger } from './logger'
import { createLogger, normalizeError } from './logger'
import { VERSION } from './version'
import { SessionRegistry, type Session } from './session-registry'
import {
  DEFAULT_HTTP_MAX_BODY_BYTES,
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS,
  SESSION_CLEANUP_INTERVAL_MS
} from './defaults'

export type { Session } from './session-registry'

export const SSE_KEEPALIVE_MS = 10_000
export const HTTP_IDLE_TIMEOUT_SEC = 60
export const MAX_EVENT_STORE_EVENTS = 1000

// The browser-facing /api/* surface is read-only and needs to be callable cross-origin, so the
// three headers are fixed here rather than negotiated per request. /mcp is deliberately left out:
// it is an agent-to-server channel, not something a page fetches through the same-origin policy.
export const CORS_ALLOW_ORIGIN = '*'
export const CORS_ALLOW_METHODS = 'GET, OPTIONS'
export const CORS_ALLOW_HEADERS = 'Content-Type'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
  'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS
}

// Rebuilds the response so the CORS headers land on success and error alike (a 400/404 that
// omits them is unreadable in a browser). The body is passed through untouched, so a streaming
// response keeps streaming.
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

// Thin adapter over the SDK's own body reader, so the peek below and the transport it feeds agree
// on one cap and one Content-Length fast path: two copies drift (a local one enforced 1 MiB here
// while the transport still accepted 4 MiB). The caller turns `oversized` into a 413.
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<{ body: string; oversized: boolean }> {
  const result = await readRequestBody(req, maxBytes)
  return result.tooLarge ? { body: '', oversized: true } : { body: result.text, oversized: false }
}

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
  private seq = 0

  // Event ids must order the same way events were stored: the timestamp prefix alone is
  // ambiguous because bursts land in the same millisecond, so it is paired with a
  // fixed-width monotonic counter. Ids are unique and lexicographically ordered.
  private generateEventId(streamId: string): string {
    return `${streamId}_${monotonicNowMs()}_${String(++this.seq).padStart(10, '0')}`
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
    // Snapshot then iterate in insertion order, which is the store order; no id sort needed.
    const snapshot = [...this.events.entries()]
    let found = false
    for (const [id, { streamId: sId, message }] of snapshot) {
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

// The oversized case carries no request: the caller answers 413 and never replays the body, so the
// union states that invariant instead of handing back a request no caller reads.
type PeekResult =
  | { oversized: true }
  | { oversized: false; request: Request; agentName: string; isInitialize: boolean }

async function peekInitialize(
  req: Request,
  logger: Logger,
  maxBodyBytes: number
): Promise<PeekResult> {
  if (req.method !== 'POST') return { oversized: false, request: req, agentName: 'unknown', isInitialize: false }
  const { body, oversized } = await readBodyWithLimit(req, maxBodyBytes)
  if (oversized) {
    logger.warn('peekInitialize: request body exceeds the size limit', { maxBodyBytes })
    return { oversized: true }
  }
  const request = new Request(req.url, { method: req.method, headers: req.headers, body })
  let agentName = 'unknown'
  let isInitialize = false
  try {
    const parsed = JSON.parse(body)
    const init = Array.isArray(parsed) ? parsed.find(m => m?.method === 'initialize') : parsed
    isInitialize = init?.method === 'initialize'
    const name = init?.params?.clientInfo?.name
    if (typeof name === 'string' && name.length > 0) agentName = name
  } catch (err) {
    // A non-JSON body is a client error, not a server fault: log it for diagnosis and keep
    // treating the request as a non-initialize one (the caller answers 400).
    logger.debug('peekInitialize: failed to parse request body', { err: err instanceof Error ? err.message : String(err) })
  }
  return { oversized: false, request, agentName, isInitialize }
}

// JSON-RPC server-error codes live in the -32000..-32099 range; name them so both transport
// error responses stay consistent and the two magic numbers cannot drift apart.
const JSONRPC_SESSION_NOT_FOUND = -32001
const JSONRPC_BAD_REQUEST = -32000

const SESSION_NOT_FOUND = { jsonrpc: '2.0', error: { code: JSONRPC_SESSION_NOT_FOUND, message: 'Session not found' }, id: null }
const SESSION_REQUIRED = { jsonrpc: '2.0', error: { code: JSONRPC_BAD_REQUEST, message: 'Bad Request: Mcp-Session-Id header is required' }, id: null }

// EXPERIMENTAL: provisional read-only endpoint, response shape subject to change.
function handleTaskList(svc: TaskService, url: URL): Response {
  const project = url.searchParams.get('project') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (status !== undefined && !TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
    return Response.json({ error: 'INVALID: invalid status' }, { status: 400 })
  }
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null) {
    limit = Number(limitRaw)
    if (!Number.isInteger(limit) || limit <= 0) {
      return Response.json({ error: 'INVALID: invalid limit' }, { status: 400 })
    }
  }
  const result = svc.listTasks({ project, status: status as any, limit })
  if (!result.ok) {
    const httpStatus = result.error.code === 'NOT_FOUND' ? 404 : 400
    return Response.json({ error: formatError(result.error) }, { status: httpStatus })
  }
  const tasks = result.data.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority
  }))
  return Response.json({ tasks, total: result.data.total })
}

// EXPERIMENTAL: provisional read-only endpoint, response shape subject to change.
function handleTaskView(svc: TaskService, pathname: string): Response {
  const rawId = pathname.slice('/api/task/'.length)
  const id = Number(rawId)
  if (rawId.length === 0 || !Number.isInteger(id)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }
  const view = svc.getTaskView(id)
  if (!view.ok) {
    return Response.json({ error: formatError(view.error) }, { status: 404 })
  }
  const comments = svc.listComments(id)
  return Response.json({
    task: view.data.task,
    blocked_by: view.data.blockedBy,
    ...(view.data.subtasks !== undefined ? { subtasks: view.data.subtasks } : {}),
    comments: comments.ok ? comments.data : []
  })
}

export function startHttp(opts: StartHttpOptions) {
  const { svc, port, host, dbPath, maxSessions = DEFAULT_HTTP_MAX_SESSIONS, sessionTtlMs = DEFAULT_HTTP_SESSION_TTL_MS, logger, onShutdown } = opts
  const svcLogger = logger ?? createLogger('http', 'off')
  const registry = new SessionRegistry({ logger: svcLogger, maxSessions, sessionTtlMs })

  const cleanup = setInterval(() => registry.sweep(), SESSION_CLEANUP_INTERVAL_MS)

  const server = Bun.serve({
    port,
    hostname: host,
    idleTimeout: HTTP_IDLE_TIMEOUT_SEC,
    async fetch(req) {
      try {
        const url = new URL(req.url)

        if (url.pathname === '/health' && req.method === 'GET') {
          return Response.json({ ok: true, version: VERSION })
        }

        if (url.pathname.startsWith('/api/')) {
          if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS })
          }
          if (req.method === 'GET' && url.pathname === '/api/tasks') {
            return withCors(handleTaskList(svc, url))
          }
          if (req.method === 'GET' && url.pathname.startsWith('/api/task/')) {
            return withCors(handleTaskView(svc, url.pathname))
          }
          return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
        }

        if (url.pathname !== '/mcp') {
          return new Response('Not Found', { status: 404 })
        }

        const sessionId = req.headers.get('mcp-session-id')

        if (sessionId) {
          const session = registry.get(sessionId)
          if (!session) {
            return Response.json(SESSION_NOT_FOUND, { status: 404 })
          }
          session.lastAccess = Date.now()
          return trackStreamActivity(await session.transport.handleRequest(req), session)
        }

        if (!registry.reserve()) {
          return Response.json({ error: 'Too many sessions' }, { status: 429 })
        }
        try {
          const peek = await peekInitialize(req, svcLogger, DEFAULT_HTTP_MAX_BODY_BYTES)
          if (peek.oversized) {
            return new Response('Payload Too Large', { status: 413 })
          }
          if (!peek.isInitialize) {
            return Response.json(SESSION_REQUIRED, { status: 400 })
          }

          const mcpServer = createMcpServer(svc)
          const eventStore = new InMemoryEventStore()
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            keepAliveMs: SSE_KEEPALIVE_MS,
            eventStore,
            // The same cap as the peek, applied by the transport itself: a session-bearing POST
            // never runs the peek, so without this it would fall back to the SDK's 4 MiB default.
            maxRequestBodySize: DEFAULT_HTTP_MAX_BODY_BYTES,
            onsessioninitialized: (id) => {
              registry.open(id, { transport, lastAccess: Date.now(), agent: peek.agentName })
            },
            onsessionclosed: (id) => {
              registry.close(id)
            }
          })
          transport.onclose = () => eventStore.clear()

          await mcpServer.connect(transport)
          const response = await transport.handleRequest(peek.request)
          const session = transport.sessionId ? registry.get(transport.sessionId) : undefined
          if (!session) {
            transport.close().catch(() => {})
            mcpServer.close().catch(() => {})
            return response
          }
          return trackStreamActivity(response, session)
        } finally {
          registry.release()
        }
      } catch (err) {
        svcLogger.error('http handler error', normalizeError(err))
        return new Response('Internal Server Error', { status: 500 })
      }
    }
  })

  const shutdown = () => {
    clearInterval(cleanup)
    registry.closeAll()
    server.stop(true)
    onShutdown?.()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  svcLogger.info('ziptask started', { version: VERSION, host, port: server.port, dbPath: dbPath ?? '' })
  return server
}
