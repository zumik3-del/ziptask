/**
 * app_version — the version gate every install and update runs through.
 *
 * WHY THIS FILE. `cmd="${APP_VERSION_CMD:-\${BIN} --version}"` shipped with the
 * inner `}` unescaped. Bash closed the `:-` expansion at `${BIN`, so the command
 * became `${BIN} --version --version}` with APP_VERSION_CMD set (app.env sets it)
 * and `${BIN --version}` without it. app_version then reported nothing for every
 * binary, and install.sh/update.sh aborted at "did not report a version" — first
 * seen moving the production install on 2026-11-25 (0.8.0 -> 0.9.0), where the
 * binary itself was fine when run by hand.
 *
 * The stub here rejects any argument other than a single `--version`, which the
 * broken form cannot satisfy: it is the one property that distinguishes the fix
 * from the defect, and it must hold both with and without APP_VERSION_CMD.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMMON = join(import.meta.dir, 'lib', 'common.sh')
const TREE = mkdtempSync(join(tmpdir(), 'ziptask-app-version-'))

const stub = join(TREE, 'bin')
writeFileSync(
  stub,
  '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || { echo "unexpected args: $*" >&2; exit 2; }\necho "ziptask 9.9.9"\n'
)
chmodSync(stub, 0o755)

function appVersion(extraEnv: Record<string, string>): { out: string; status: number | null } {
  const script = `APP_NAME=ziptask\n. "${COMMON}"\napp_version "${stub}"\n`
  const res = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extraEnv },
    encoding: 'utf8'
  })
  return { out: (res.stdout ?? '').trim(), status: res.status }
}

afterAll(() => {
  rmSync(TREE, { recursive: true, force: true })
})

describe('app_version', () => {
  test('falls back to the default --version command when APP_VERSION_CMD is unset', () => {
    expect(appVersion({})).toEqual({ out: '9.9.9', status: 0 })
  })

  test('honours the APP_VERSION_CMD app.env declares', () => {
    expect(appVersion({ APP_VERSION_CMD: `\${BIN} --version` })).toEqual({
      out: '9.9.9',
      status: 0
    })
  })
})
