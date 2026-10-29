import { asArray, asCount, asRecord, asString, failed, postJson, trimBase } from './http';
import type { Adapter, AdapterRequest, AdapterResult } from './types';

/**
 * OpenAI's `/chat/completions` contract, which most self-hosted gateways
 * (vLLM, LM Studio, OpenRouter, DeepSeek, …) also speak.
 */
export async function complete(request: AdapterRequest): Promise<AdapterResult> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: [
      { role: 'system', content: request.prompt.system },
      { role: 'user', content: request.prompt.user },
    ],
    temperature: 0,
  };

  if (request.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'result', schema: request.jsonSchema, strict: true },
    };
  }

  const headers: Record<string, string> = { ...request.headers };
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;

  const outcome = await postJson(
    `${trimBase(request.baseUrl)}/chat/completions`,
    headers,
    body,
    request.timeoutMs,
  );
  if (!outcome.ok) return outcome;

  const root = asRecord(outcome.body);
  const message = asRecord(asRecord(asArray(root?.choices)[0])?.message);
  const text = asString(message?.content);
  if (text === undefined || text.trim() === '') return failed('empty');

  const usage = asRecord(root?.usage);
  return {
    ok: true,
    text,
    usage: { in: asCount(usage?.prompt_tokens), out: asCount(usage?.completion_tokens) },
  };
}

export const adapter: Adapter = complete;
