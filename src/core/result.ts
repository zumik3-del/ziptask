import type { ErrorCode, SvcError, SvcResult } from './types'

export function ok<T>(data: T): SvcResult<T> {
  return { ok: true, data }
}

export function fail<T = never>(error: SvcError): SvcResult<T>
export function fail<T = never>(code: ErrorCode, message?: string): SvcResult<T>
export function fail<T = never>(codeOrError: ErrorCode | SvcError, message = ''): SvcResult<T> {
  return { ok: false, error: typeof codeOrError === 'string' ? { code: codeOrError, message } : codeOrError }
}

export function mapResult<A, B>(result: SvcResult<A>, f: (data: A) => B): SvcResult<B> {
  return result.ok ? ok(f(result.data)) : result
}

export function flatMapResult<A, B>(result: SvcResult<A>, f: (data: A) => SvcResult<B>): SvcResult<B> {
  return result.ok ? f(result.data) : result
}

export function foldResult<A, B>(result: SvcResult<A>, onOk: (data: A) => B, onErr: (error: SvcError) => B): B {
  return result.ok ? onOk(result.data) : onErr(result.error)
}

// The wire contract is the plain string form: `CODE: message`, or `CODE:` when the code carries
// no message (NOT_FOUND). Keeping it here means the typed error never leaks into MCP responses.
export function formatError(error: SvcError): string {
  return error.message ? `${error.code}: ${error.message}` : `${error.code}:`
}
