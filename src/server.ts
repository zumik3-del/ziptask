import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { TaskService } from './core/service'
import { createMcpServer } from './mcp/server'
import type { Logger } from './logger'
import { createLogger } from './logger'
import { VERSION } from './version'

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
  agent: string
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
  dbPath?: string
  maxSessions?: number
  sessionTtlMs?: number
  logger?: Logger
  onShutdown?: () => void
}

async function peekInitialize(req: Request, hasSession: boolean): Promise<{ request: Request; agentName: string }> {
  if (hasSession || req.method !== 'POST') return { request: req, agentName: 'unknown' }
  const body = await req.text()
  const request = new Request(req.url, { method: req.method, headers: req.headers, body })
  let agentName = 'unknown'
  try {
    const parsed = JSON.parse(body)
    const init = Array.isArray(parsed) ? parsed.find(m => m?.method === 'initialize') : parsed
    const name = init?.params?.clientInfo?.name
    if (typeof name === 'string' && name.length > 0) agentName = name
  } catch {}
  return { request, agentName }
}

export function startHttp(opts: StartHttpOptions) {
  const { svc, port, host, dbPath, maxSessions = 100, sessionTtlMs = 3_600_000, logger, onShutdown } = opts
  const svcLogger = logger ?? createLogger('http', 'off')
  const sessions = new Map<string, Session>()
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
  }, 60_000)

  const server = Bun.serve({
    port,
    hostname: host,
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
          if (session) {
            session.lastAccess = Date.now()
            return session.transport.handleRequest(req)
          }
        }

        if (sessions.size >= maxSessions) {
          return Response.json({ error: 'Too many sessions' }, { status: 429 })
        }

        const { request, agentName } = await peekInitialize(req, Boolean(sessionId))
        const mcpServer = createMcpServer(svc)
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          eventStore: new InMemoryEventStore() as any,
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

        await mcpServer.connect(transport)
        return transport.handleRequest(request)
      } catch (err) {
        svcLogger.error(`http handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        return new Response('Internal Server Error', { status: 500 })
      }
    }
  })

  const shutdown = () => {
    clearInterval(cleanup)
    server.stop()
    onShutdown?.()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  svcLogger.info(`ziptask started version=${VERSION} host=${host} port=${server.port} dbPath=${dbPath ?? ''}`)
  return server
}
