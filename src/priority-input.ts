import { z } from 'zod/v4'
import { isTaskPriorityInput, PRIORITY_INVALID_MESSAGE } from './core/tasks'

export const PRIORITY_INPUT = z
  .unknown()
  .refine((value) => value === undefined || isTaskPriorityInput(value), {
    message: `INVALID: ${PRIORITY_INVALID_MESSAGE}`
  })
