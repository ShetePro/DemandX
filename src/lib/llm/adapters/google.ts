import { asArray, asCount, asRecord, failed, joinText, postJson, trimBase } from './http';
import { systemPromptFor, type Adapter, type AdapterRequest, type AdapterResult } from './types';

/** Gemini keys travel in the query string; every other provider uses headers. */
function endpoint(baseUrl: string, modelId: string, apiKey: string | null): string {
  const base = `${trimBase(baseUrl)}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
  return apiKey ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
}

export async function complete(request: AdapterRequest): Promise<AdapterResult> {
  const generationConfig: Record<string, unknown> = { temperature: 0 };
  if (request.structured) generationConfig.responseMimeType = 'application/json';

  const body = {
    contents: [{ role: 'user', parts: [{ text: request.prompt.user }] }],
    systemInstruction: { parts: [{ text: systemPromptFor(request) }] },
    generationConfig,
  };

  const outcome = await postJson(
    endpoint(request.baseUrl, request.modelId, request.apiKey),
    { ...request.headers },
    body,
    request.timeoutMs,
    request.signal,
  );
  if (!outcome.ok) return outcome;

  const root = asRecord(outcome.body);
  const candidate = asRecord(asArray(root?.candidates)[0]);
  const text = joinText(asArray(asRecord(candidate?.content)?.parts));
  if (text.trim() === '') return failed('empty');

  const usage = asRecord(root?.usageMetadata);
  return {
    ok: true,
    text,
    usage: {
      in: asCount(usage?.promptTokenCount),
      out: asCount(usage?.candidatesTokenCount),
    },
  };
}

export const adapter: Adapter = complete;
