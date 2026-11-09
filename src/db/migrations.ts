export const MIGRATIONS = [
  // 001: core tables
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    priority TEXT DEFAULT 'p2',
    assignee TEXT,
    reporter TEXT NOT NULL,
    depends_on TEXT DEFAULT '[]',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    lease_expires_at TEXT,
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status ON tasks(assignee, status)`,

  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'comment',
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`,

  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  )`,

  // 002
  `ALTER TABLE tasks ADD COLUMN is_epic INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tasks ADD COLUMN epic_id INTEGER REFERENCES tasks(id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)`,

  // 003
  `CREATE INDEX IF NOT EXISTS idx_audit_log_task_id ON audit_log(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_completed ON tasks(status, completed_at)`,

  // 004
  `CREATE TABLE comments_new (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'comment',
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`,
  `INSERT INTO comments_new SELECT id, task_id, agent, content, type, created_at FROM comments`,
  `DROP TABLE comments`,
  `ALTER TABLE comments_new RENAME TO comments`,
  `CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id)`,

  `CREATE TABLE audit_log_new (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`,
  `INSERT INTO audit_log_new SELECT id, task_id, agent, action, old_value, new_value, created_at FROM audit_log`,
  `DROP TABLE audit_log`,
  `ALTER TABLE audit_log_new RENAME TO audit_log`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_task_id ON audit_log(task_id)`,

  // 005
  `CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    folder_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  )`,

  `ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id)`,

  `CREATE INDEX IF NOT EXISTS idx_tasks_project_status_priority ON tasks(project_id, status, priority)`,

  `INSERT INTO projects (slug, folder_path, created_at, updated_at)
   SELECT 'legacy', '', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE EXISTS (SELECT 1 FROM tasks)`,

  `UPDATE tasks SET project_id = (SELECT id FROM projects WHERE slug = 'legacy')
   WHERE project_id IS NULL`,

  // 006
  `CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires_at ON tasks(lease_expires_at) WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_queued_candidates ON tasks(project_id, priority, created_at, id) WHERE status = 'queued' AND is_epic = 0`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_created_at_id ON tasks(created_at DESC, id DESC)`,

  // 007
  `UPDATE tasks SET status = 'open', lease_expires_at = NULL, assignee = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE is_epic = 1 AND status IN ('queued', 'in_progress', 'review', 'blocked')`,
  `UPDATE tasks SET lease_expires_at = NULL, assignee = NULL WHERE is_epic = 1 AND (lease_expires_at IS NOT NULL OR assignee IS NOT NULL)`
]
