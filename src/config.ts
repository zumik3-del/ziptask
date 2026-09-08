import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod/v4'

export const DEFAULTS = {
  dbPath: './data/ziptask.db',
  host: '127.0.0.1',
  port: 0,
  leaseTtlMin: 15,
  maxAttempts: 3,
  http: { maxSessions: 100, sessionTtlMs: 3_600_000 },
  defaults: { priority: 'p2', reporter: 'system', listLimit: 50, timelineLimit: 50, queueLimit: 100 }
} as const

const SettingsSchema = z.object({
  dbPath: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().nonnegative().optional(),
  leaseTtlMin: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  http: z.object({
    maxSessions: z.number().int().positive().optional(),
    sessionTtlMs: z.number().int().positive().optional()
  }).optional(),
  defaults: z.object({
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
    reporter: z.string().optional(),
    listLimit: z.number().int().positive().optional(),
    timelineLimit: z.number().int().positive().optional(),
    queueLimit: z.number().int().positive().optional()
  }).optional()
})

export type Settings = z.infer<typeof SettingsSchema> & {
  dbPath: string
  host: string
  port: number
  leaseTtlMin: number
  maxAttempts: number
  http: { maxSessions: number; sessionTtlMs: number }
  defaults: { priority: string; reporter: string; listLimit: number; timelineLimit: number; queueLimit: number }
}

export type EnvType = 'string' | 'int' | 'float' | 'bool'

export interface EnvMapping {
  env: string
  path: string
  type: EnvType
}

export const ENV_MAPPINGS: EnvMapping[] = [
  { env: 'ZIPTASK_DB', path: 'dbPath', type: 'string' },
  { env: 'ZIPTASK_HOST', path: 'host', type: 'string' },
  { env: 'ZIPTASK_PORT', path: 'port', type: 'int' },
  { env: 'ZIPTASK_LEASE_TTL_MIN', path: 'leaseTtlMin', type: 'int' },
  { env: 'ZIPTASK_MAX_ATTEMPTS', path: 'maxAttempts', type: 'int' },
  { env: 'ZIPTASK_HTTP_MAX_SESSIONS', path: 'http.maxSessions', type: 'int' },
  { env: 'ZIPTASK_HTTP_SESSION_TTL_MS', path: 'http.sessionTtlMs', type: 'int' },
  { env: 'ZIPTASK_DEFAULTS_PRIORITY', path: 'defaults.priority', type: 'string' },
  { env: 'ZIPTASK_DEFAULTS_REPORTER', path: 'defaults.reporter', type: 'string' },
  { env: 'ZIPTASK_DEFAULTS_LIST_LIMIT', path: 'defaults.listLimit', type: 'int' },
  { env: 'ZIPTASK_DEFAULTS_TIMELINE_LIMIT', path: 'defaults.timelineLimit', type: 'int' },
  { env: 'ZIPTASK_DEFAULTS_QUEUE_LIMIT', path: 'defaults.queueLimit', type: 'int' },
]

function parseValue(raw: string, type: EnvType): string | number | boolean {
  switch (type) {
    case 'string': return raw
    case 'int': {
      const n = parseInt(raw, 10)
      return Number.isFinite(n) ? n : NaN
    }
    case 'float': {
      const n = parseFloat(raw)
      return Number.isFinite(n) ? n : NaN
    }
    case 'bool': return raw === 'true'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(current[keys[i]])) current[keys[i]] = {}
    current = current[keys[i]] as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const s = source[key]
    const t = target[key]
    result[key] = isPlainObject(s) && isPlainObject(t) ? deepMerge(t, s) : s
  }
  return result
}

export function loadSettings(opts?: { path?: string; env?: NodeJS.ProcessEnv; argv?: string[] }): Settings {
  const env = opts?.env ?? process.env
  const argv = opts?.argv ?? process.argv

  const cliSettingsIdx = argv.indexOf('--settings')
  const cliSettingsPath = cliSettingsIdx !== -1 ? argv[cliSettingsIdx + 1] : undefined

  let settingsPath: string | null = null
  if (opts?.path) {
    settingsPath = opts.path
  } else if (cliSettingsPath) {
    settingsPath = resolve(cliSettingsPath)
  } else if (env.ZIPTASK_SETTINGS) {
    settingsPath = resolve(env.ZIPTASK_SETTINGS)
  }

  let fileOverrides: Partial<Settings> | null = null
  if (settingsPath) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw)
      const result = SettingsSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(`Invalid settings.json: ${result.error.message}`)
      }
      fileOverrides = result.data as Partial<Settings>
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Invalid JSON in settings file ${settingsPath}: ${e.message}`)
      }
      throw e
    }
  }

  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileOverrides ? (fileOverrides as unknown as Record<string, unknown>) : {}
  )

  for (const { env: envName, path, type } of ENV_MAPPINGS) {
    const raw = env[envName]
    if (raw === undefined) continue
    const value = parseValue(raw, type)
    if (typeof value === 'number' && Number.isNaN(value)) {
      continue
    }
    setNested(merged, path, value)
  }

  return merged as unknown as Settings
}
