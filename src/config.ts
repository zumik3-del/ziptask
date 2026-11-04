import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod/v4'
import {
  DEFAULT_DB_PATH, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_LEASE_TTL_MIN, DEFAULT_MAX_ATTEMPTS,
  DEFAULT_REAP_COOLDOWN_SEC, DEFAULT_AUTO_CLAIM_CEILING, DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS, DEFAULT_PRIORITY, DEFAULT_REPORTER, DEFAULT_LIST_LIMIT,
  DEFAULT_TIMELINE_LIMIT, DEFAULT_QUEUE_LIMIT, DEFAULT_LOG_LEVEL, DEFAULT_AUDIT_LOG,
  LEVELS
} from './defaults'
import { isTaskPriorityInput, normalizePriority, PRIORITY_INVALID_MESSAGE, MAX_LEASE_TTL_MIN } from './core/tasks'

// The configured default accepts the same shapes as create_task (the canonical "pN", the number N
// and the digit string "N"): the normalizer in src/core/tasks.ts is the one mapping, and the
// transform turns the accepted shape into the canonical string the settings carry.
export const PRIORITY_INPUT = z.unknown().refine(
  (value) => value === undefined || isTaskPriorityInput(value),
  { message: `INVALID: ${PRIORITY_INVALID_MESSAGE}` }
)

export const DEFAULTS = Object.freeze({
  dbPath: DEFAULT_DB_PATH,
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  leaseTtlMin: DEFAULT_LEASE_TTL_MIN,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  reapCooldownSec: DEFAULT_REAP_COOLDOWN_SEC,
  autoClaimCeiling: DEFAULT_AUTO_CLAIM_CEILING,
  http: { maxSessions: DEFAULT_HTTP_MAX_SESSIONS, sessionTtlMs: DEFAULT_HTTP_SESSION_TTL_MS },
  defaults: {
    priority: DEFAULT_PRIORITY,
    reporter: DEFAULT_REPORTER,
    listLimit: DEFAULT_LIST_LIMIT,
    timelineLimit: DEFAULT_TIMELINE_LIMIT,
    queueLimit: DEFAULT_QUEUE_LIMIT
  },
  logging: { level: DEFAULT_LOG_LEVEL },
  auditLog: DEFAULT_AUDIT_LOG
} as const)

// Object-level partiality: each top-level key and the two nested groups may be omitted or
// partial, exactly like the hand-written schema before.
const partialGroup = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial()

const boundaries = {
  dbPath: z.string(),
  host: z.string(),
  port: z.number().int().nonnegative(),
  leaseTtlMin: z.number().int().positive().max(MAX_LEASE_TTL_MIN),
  maxAttempts: z.number().int().positive(),
  reapCooldownSec: z.number().int().positive(),
  autoClaimCeiling: z.number().int().positive(),
  http: partialGroup({ maxSessions: z.number().int().positive(), sessionTtlMs: z.number().int().positive() }),
  defaults: partialGroup({
    priority: PRIORITY_INPUT.optional().transform(value => normalizePriority(value) ?? undefined),
    reporter: z.string(),
    listLimit: z.number().int().positive(),
    timelineLimit: z.number().int().positive(),
    queueLimit: z.number().int().positive()
  })
}

const SettingsSchema = z.object({
  ...boundaries,
  logging: partialGroup({ level: z.enum(LEVELS) }),
  auditLog: z.boolean()
}).partial()

// The env layer is the last word, so the merged result is re-validated against the same
// boundaries minus logging.level: that one stays a raw string on purpose (the logger parses
// it and warns about an unknown level, see src/logger.ts).
// The merged result is always complete (defaults filled in), so it is validated against a
// required schema rather than the partial one: the type is derived from it, not hand-mirrored.
const CompleteSettingsSchema = z.object({
  dbPath: z.string(),
  host: z.string(),
  port: z.number().int().nonnegative(),
  leaseTtlMin: z.number().int().positive().max(MAX_LEASE_TTL_MIN),
  maxAttempts: z.number().int().positive(),
  reapCooldownSec: z.number().int().positive(),
  autoClaimCeiling: z.number().int().positive(),
  http: z.object({ maxSessions: z.number().int().positive(), sessionTtlMs: z.number().int().positive() }),
  defaults: z.object({
    priority: PRIORITY_INPUT.transform(value => normalizePriority(value) ?? DEFAULT_PRIORITY),
    reporter: z.string(),
    listLimit: z.number().int().positive(),
    timelineLimit: z.number().int().positive(),
    queueLimit: z.number().int().positive()
  }),
  logging: z.object({ level: z.string() }),
  auditLog: z.boolean()
})

export type Settings = z.infer<typeof CompleteSettingsSchema>

// Level parsing is the logger's job: the raw ZIPTASK_LOG_LEVEL string reaches createLogger
// so it can warn about an unknown level. settings.json keeps the closed enum instead, so a
// bad value in the file still fails startup loudly.
export type EnvType = 'string' | 'int' | 'bool'

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
  { env: 'ZIPTASK_REAP_COOLDOWN_SEC', path: 'reapCooldownSec', type: 'int' },
  { env: 'ZIPTASK_AUTO_CLAIM_CEILING', path: 'autoClaimCeiling', type: 'int' },
  { env: 'ZIPTASK_HTTP_MAX_SESSIONS', path: 'http.maxSessions', type: 'int' },
  { env: 'ZIPTASK_HTTP_SESSION_TTL_MS', path: 'http.sessionTtlMs', type: 'int' },
  { env: 'ZIPTASK_DEFAULTS_PRIORITY', path: 'defaults.priority', type: 'string' },
  { env: 'ZIPTASK_DEFAULTS_REPORTER', path: 'defaults.reporter', type: 'string' },
  { env: 'ZIPTASK_DEFAULTS_LIST_LIMIT', path: 'defaults.listLimit', type: 'int' },
  { env: 'ZIPTASK_DEFAULTS_TIMELINE_LIMIT', path: 'defaults.timelineLimit', type: 'int' },
  { env: 'ZIPTASK_DEFAULTS_QUEUE_LIMIT', path: 'defaults.queueLimit', type: 'int' },
  { env: 'ZIPTASK_LOG_LEVEL', path: 'logging.level', type: 'string' },
  { env: 'ZIPTASK_AUDIT_LOG', path: 'auditLog', type: 'bool' },
]

// Strict on purpose: a value of the wrong shape is a typo, and reinterpreting it would change
// behaviour silently (parseInt stops at the first non-digit, a bare boolean test turns every other
// string into false). The caller warns and drops the override instead.
const INT_VALUE_PATTERN = /^\d+$/

function parseValue(raw: string, type: EnvType): string | number | boolean | undefined {
  switch (type) {
    case 'string': return raw
    case 'int': return INT_VALUE_PATTERN.test(raw) ? parseInt(raw, 10) : undefined
    // true/false are the same words in any case; `1`/`yes`/empty stay invalid instead of being guessed.
    case 'bool': {
      const value = raw.toLowerCase()
      return value === 'true' ? true : value === 'false' ? false : undefined
    }
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
}

// A bare `--settings` (no next argv, or a flag-like next argv) and the equals form with an empty
// or flag-like value are user mistakes: returning undefined here would silently fall back to
// ZIPTASK_SETTINGS/defaults.
const SETTINGS_FLAG = '--settings'
const SETTINGS_FLAG_PREFIX = `${SETTINGS_FLAG}=`

function missingSettingsPath(value: string | undefined): Error {
  return new Error(`Missing path for --settings${value ? ` (got '${value}')` : ''}`)
}

function settingsPathFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    let value: string | undefined
    if (arg === SETTINGS_FLAG) {
      value = argv[i + 1]
    } else if (arg.startsWith(SETTINGS_FLAG_PREFIX)) {
      value = arg.slice(SETTINGS_FLAG_PREFIX.length)
    } else {
      continue
    }
    if (!value || value.startsWith('-')) throw missingSettingsPath(value)
    return value
  }
  return undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key)
}

// Loopback hosts are the only safe bind targets: the HTTP surface has no authentication by
// design, so binding anywhere else is an explicit operator choice that must be acknowledged.
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

export function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  if (keys.length === 0 || keys.some((k) => k.length === 0) || keys.some(isDangerousKey)) {
    // Block dangerous property names and invalid segments to prevent prototype pollution.
    return
  }
  let current: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (!Object.hasOwn(current, key)) {
      current[key] = {}
    } else {
      const existing = current[key]
      if (!isPlainObject(existing)) {
        current[key] = {}
      }
    }
    const next = current[key]
    // `next` is always a plain object here: missing/non-plain intermediates were
    // replaced above, so the guard is intentionally omitted.
    current = next as Record<string, unknown>
  }
  const last = keys[keys.length - 1]
  if (last.length === 0 || isDangerousKey(last)) return
  current[last] = value
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(target)) {
    if (isDangerousKey(key)) continue
    const t = target[key]
    result[key] = isPlainObject(t) ? deepMerge(t, {}) : t
  }
  for (const key of Object.keys(source)) {
    if (isDangerousKey(key)) continue
    const s = source[key]
    const t = result[key]
    result[key] = isPlainObject(s) && isPlainObject(t) ? deepMerge(t, s) : s
  }
  return result
}

export function loadSettings(opts?: {
  path?: string
  env?: NodeJS.ProcessEnv
  argv?: string[]
  warn?: (message: string, fields: Record<string, unknown>) => void
}): Settings {
  const env = opts?.env ?? process.env
  const argv = opts?.argv ?? process.argv

  const cliSettingsPath = settingsPathFromArgv(argv)

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
    if (value === undefined) {
      // A typo in an env var must not silently vanish: keep the previous value
      // (settings.json or default) but surface the ignored override to the caller's logger.
      opts?.warn?.(`ignoring invalid ${envName} value`, { value: raw })
      continue
    }
    setNested(merged, path, value)
  }

  const validated = CompleteSettingsSchema.safeParse(merged)
  if (!validated.success) {
    throw new Error(`Invalid configuration after env overrides: ${formatIssues(validated.error)}`)
  }

  return validated.data
}
