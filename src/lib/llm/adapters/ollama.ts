import { asCount, asRecord, asString, failed, postJson, trimBase } from './http';
import type { Adapter, AdapterRequest, AdapterResult } from './types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/**
 * Ollama exposes its native API at the root (`/api/chat`); an operator who
 * pasted the OpenAI-compatible `…:11434/v1` URL means the same daemon.
 */
function endpoint(baseUrl: string): string {
  const trimmed = trimBase(baseUrl);
  const base = trimmed === '' ? DEFAULT_BASE_URL : trimmed;
  return `${base.endsWith('/v1') ? base.slice(0, -'/v1'.length).replace(/\/+$/, '') : base}/api/chat`;
}

export async function complete(request: AdapterRequest): Promise<AdapterResult> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: [
      { role: 'system', content: request.prompt.system },
      { role: 'user', content: request.prompt.user },
    ],
    stream: false,
    options: { temperature: 0 },
  };

  // Ollama takes the JSON Schema itself in `format`, not a wrapper object.
  if (request.jsonSchema) body.format = request.jsonSchema;

  const outcome = await postJson(
    endpoint(request.baseUrl),
    { ...request.headers },
    body,
    request.timeoutMs,
    request.signal,
  );
  if (!outcome.ok) return outcome;

  const root = asRecord(outcome.body);
  const text = asString(asRecord(root?.message)?.content);
  if (text === undefined || text.trim() === '') return failed('empty');

  return {
    ok: true,
    text,
    usage: { in: asCount(root?.prompt_eval_count), out: asCount(root?.eval_count) },
  };
}

export const adapter: Adapter = complete;
