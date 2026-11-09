import { basename, isAbsolute, resolve } from 'node:path'
import type { ProjectRow, ProjectStore, SvcError, SvcResult } from './types'
import { fail, ok } from './result'
import { requiredError } from './validation'
import { nowIso } from './tasks'
import { PROJECT_SLUG_PATTERN, PROJECT_SLUG_MAX, RESERVED_PROJECT_SLUG } from './project-slug'

export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, PROJECT_SLUG_MAX)
}

export function normalizeFolderPath(input: string): SvcResult<string> {
  if (!isAbsolute(input)) return fail('INVALID', 'folder_path must be an absolute path')
  return ok(resolve(input))
}

function slugError(slug: string): SvcError | null {
  if (!PROJECT_SLUG_PATTERN.test(slug))
    return { code: 'INVALID', message: `slug must match ${PROJECT_SLUG_PATTERN.source}` }
  if (slug === RESERVED_PROJECT_SLUG) {
    return { code: 'INVALID', message: `'${RESERVED_PROJECT_SLUG}' is a reserved project slug` }
  }
  return null
}

export function resolveProject(store: ProjectStore, slug?: string): SvcResult<ProjectRow> {
  if (slug === undefined) return fail('INVALID', 'project required')
  const project = store.projectBySlug(slug)
  if (project) return ok(project)
  const known = store.projectSlugs()
  if (known.length === 0) {
    return fail(
      'INVALID',
      `unknown project '${slug}' (no projects defined; create one with create_project)`
    )
  }
  return fail('INVALID', `unknown project '${slug}' (known: ${known.join(', ')})`)
}

function requireProject(store: ProjectStore, slug: string): SvcResult<ProjectRow> {
  const project = store.projectBySlug(slug)
  return project ? ok(project) : fail('NOT_FOUND')
}

export function createProject(
  store: ProjectStore,
  args: { slug?: string; folder_path?: string }
): SvcResult<{ slug: string }> {
  const folderPath = args.folder_path ?? ''
  const folderErr = requiredError(folderPath, 'folder_path')
  if (folderErr) return fail(folderErr)
  const normalized = normalizeFolderPath(folderPath)
  if (!normalized.ok) return fail(normalized.error)
  let slug = args.slug
  if (slug === undefined) {
    slug = normalizeSlug(basename(normalized.data))
    if (slug === '') return fail('INVALID', 'slug required (cannot derive from folder name)')
  }
  const invalid = slugError(slug)
  if (invalid) return fail(invalid)
  if (store.projectBySlug(slug)) return fail('CONFLICT', `project '${slug}' already exists`)
  store.insertProject({ slug, folderPath: normalized.data, now: nowIso() })
  return ok({ slug })
}

export function updateProject(
  store: ProjectStore,
  args: {
    project: string
    folder_path?: string
    archived?: boolean
  }
): SvcResult<{ slug: string }> {
  const found = requireProject(store, args.project)
  if (!found.ok) return fail(found.error)
  if (args.folder_path === undefined && args.archived === undefined) {
    return fail('INVALID', 'nothing to update')
  }
  const patch: { folderPath?: string; archived?: boolean } = {}
  if (args.folder_path !== undefined) {
    const folderErr = requiredError(args.folder_path, 'folder_path')
    if (folderErr) return fail(folderErr)
    const normalized = normalizeFolderPath(args.folder_path)
    if (!normalized.ok) return fail(normalized.error)
    patch.folderPath = normalized.data
  }
  if (args.archived !== undefined) patch.archived = args.archived
  store.updateProject(found.data.id, patch, nowIso())
  return ok({ slug: found.data.slug })
}

export function deleteProject(
  store: ProjectStore,
  project: string
): SvcResult<{ deleted: string }> {
  const found = requireProject(store, project)
  if (!found.ok) return fail(found.error)
  const count = store.projectTaskCount(found.data.id)
  if (count > 0)
    return fail('CONFLICT', `project '${found.data.slug}' has ${count} tasks; archive it instead`)
  store.deleteProject(found.data.id)
  return ok({ deleted: found.data.slug })
}
