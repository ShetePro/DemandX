import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { complete } from './openai-compatible';
import type { AdapterRequest } from './types';

const SCHEMA = {
  type: 'object',
  properties: { score: { type: 'number' } },
  required: ['score'],
  additionalProperties: false,
};

const REQUEST: AdapterRequest = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-test-key',
  modelId: 'gpt-test',
  prompt: { system: 'system text', user: 'user text' },
};

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai-compatible adapter', () => {
  it('sends a deterministic chat completion and maps usage', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'answer' } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        }),
      ),
    );

    const result = await complete(REQUEST);

    expect(result).toEqual({ ok: true, text: 'answer', usage: { in: 12, out: 34 } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-test');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'user text' },
    ]);
    expect(body.response_format).toBeUndefined();
  });

  it('asks for a strict json_schema when a schema is supplied', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"score":1}' } }] })),
    );

    await complete({ ...REQUEST, jsonSchema: SCHEMA });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', schema: SCHEMA, strict: true },
    });
    expect(body.temperature).toBe(0);
  });

  it('classifies an error status without reading the provider body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"prompt echoed"}', { status: 401 }));

    const result = await complete(REQUEST);

    expect(result).toMatchObject({ ok: false, status: 401, reason: 'http', code: '401' });
  });
});
