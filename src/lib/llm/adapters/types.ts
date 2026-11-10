import type { Prompt, Usage } from '../port';

/**
 * Internal contract between the fallback chain and one provider adapter. It is
 * deliberately narrower than `LlmPort`: adapters speak one provider protocol and
 * return text, while the chain owns retries, cooldowns and JSON validation.
 */
export type AdapterRequest = {
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
  prompt: Prompt;
  /**
   * Extra headers configured on the provider (e.g. OpenCode's
   * `x-opencode-session`). Adapters spread these first, so protocol headers
   * still win: a stored header must not be able to fake auth or content type.
   */
  headers?: Record<string, string> | undefined;
  /**
   * True for `LlmPort.structured` calls. Providers without native schema support
   * key their "answer with JSON only" instruction off this flag, not off
   * `jsonSchema`, so a schema with no JSON Schema form still means "structured".
   */
  structured: boolean;
  /** Present only for `structured` calls: native JSON schema, when supported. */
  jsonSchema?: Record<string, unknown> | undefined;
  /** Overrides `DEFAULT_TIMEOUT_MS`; the chain leaves it unset. */
  timeoutMs?: number | undefined;
  /** Caller cancellation (a scan budget); aborts the in-flight request. */
  signal?: AbortSignal | undefined;
};

export type AdapterFailureReason =
  /** The provider answered with a non-2xx status. */
  | 'http'
  /** `AbortSignal.timeout` fired. */
  | 'timeout'
  /** `fetch` rejected before a response (DNS, TLS, connection reset, …). */
  | 'network'
  /** A 2xx response body was not JSON. */
  | 'malformed'
  /** A 2xx response carried no usable text. */
  | 'empty';

export type AdapterFailure = {
  ok: false;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  reason: AdapterFailureReason;
  /** Short token safe to embed in an aggregated error message. */
  code: string;
  /** Truncated upstream `error.message`; never the prompt or an API key. */
  detail?: string;
};

export type AdapterResult = { ok: true; text: string; usage: Usage } | AdapterFailure;

export type Adapter = (request: AdapterRequest) => Promise<AdapterResult>;

/**
 * Appended for providers without native JSON schema support. The chain still
 * validates with zod; this only raises the odds that the first answer parses.
 */
export const JSON_ONLY_INSTRUCTION =
  '只输出符合要求的 JSON，不要 markdown 代码块，不要任何解释文字。';

/** The system prompt for one request, with the JSON rule added when structured. */
export function systemPromptFor(request: AdapterRequest): string {
  if (!request.structured) return request.prompt.system;
  return request.prompt.system === ''
    ? JSON_ONLY_INSTRUCTION
    : `${request.prompt.system}\n\n${JSON_ONLY_INSTRUCTION}`;
}
