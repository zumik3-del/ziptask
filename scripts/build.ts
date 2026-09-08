import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf-8'))
const version = pkg.version

const { status } = await Bun.spawn(
  [process.execPath.replace('bun', 'bun').replace(/bun$/, 'bun'), 'build', 'src/index.ts', '--compile', '--minify', '--sourcemap', '--outfile', 'dist/ziptask', '--define', `globalThis.__ZIPTASK_VERSION__="${version}"`],
  { cwd: resolve(import.meta.dir, '..') }
)

if (status !== 0) process.exit(status)
console.log(`Built dist/ziptask v${version}`)

