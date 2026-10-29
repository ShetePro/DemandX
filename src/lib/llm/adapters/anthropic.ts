import { asArray, asCount, asRecord, failed, joinText, postJson, trimBase } from './http';
import { systemPromptFor, type Adapter, type AdapterRequest, type AdapterResult } from './types';

const API_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

/** Anthropic puts the system prompt at the top level, not in `messages`. */
function endpoint(baseUrl: string): string {
  const base = trimBase(baseUrl);
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

export async function complete(request: AdapterRequest): Promise<AdapterResult> {
  const headers: Record<string, string> = { 'anthropic-version': API_VERSION };
  if (request.apiKey) headers['x-api-key'] = request.apiKey;

  const body = {
    model: request.modelId,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: systemPromptFor(request),
    messages: [{ role: 'user', content: request.prompt.user }],
  };

  const outcome = await postJson(endpoint(request.baseUrl), headers, body, request.timeoutMs);
  if (!outcome.ok) return outcome;

  const root = asRecord(outcome.body);
  const text = joinText(asArray(root?.content));
  if (text.trim() === '') return failed('empty');

  const usage = asRecord(root?.usage);
  return {
    ok: true,
    text,
    usage: { in: asCount(usage?.input_tokens), out: asCount(usage?.output_tokens) },
  };
}

export const adapter: Adapter = complete;
