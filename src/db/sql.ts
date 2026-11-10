import { TERMINAL_STATUSES, EDITABLE_STATUSES, CLAIMABLE_STATUSES } from '../core/tasks'

export const PRIORITY_ORDER_SQL = `priority`

export const TERMINAL_STATUSES_SQL = `(${TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')})`

export const EDITABLE_STATUSES_SQL = `(${EDITABLE_STATUSES.map((status) => `'${status}'`).join(', ')})`

export const CLAIMABLE_STATUSES_SQL = `(${CLAIMABLE_STATUSES.map((status) => `'${status}'`).join(', ')})`

export const TASK_SELECT = `SELECT t.*, p.slug AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`
