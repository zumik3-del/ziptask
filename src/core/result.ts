import type { ErrorCode, SvcError, SvcResult } from './types'

export function ok<T>(data: T): SvcResult<T> {
  return { ok: true, data }
}

export function fail<T = never>(error: SvcError): SvcResult<T>
export function fail<T = never>(code: ErrorCode, message?: string): SvcResult<T>
export function fail<T = never>(codeOrError: ErrorCode | SvcError, message = ''): SvcResult<T> {
  return {
    ok: false,
    error: typeof codeOrError === 'string' ? { code: codeOrError, message } : codeOrError
  }
}

export function foldResult<A, B>(
  result: SvcResult<A>,
  onOk: (data: A) => B,
  onErr: (error: SvcError) => B
): B {
  return result.ok ? onOk(result.data) : onErr(result.error)
}

export function formatError(error: SvcError): string {
  return error.message ? `${error.code}: ${error.message}` : `${error.code}:`
}
