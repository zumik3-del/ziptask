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

  const merged: Settings = {
    dbPath: DEFAULTS.dbPath,
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    leaseTtlMin: DEFAULTS.leaseTtlMin,
    maxAttempts: DEFAULTS.maxAttempts,
    http: { ...DEFAULTS.http },
    defaults: { ...DEFAULTS.defaults }
  }

  if (fileOverrides) {
    if (fileOverrides.dbPath !== undefined) merged.dbPath = fileOverrides.dbPath
    if (fileOverrides.host !== undefined) merged.host = fileOverrides.host
    if (fileOverrides.port !== undefined) merged.port = fileOverrides.port
    if (fileOverrides.leaseTtlMin !== undefined) merged.leaseTtlMin = fileOverrides.leaseTtlMin
    if (fileOverrides.maxAttempts !== undefined) merged.maxAttempts = fileOverrides.maxAttempts
    if (fileOverrides.http) {
      if (fileOverrides.http.maxSessions !== undefined) merged.http.maxSessions = fileOverrides.http.maxSessions
      if (fileOverrides.http.sessionTtlMs !== undefined) merged.http.sessionTtlMs = fileOverrides.http.sessionTtlMs
    }
    if (fileOverrides.defaults) {
      if (fileOverrides.defaults.priority !== undefined) merged.defaults.priority = fileOverrides.defaults.priority
      if (fileOverrides.defaults.reporter !== undefined) merged.defaults.reporter = fileOverrides.defaults.reporter
      if (fileOverrides.defaults.listLimit !== undefined) merged.defaults.listLimit = fileOverrides.defaults.listLimit
      if (fileOverrides.defaults.timelineLimit !== undefined) merged.defaults.timelineLimit = fileOverrides.defaults.timelineLimit
      if (fileOverrides.defaults.queueLimit !== undefined) merged.defaults.queueLimit = fileOverrides.defaults.queueLimit
    }
  }

  if (env.ZIPTASK_DB) merged.dbPath = env.ZIPTASK_DB
  if (env.ZIPTASK_HOST) merged.host = env.ZIPTASK_HOST
  if (env.ZIPTASK_PORT) merged.port = Number(env.ZIPTASK_PORT)
  if (env.ZIPTASK_LEASE_TTL_MIN) merged.leaseTtlMin = Number(env.ZIPTASK_LEASE_TTL_MIN)
  if (env.ZIPTASK_MAX_ATTEMPTS) merged.maxAttempts = Number(env.ZIPTASK_MAX_ATTEMPTS)

  return merged
}
