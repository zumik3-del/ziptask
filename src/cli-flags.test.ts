import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { VERSION } from './version'

const TMP = '/tmp/opencode'
const ENTRY = resolve(import.meta.dir, 'index.ts')

let workDir: string

function spawnCli(args: string[]) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ZIPTASK_')) env[key] = value
  }
  return spawnSync(process.execPath, ['run', ENTRY, ...args], {
    cwd: workDir,
    env,
    timeout: 15_000,
    encoding: 'utf8'
  })
}

function dataDirCreated(): boolean {
  return existsSync(join(workDir, 'data'))
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  workDir = join(TMP, `cli-flags-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(workDir, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true })
  } catch {}
})

describe('ziptask --version / --help are config-independent (#2578)', () => {
  test('--version exits 0 and prints the version when no settings are given', () => {
    const result = spawnCli(['--version'])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`ziptask ${VERSION}\n`)
    expect(result.stderr).toBe('')
    expect(dataDirCreated()).toBe(false)
  })

  test('--version exits 0 despite an invalid-JSON --settings file', () => {
    const badPath = join(workDir, 'bad.json')
    writeFileSync(badPath, '{ this is not json }}}')
    const result = spawnCli(['--version', '--settings', badPath])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`ziptask ${VERSION}\n`)
    expect(result.stderr).toBe('')
    expect(dataDirCreated()).toBe(false)
  })

  test('--version exits 0 despite a schema-invalid --settings= file', () => {
    const badPath = join(workDir, 'bad-schema.json')
    writeFileSync(badPath, JSON.stringify({ port: -1 }))
    const result = spawnCli([`--settings=${badPath}`, '--version'])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`ziptask ${VERSION}\n`)
    expect(result.stderr).toBe('')
    expect(dataDirCreated()).toBe(false)
  })

  test('--help exits 0 and prints the usage block naming every flag', () => {
    const result = spawnCli(['--help'])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: ziptask [options]')
    expect(result.stdout).toContain('--stdio')
    expect(result.stdout).toContain('--settings <path>')
    expect(result.stdout).toContain('--version')
    expect(result.stdout).toContain('--help')
    expect(result.stderr).toBe('')
    expect(dataDirCreated()).toBe(false)
  })

  test('--help is not blocked by an unreadable --settings path', () => {
    const result = spawnCli(['--help', '--settings', join(workDir, 'missing.json')])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage: ziptask [options]')
    expect(dataDirCreated()).toBe(false)
  })
})

describe('ziptask refuses an unknown flag (#2578)', () => {
  test('an unknown flag exits non-zero with exactly one stderr line and no listener', () => {
    const result = spawnCli(['--setings', 'x.json'])
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Unknown flag: --setings (try --help)\n')
    expect(dataDirCreated()).toBe(false)
  })

  test('a short unknown flag is refused with the same one-line contract', () => {
    const result = spawnCli(['-x'])
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Unknown flag: -x (try --help)\n')
  })

  test('a bare --settings is refused instead of starting the server', () => {
    const result = spawnCli(['--settings'])
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Missing path for --settings\n')
    expect(dataDirCreated()).toBe(false)
  })
})
