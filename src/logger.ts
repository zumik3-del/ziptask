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
    return LEVEL_ORDER[l] >= LEVEL_ORDER[level]
  }

  return {
    error(msg: string, ...args: unknown[]) {
      if (!shouldWrite('error')) return
      const parts = [`[ziptask] [error] [${name}] ${msg}`]
      process.stderr.write(parts.join(' ') + (args.length ? ' ' + JSON.stringify(args) : '') + '\n')
    },
    info(msg: string, ...args: unknown[]) {
      if (!shouldWrite('info')) return
      const parts = [`[ziptask] [info] [${name}] ${msg}`]
      process.stderr.write(parts.join(' ') + (args.length ? ' ' + JSON.stringify(args) : '') + '\n')
    },
    debug(msg: string, ...args: unknown[]) {
      if (!shouldWrite('debug')) return
      const parts = [`[ziptask] [debug] [${name}] ${msg}`]
      process.stderr.write(parts.join(' ') + (args.length ? ' ' + JSON.stringify(args) : '') + '\n')
    }
  }
}
