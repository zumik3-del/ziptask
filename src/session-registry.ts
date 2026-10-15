import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Logger } from './logger'

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  lastAccess: number
  agent: string
}

export interface SessionRegistryOptions {
  logger: Logger
  maxSessions: number
  sessionTtlMs: number
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>()
  private readonly logger: Logger
  private readonly maxSessions: number
  private readonly sessionTtlMs: number
  private reserved = 0

  constructor({ logger, maxSessions, sessionTtlMs }: SessionRegistryOptions) {
    this.logger = logger
    this.maxSessions = maxSessions
    this.sessionTtlMs = sessionTtlMs
  }

  // A reserved slot belongs to an in-flight handshake, so the cap counts those too: two
  // concurrent initializes cannot both read "one slot left" and overshoot.
  reserve(): boolean {
    if (this.sessions.size + this.reserved >= this.maxSessions) return false
    this.reserved++
    return true
  }

  release(): void {
    this.reserved--
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  open(id: string, session: Session): void {
    this.sessions.set(id, session)
    this.logger.child({ session: id, agent: session.agent }).info('session open')
  }

  // A client-initiated close is logged even for an id the registry no longer holds, so the
  // close line always pairs with the open one.
  close(id: string): void {
    const session = this.sessions.get(id)
    this.logClose(id, session?.agent ?? 'unknown')
    this.sessions.delete(id)
  }

  sweep(now: number = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccess > this.sessionTtlMs) this.evict(id, session)
    }
  }

  closeAll(): void {
    for (const [id, session] of [...this.sessions]) this.evict(id, session)
  }

  private evict(id: string, session: Session): void {
    this.logClose(id, session.agent)
    session.transport.close().catch(() => {})
    this.sessions.delete(id)
  }

  private logClose(id: string, agent: string): void {
    this.logger.child({ session: id, agent }).info('session close')
  }
}
