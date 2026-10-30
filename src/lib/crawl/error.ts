/**
 * `fetch` aborts with `AbortError`, Node's own timeout signal uses
 * `TimeoutError`, and Playwright throws its own `TimeoutError`. All three mean
 * the same thing to a caller: the deadline expired.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
