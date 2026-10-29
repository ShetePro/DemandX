import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';

import { createLlmPort } from './chain';
import type { ChainItem, Prompt } from './port';

const PROMPT: Prompt = { system: '你是调查助手。', user: '给出一个结论。' };
const RESULT_SCHEMA = z.object({ score: z.number() });

const A: ChainItem = {
  providerId: 1,
  providerName: 'A',
  kind: 'openai-compatible',
  baseUrl: 'https://a.example/v1',
  modelId: 'a-model',
};

const B: ChainItem = {
  providerId: 2,
  providerName: 'B',
  kind: 'openai-compatible',
  baseUrl: 'https://b.example/v1',
  modelId: 'b-model',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An OpenAI-shaped answer, the protocol both test providers speak. */
function answer(content: string, promptTokens = 3, completionTokens = 5): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  });
}

let fetchMock: Mock;
let clock: number;

beforeEach(() => {
  clock = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makePort(chain: ChainItem[], keys: Record<number, string | null> = {}) {
  return createLlmPort({
    loadChain: async () => ({ ok: true, value: chain }),
    resolveApiKey: async (providerId: number) => ({ ok: true, value: keys[providerId] ?? null }),
    now: () => clock,
  });
}

describe('createLlmPort · text', () => {
  it('falls back to the next provider when the first answers 429', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(answer('hello'));

    const result = await makePort([A, B]).text(PROMPT, { profile: 'bulk' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.used.providerName).toBe('B');
    expect(result.value.text).toBe('hello');
    expect(result.value.usage).toEqual({ in: 3, out: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://a.example/v1/chat/completions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://b.example/v1/chat/completions');
  });

  it('skips a provider that is still cooling down', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(answer('first'));

    const port = makePort([A, B]);
    await port.text(PROMPT, { profile: 'bulk' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(answer('second'));
    const second = await port.text(PROMPT, { profile: 'bulk' });

    expect(second.ok && second.value.used.providerName).toBe('B');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The cooling provider was skipped without a request.
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://b.example/v1/chat/completions');
  });

  it('serves a cooled provider again once the window elapses', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(answer('from b'));

    const port = makePort([A, B]);
    await port.text(PROMPT, { profile: 'bulk' });

    clock += 5 * 60_000;
    fetchMock.mockResolvedValueOnce(answer('from a'));
    const later = await port.text(PROMPT, { profile: 'bulk' });

    expect(later.ok && later.value.used.providerName).toBe('A');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not cool a provider that rejected the request as invalid', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(answer('from b'));

    const port = makePort([A, B]);
    await port.text(PROMPT, { profile: 'bulk' });

    fetchMock.mockResolvedValueOnce(answer('from a, fixed input'));
    const second = await port.text(PROMPT, { profile: 'bulk' });

    expect(second.ok && second.value.used.providerName).toBe('A');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports every item as provider#model without leaking keys or bodies', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"bad key"}', { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));

    const result = await makePort([A, B], { 1: 'sk-secret-one', 2: 'sk-secret-two' }).text(PROMPT, {
      profile: 'bulk',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LLM_UNAVAILABLE');
    expect(result.message).toContain('A#a-model: 401');
    expect(result.message).toContain('B#b-model: 400');
    expect(result.message).not.toContain('sk-secret');
    expect(result.message).not.toContain('bad key');
  });

  it('returns LLM_UNAVAILABLE without a request when every provider is cooling', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    const port = makePort([A, B]);
    await port.text(PROMPT, { profile: 'bulk' });
    const again = await port.text(PROMPT, { profile: 'bulk' });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('LLM_UNAVAILABLE');
    expect(again.message).toContain('A#a-model: cooldown');
    expect(again.message).toContain('B#b-model: cooldown');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades past empty content without cooling the provider', async () => {
    fetchMock.mockResolvedValueOnce(answer('')).mockResolvedValueOnce(answer('from b'));

    const port = makePort([A, B]);
    const first = await port.text(PROMPT, { profile: 'bulk' });
    expect(first.ok && first.value.used.providerName).toBe('B');

    fetchMock.mockResolvedValueOnce(answer('')).mockResolvedValueOnce(answer('again from b'));
    await port.text(PROMPT, { profile: 'bulk' });

    // A is asked again on the second call: an empty answer is output quality,
    // not provider health.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://a.example/v1/chat/completions');
  });

  it('returns LLM_UNAVAILABLE for an empty chain without calling fetch', async () => {
    const result = await makePort([]).text(PROMPT, { profile: 'quality' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LLM_UNAVAILABLE');
    expect(result.message).toContain('链为空');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('treats an aborted request as retryable and cools the provider', async () => {
    fetchMock
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
      .mockResolvedValueOnce(answer('from b'));

    const port = makePort([A, B]);
    const first = await port.text(PROMPT, { profile: 'bulk' });
    expect(first.ok && first.value.used.providerName).toBe('B');

    fetchMock.mockResolvedValueOnce(answer('again'));
    await port.text(PROMPT, { profile: 'bulk' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://b.example/v1/chat/completions');
  });
});

describe('createLlmPort · structured', () => {
  it('sends the JSON Schema without the draft $schema pointer', async () => {
    fetchMock.mockResolvedValueOnce(answer('{"score":1}'));

    await makePort([A]).structured(RESULT_SCHEMA, PROMPT, { profile: 'bulk' });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      response_format?: { json_schema?: { schema?: Record<string, unknown> } };
    };
    const schema = body.response_format?.json_schema?.schema;
    expect(schema).toBeDefined();
    expect(schema).not.toHaveProperty('$schema');
    expect(schema?.properties).toEqual({ score: { type: 'number' } });
    expect(schema?.required).toEqual(['score']);
  });

  it('refuses a schema with no JSON Schema form without calling any provider', async () => {
    const result = await makePort([A, B]).structured(z.object({ when: z.date() }), PROMPT, {
      profile: 'bulk',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LLM_BAD_OUTPUT');
    expect(result.message).toContain('schema_unsupported');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('retries the same provider once when its answer is not JSON', async () => {
    fetchMock
      .mockResolvedValueOnce(answer('not json'))
      .mockResolvedValueOnce(answer('{"score":7}'));

    const result = await makePort([A, B]).structured(RESULT_SCHEMA, PROMPT, { profile: 'quality' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toEqual({ score: 7 });
    expect(result.value.used.providerName).toBe('A');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('moves on after two bad answers, so one item costs at most two calls', async () => {
    fetchMock
      .mockResolvedValueOnce(answer('nope'))
      .mockResolvedValueOnce(answer('{"score":"high"}'))
      .mockResolvedValueOnce(answer('{"score":9}'));

    const result = await makePort([A, B]).structured(RESULT_SCHEMA, PROMPT, { profile: 'quality' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toEqual({ score: 9 });
    expect(result.value.used.providerName).toBe('B');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns LLM_BAD_OUTPUT when every provider keeps answering invalid JSON', async () => {
    fetchMock
      .mockResolvedValueOnce(answer('nope'))
      .mockResolvedValueOnce(answer('nope'))
      .mockResolvedValueOnce(answer('{"score":"no"}'))
      .mockResolvedValueOnce(answer('{"score":"no"}'));

    const result = await makePort([A, B]).structured(RESULT_SCHEMA, PROMPT, { profile: 'quality' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LLM_BAD_OUTPUT');
    expect(result.message).toContain('A#a-model: bad_output');
    expect(result.message).toContain('B#b-model: bad_output');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns LLM_UNAVAILABLE when a transport failure is involved', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(answer('{"score":"no"}'))
      .mockResolvedValueOnce(answer('{"score":"no"}'));

    const result = await makePort([A, B]).structured(RESULT_SCHEMA, PROMPT, { profile: 'quality' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LLM_UNAVAILABLE');
    expect(result.message).toContain('A#a-model: 503');
    expect(result.message).toContain('B#b-model: bad_output');
  });
});
