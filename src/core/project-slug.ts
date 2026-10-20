// The project slug constants, in one leaf module: the projects domain and the task guards both
// need them, and neither of the two may depend on the other.
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/
export const PROJECT_SLUG_MAX = 32
export const RESERVED_PROJECT_SLUG = 'legacy'
