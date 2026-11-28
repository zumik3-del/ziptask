import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SRC_ROOT = resolve(import.meta.dir, '../src')

// db/ may only reach the core modules it legitimately uses: anything else can pull services,
// guards or queries back in and would re-couple the layers (ADR 0003). This is an allowlist,
// not a denylist: a core module added later stays denied until it is deliberately listed here.
const DB_CORE_ALLOWLIST = new Set(['tasks', 'types'])

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]

type Layer = 'core' | 'db' | 'mcp'

export type BoundaryReport = { filesScanned: number; failures: string[] }

function layerOf(srcRelativePath: string): Layer | null {
  const [head] = srcRelativePath.split('/')
  return head === 'core' || head === 'db' || head === 'mcp' ? head : null
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listSourceFiles(path))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path)
  }
  return files
}

function resolveToSrc(srcRoot: string, file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(file), specifier)
  if (!target.startsWith(srcRoot + sep)) return null
  return relative(srcRoot, target).split(sep).join('/')
}

function coreModuleOf(srcRelativePath: string): string {
  return srcRelativePath
    .slice('core/'.length)
    .split('/')[0]
    .replace(/\.(ts|tsx|js)$/, '')
}

function violation(
  sourceLayer: Layer,
  targetSrcPath: string
): ((specifier: string) => string) | null {
  const targetLayer = layerOf(targetSrcPath)
  if (targetLayer === 'db' && (sourceLayer === 'core' || sourceLayer === 'mcp')) {
    return (specifier) =>
      `rule 1: ${sourceLayer}/ must not import db/ — import '${specifier}' resolves to ${targetSrcPath}`
  }
  if (targetLayer === 'mcp' && (sourceLayer === 'core' || sourceLayer === 'db')) {
    return (specifier) =>
      `rule 2: ${sourceLayer}/ must not import mcp/ — import '${specifier}' resolves to ${targetSrcPath}`
  }
  if (targetLayer === 'core' && sourceLayer === 'db') {
    const module = coreModuleOf(targetSrcPath)
    if (!DB_CORE_ALLOWLIST.has(module)) {
      return (specifier) =>
        `rule 3: db/ may only import allowlisted core/ modules — core/${module} is not allowlisted (import '${specifier}')`
    }
  }
  return null
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

export function findViolations(srcRoot: string): BoundaryReport {
  const root = resolve(srcRoot)
  const files = listSourceFiles(root)
  const failures: string[] = []

  for (const file of files) {
    const srcRelativePath = relative(root, file).split(sep).join('/')
    const sourceLayer = layerOf(srcRelativePath)
    if (!sourceLayer) continue
    const source = readFileSync(file, 'utf-8')
    const displayPath = relative(dirname(root), file).split(sep).join('/')
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]
        const targetSrcPath = resolveToSrc(root, file, specifier)
        if (!targetSrcPath) continue
        const check = violation(sourceLayer, targetSrcPath)
        if (check)
          failures.push(`${displayPath}:${lineAt(source, match.index)} ${check(specifier)}`)
      }
    }
  }

  return { filesScanned: files.length, failures: [...new Set(failures)].sort() }
}

if (import.meta.main) {
  const report = findViolations(SRC_ROOT)
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(failure)
    console.error(
      `\n${report.failures.length} layer boundary violation(s) in ${report.filesScanned} file(s)`
    )
    process.exit(1)
  }

  console.log(`Layer boundaries ok (${report.filesScanned} file(s) scanned)`)
}
