import type { ProjectRow, ProjectListItem, ProjectStore, SvcResult } from './types'
import { resolveProject, createProject, updateProject, deleteProject } from './projects'

export class ProjectService {
  constructor(private readonly store: ProjectStore, private readonly scope?: string) {}

  resolve(project?: string): SvcResult<ProjectRow> {
    return resolveProject(this.store, project ?? this.scope)
  }

  create(args: { slug?: string; folder_path?: string }): SvcResult<{ slug: string }> {
    return createProject(this.store, args)
  }

  list(): ReadonlyArray<ProjectListItem> {
    return this.store.listProjects()
  }

  update(args: { project: string; folder_path?: string; archived?: boolean }): SvcResult<{ slug: string }> {
    return updateProject(this.store, args)
  }

  delete(project: string): SvcResult<{ deleted: string }> {
    return deleteProject(this.store, project)
  }
}
