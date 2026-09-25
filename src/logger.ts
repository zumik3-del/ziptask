export type LogLevel = 'off' | 'error' | 'info' | 'debug'

const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 }

export interface Logger {
  error(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
}

export function createLogger(name: string, level: LogLevel): Logger {
  function shouldWrite(l: LogLevel): boolean {
    if (level === 'off') return false
    return LEVEL_ORDER[l] <= LEVEL_ORDER[level]
  }

  function write(level: LogLevel, msg: string, args: unknown[]): void {
    if (!shouldWrite(level)) return
    const prefix = `[ziptask] [${level}] [${name}] ${msg}`
    process.stderr.write(prefix + (args.length ? ' ' + JSON.stringify(args) : '') + '\n')
  }

  return {
    error(msg: string, ...args: unknown[]) {
      write('error', msg, args)
    },
    info(msg: string, ...args: unknown[]) {
      write('info', msg, args)
    },
    debug(msg: string, ...args: unknown[]) {
      write('debug', msg, args)
    }
  }
}
