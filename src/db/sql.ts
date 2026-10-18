import { TERMINAL_STATUSES } from '../core/tasks'

// Every SQL text fragment the repo composes statements from lives here, so a domain rule quoted
// in SQL (priority order, terminal statuses) is written once and read from the db layer.
// p0..p3 sort lexicographically, so the priority column alone is the ordering.
export const PRIORITY_ORDER_SQL = `priority`

export const TERMINAL_STATUSES_SQL = `(${TERMINAL_STATUSES.map(status => `'${status}'`).join(', ')})`

// The LEFT JOIN carries the slug; project_id stays internal and is dropped by toTask.
export const TASK_SELECT = `SELECT t.*, p.slug AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`
