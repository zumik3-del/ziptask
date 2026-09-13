import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import type { Logger } from './logger'
import { createLogger } from './logger'

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
}

class InMemoryEventStore {
  private events = new Map<string, { streamId: string; message: unknown }>()

  private generateEventId(streamId: string): string {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
  }

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const eventId = this.generateEventId(streamId)
    this.events.set(eventId, { streamId, message })
    return eventId
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: unknown) => Promise<void> }): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) return ''
    const streamId = this.events.get(lastEventId)!.streamId
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let found = false
    for (const [id, { streamId: sId, message }] of sorted) {
      if (sId !== streamId) continue
      if (id === lastEventId) { found = true; continue }
      if (found) await send(id, message as any)
    }
    return streamId
  }
}

export interface StartHttpOptions {
  svc: TaskService
  port: number
  host: string
  maxSessions?: number
  sessionTtlMs?: number
  logger?: Logger
  onShutdown?: () => void
}

export function startHttp(opts: StartHttpOptions) {
  const { svc, port, host, maxSessions = 100, sessionTtlMs = 3_600_000, logger, onShutdown } = opts
  const svcLogger = logger ?? createLogger('http', 'off')
  const sessions = new Map<string, Session>()

  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastAccess > sessionTtlMs) {
        session.transport.close().catch(() => {})
        sessions.delete(id)
      }
    }
  }, 60_000)

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
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
        if (session) {
          session.lastAccess = Date.now()
          return session.transport.handleRequest(req)
        }
      }

      if (sessions.size >= maxSessions) {
        return Response.json({ error: 'Too many sessions' }, { status: 429 })
      }

      const mcpServer = createMcpServer(svc)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        eventStore: new InMemoryEventStore() as any,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastAccess: Date.now() })
        },
        onsessionclosed: (id) => {
          sessions.delete(id)
        }
      })

      await mcpServer.connect(transport)
      return transport.handleRequest(req)
    }
  })

  const shutdown = () => {
    clearInterval(cleanup)
    server.stop()
    onShutdown?.()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  svcLogger.info(`MCP HTTP server on http://${host}:${server.port}`)
  return server
}
