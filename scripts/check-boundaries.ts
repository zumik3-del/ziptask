import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SRC_ROOT = resolve(import.meta.dir, '../src')

// db/ may only reach core modules that carry no domain behaviour: these pull services,
// guards or queries back in and would re-couple the layers (ADR 0003).
const NON_LEAF_CORE = new Set([
  'service',
  'guards',
  'task-lifecycle',
  'task-query',
  'projects',
  'candidates',
  'reaper'
])

const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]

type Layer = 'core' | 'db' | 'mcp'

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

function resolveToSrc(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(file), specifier)
  if (!target.startsWith(SRC_ROOT + sep)) return null
  return relative(SRC_ROOT, target).split(sep).join('/')
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
    if (NON_LEAF_CORE.has(module)) {
      return (specifier) =>
        `rule 3: db/ may only import leaf core/ modules — core/${module} is not a leaf (import '${specifier}')`
    }
  }
  return null
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

const files = listSourceFiles(SRC_ROOT)
const failures: string[] = []

for (const file of files) {
  const sourceLayer = layerOf(relative(SRC_ROOT, file).split(sep).join('/'))
  if (!sourceLayer) continue
  const source = readFileSync(file, 'utf-8')
  const displayPath = `src/${relative(SRC_ROOT, file).split(sep).join('/')}`
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      const targetSrcPath = resolveToSrc(file, specifier)
      if (!targetSrcPath) continue
      const check = violation(sourceLayer, targetSrcPath)
      if (check) failures.push(`${displayPath}:${lineAt(source, match.index)} ${check(specifier)}`)
    }
  }
}

if (failures.length > 0) {
  const unique = [...new Set(failures)].sort()
  for (const failure of unique) console.error(failure)
  console.error(`\n${unique.length} layer boundary violation(s) in ${files.length} file(s)`)
  process.exit(1)
}

console.log(`Layer boundaries ok (${files.length} file(s) scanned)`)
