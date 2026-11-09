import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import type { EventStore } from '@modelcontextprotocol/server'
import { readRequestBody, createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server'
import type { JSONRPCMessage } from '@modelcontextprotocol/server'
import type { TaskService } from './core/service'
import { formatError } from './core/result'
import { TASK_STATUS_VALUES } from './core/tasks'
import type { Task, TaskPriority, TaskStatus } from './core/tasks'
import { createMcpServer } from './mcp/server'
import type { Logger } from './logger'
import { isLoopbackHost } from './config'
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

export const CORS_ALLOW_ORIGIN = '*'
export const CORS_ALLOW_METHODS = 'GET, OPTIONS'
export const CORS_ALLOW_HEADERS = 'Content-Type'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
  'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS
}

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export async function readBodyWithLimit(
  req: Request,
  maxBytes: number
): Promise<{ body: string; oversized: boolean }> {
  const result = await readRequestBody(req, maxBytes)
  return result.tooLarge ? { body: '', oversized: true } : { body: result.text, oversized: false }
}

export function trackStreamActivity(
  response: Response,
  session: Pick<Session, 'lastAccess'>
): Response {
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
  private lastEventTs = 0

  private eventTimestamp(): number {
    const now = Date.now()
    this.lastEventTs = now > this.lastEventTs ? now : this.lastEventTs + 1
    return this.lastEventTs
  }

  private generateEventId(streamId: string): string {
    const EVENT_SEQ_PAD_WIDTH = 10
    return `${streamId}_${this.eventTimestamp()}_${String(++this.seq).padStart(EVENT_SEQ_PAD_WIDTH, '0')}`
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = this.generateEventId(streamId)
    this.events.set(eventId, { streamId, message })
    while (this.events.size > MAX_EVENT_STORE_EVENTS) {
      const oldest = this.events.keys().next().value
      if (oldest === undefined) break
      this.events.delete(oldest)
    }
    return eventId
  }

  knowsEvent(eventId: string): boolean {
    return this.events.has(eventId)
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) return ''
    const streamId = this.events.get(lastEventId)!.streamId
    const snapshot = [...this.events.entries()]
    let found = false
    for (const [id, { streamId: sId, message }] of snapshot) {
      if (sId !== streamId) continue
      if (id === lastEventId) {
        found = true
        continue
      }
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

type PeekResult =
  | { oversized: true }
  | { oversized: false; request: Request; agentName: string; isInitialize: boolean }

async function peekInitialize(
  req: Request,
  logger: Logger,
  maxBodyBytes: number
): Promise<PeekResult> {
  if (req.method !== 'POST')
    return { oversized: false, request: req, agentName: 'unknown', isInitialize: false }
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
    const init = Array.isArray(parsed) ? parsed.find((m) => m?.method === 'initialize') : parsed
    isInitialize = init?.method === 'initialize'
    const name = init?.params?.clientInfo?.name
    if (typeof name === 'string' && name.length > 0) agentName = name
  } catch (err) {
    logger.debug('peekInitialize: failed to parse request body', {
      err: err instanceof Error ? err.message : String(err)
    })
  }
  return { oversized: false, request, agentName, isInitialize }
}

const JSONRPC_SESSION_NOT_FOUND = -32001
const JSONRPC_BAD_REQUEST = -32000

const SESSION_NOT_FOUND = {
  jsonrpc: '2.0',
  error: { code: JSONRPC_SESSION_NOT_FOUND, message: 'Session not found' },
  id: null
}
const SESSION_REQUIRED = {
  jsonrpc: '2.0',
  error: { code: JSONRPC_BAD_REQUEST, message: 'Bad Request: Mcp-Session-Id header is required' },
  id: null
}
const LAST_EVENT_ID_NOT_REPLAYABLE = {
  jsonrpc: '2.0',
  error: {
    code: JSONRPC_BAD_REQUEST,
    message: "Bad Request: Last-Event-ID is not in this session's replay window"
  },
  id: null
}

export function projectTask(task: Task): {
  id: number
  title: string
  status: TaskStatus
  priority: TaskPriority
} {
  return { id: task.id, title: task.title, status: task.status, priority: task.priority }
}

// EXPERIMENTAL: provisional read-only endpoint, response shape subject to change.
function handleTaskList(svc: TaskService, url: URL): Response {
  const project = url.searchParams.get('project') ?? undefined
  const status = url.searchParams.get('status') ?? undefined
  if (
    status !== undefined &&
    !TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])
  ) {
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
  const result = svc.listTasks({ project, status: status as TaskStatus, limit })
  if (!result.ok) {
    const httpStatus = result.error.code === 'NOT_FOUND' ? 404 : 400
    return Response.json({ error: formatError(result.error) }, { status: httpStatus })
  }
  const tasks = result.data.tasks.map(projectTask)
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

export { isLoopbackHost } from './config'

export function startHttp(opts: StartHttpOptions) {
  const {
    svc,
    port,
    host,
    dbPath,
    maxSessions = DEFAULT_HTTP_MAX_SESSIONS,
    sessionTtlMs = DEFAULT_HTTP_SESSION_TTL_MS,
    logger,
    onShutdown
  } = opts
  const svcLogger = logger ?? createLogger('http', 'off')
  if (!isLoopbackHost(host)) {
    svcLogger.warn('listening on non-loopback host; HTTP has no authentication by design', { host })
  }
  const registry = new SessionRegistry({ logger: svcLogger, maxSessions, sessionTtlMs })
  const modernHandler = createMcpHandler((_ctx) => createMcpServer(svc), {
    legacy: 'reject',
    maxRequestBodySize: DEFAULT_HTTP_MAX_BODY_BYTES
  })

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
          const lastEventId = req.method === 'GET' ? req.headers.get('last-event-id') : null
          // The SDK must reach replayEventsAfter's synchronous lookup without an intervening
          // async yield; an SDK change there could allow eviction after this check.
          if (lastEventId && !session.replayWindow.knowsEvent(lastEventId)) {
            svcLogger.warn('mcp replay refused: Last-Event-ID outside the replay window', {
              session: sessionId,
              lastEventId
            })
            return Response.json(LAST_EVENT_ID_NOT_REPLAYABLE, { status: 400 })
          }
          return trackStreamActivity(await session.transport.handleRequest(req), session)
        }

        const isLegacy = await isLegacyRequest(req, undefined, {
          maxRequestBodySize: DEFAULT_HTTP_MAX_BODY_BYTES
        })
        if (!isLegacy) {
          return await modernHandler.fetch(req)
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
            maxRequestBodySize: DEFAULT_HTTP_MAX_BODY_BYTES,
            onsessioninitialized: (id) => {
              registry.open(id, {
                transport,
                lastAccess: Date.now(),
                agent: peek.agentName,
                replayWindow: eventStore
              })
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

  svcLogger.info('ziptask started', {
    version: VERSION,
    host,
    port: server.port,
    dbPath: dbPath ?? ''
  })
  return server
}
