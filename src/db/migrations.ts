export const MIGRATIONS = [
  // 001: core tables (schema v2: no task_path/result_path/parent_id; comments.type)
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

  // 002: epic → sub-task mechanism (schema v3; additive over live DB)
  `ALTER TABLE tasks ADD COLUMN is_epic INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tasks ADD COLUMN epic_id INTEGER REFERENCES tasks(id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)`
]
