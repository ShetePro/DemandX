import { createHash } from 'node:crypto';

/** OpenCode data plane; the host alone decides whether the session header applies. */
const OPENCODE_HOST = 'opencode.ai';

const SESSION_HEADER = 'x-opencode-session';

/** True for any endpoint on `opencode.ai` (subscription or metered). */
export function isOpencodeBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

/**
 * OpenCode's `*-free` models are restricted to its own client: another client
 * carrying a valid key still gets 403. Only the host decides; the suffix alone
 * on another vendor's endpoint means nothing.
 */
export function isOpencodeFreeModel(baseUrl: string, modelId: string): boolean {
  return isOpencodeBaseUrl(baseUrl) && modelId.trim().toLowerCase().endsWith('-free');
}

/**
 * Headers for one provider call. OpenCode requires a stable per-conversation
 * `x-opencode-session`; without it the data plane answers 403 even with a valid
 * key. The value is derived from the endpoint (and provider name, when known),
 * never from the key, so it survives restarts without persisting a secret.
 *
 * Returns a new object: the stored provider headers are never mutated. An
 * explicitly configured header — in any casing — always wins.
 */
export function withProviderHeaders(
  baseUrl: string,
  headers: Record<string, string> = {},
  providerName = '',
): Record<string, string> {
  const next = { ...headers };
  if (!isOpencodeBaseUrl(baseUrl)) return next;

  const configured = Object.keys(next).some((name) => name.toLowerCase() === SESSION_HEADER);
  if (configured) return next;

  const digest = createHash('sha1').update(`${baseUrl}${providerName}`).digest('hex').slice(0, 12);
  next[SESSION_HEADER] = `demandx-${digest}`;
  return next;
}
