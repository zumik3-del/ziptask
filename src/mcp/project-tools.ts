import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import type { TaskService } from '../core/service'
import { type ToolResult, toToolResult, rejectUnknownArgs, textResult } from './common'
import { sanitizePipe, pipeJoin } from '../core/tasks'

const CREATE_PROJECT_SHAPE = {
  slug: z.string().optional().describe('lowercase ^[a-z0-9][a-z0-9._-]{0,31}$; defaults to the normalized folder name'),
  folder_path: z.string().describe('absolute path of the project folder on the host that creates the row (an annotation; normalized, never checked for existence, never resolved against the server cwd). A relative path is refused: INVALID: folder_path must be an absolute path')
}

const LIST_PROJECTS_SHAPE = {}

const UPDATE_PROJECT_SHAPE = {
  project: z.string().describe('slug of the project to update'),
  slug: z.string().optional(),
  folder_path: z.string().optional().describe('absolute path; a relative one is refused: INVALID: folder_path must be an absolute path'),
  archived: z.boolean().optional().describe('true stamps archived_at (create_task refuses); false clears it and is idempotent')
}

const DELETE_PROJECT_SHAPE = {
  project: z.string().describe('slug of the project to delete')
}

export function handleCreateProject(svc: TaskService, args: { slug?: string; folder_path: string }): ToolResult {
  const unknown = rejectUnknownArgs('create_project', CREATE_PROJECT_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.projects.create(args))
}

export function handleListProjects(svc: TaskService, args: object): ToolResult {
  const unknown = rejectUnknownArgs('list_projects', LIST_PROJECTS_SHAPE, args)
  if (unknown) return unknown
  const lines = svc.projects.list().map(p => pipeJoin(p.slug, sanitizePipe(p.folder_path), p.open))
  return textResult(lines.join('\n'))
}

export function handleUpdateProject(svc: TaskService, args: {
  project: string; slug?: string; folder_path?: string; archived?: boolean
}): ToolResult {
  const unknown = rejectUnknownArgs('update_project', UPDATE_PROJECT_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.projects.update(args))
}

export function handleDeleteProject(svc: TaskService, args: { project: string }): ToolResult {
  const unknown = rejectUnknownArgs('delete_project', DELETE_PROJECT_SHAPE, args)
  if (unknown) return unknown
  return toToolResult(svc.projects.delete(args.project))
}

export function registerProjectTools(server: McpServer, svc: TaskService) {
  server.registerTool('create_project', {
    description: 'Create a project; slug? derives from the folder name and must match ^[a-z0-9][a-z0-9._-]{0,31}$ ("legacy" is reserved). Output {slug}',
    inputSchema: z.object(CREATE_PROJECT_SHAPE).catchall(z.unknown())
  }, async (args) => handleCreateProject(svc, args))

  server.registerTool('list_projects', {
    description: 'Pipe lines slug|folder|open (open = non-terminal tasks), ordered by slug; archived projects are listed identically (no archived column)',
    inputSchema: z.object(LIST_PROJECTS_SHAPE).catchall(z.unknown())
  }, async (args) => handleListProjects(svc, args))

  server.registerTool('update_project', {
    description: 'Update a project by slug (slug?, folder_path?, archived?). archived:false is idempotent; INVALID: nothing to update only when no optional argument is given. Output {slug}',
    inputSchema: z.object(UPDATE_PROJECT_SHAPE).catchall(z.unknown())
  }, async (args) => handleUpdateProject(svc, args))

  server.registerTool('delete_project', {
    description: 'Delete a project that has no tasks; a project with tasks refuses with CONFLICT (archive it instead). Output {deleted:<slug>}',
    inputSchema: z.object(DELETE_PROJECT_SHAPE).catchall(z.unknown())
  }, async (args) => handleDeleteProject(svc, args))
}