import { TASK_PRIORITIES } from '../defaults'
import { TERMINAL_STATUSES } from '../core/tasks'

// Every SQL text fragment the repo composes statements from lives here, so a domain rule quoted
// in SQL (priority order, terminal statuses) is written once and read from the db layer.
export const PRIORITY_ORDER_SQL = `CASE priority ${TASK_PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(' ')} END`

export const TERMINAL_STATUSES_SQL = `(${TERMINAL_STATUSES.map(status => `'${status}'`).join(', ')})`

// The LEFT JOIN carries the slug; project_id stays internal and is dropped by toTask.
export const TASK_SELECT = `SELECT t.*, p.slug AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`
