import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { complete } from './ollama';
import type { AdapterRequest } from './types';

const SCHEMA = {
  type: 'object',
  properties: { score: { type: 'number' } },
  required: ['score'],
  additionalProperties: false,
};

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ollama adapter', () => {
  it('drops a pasted /v1 suffix and uses the native /api/chat endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'local answer' },
          prompt_eval_count: 8,
          eval_count: 5,
        }),
      ),
    );

    const request: AdapterRequest = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: null,
      modelId: 'qwen-test',
      prompt: { system: 'sys', user: 'usr' },
    };

    const result = await complete(request);

    expect(result).toEqual({ ok: true, text: 'local answer', usage: { in: 8, out: 5 } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends format + stream:false for a structured call', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: { content: '{"score":2}' } })),
    );

    await complete({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: null,
      modelId: 'qwen-test',
      prompt: { system: 'sys', user: 'usr' },
      jsonSchema: SCHEMA,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(SCHEMA);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('reports an empty message as a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: '' } })));

    const result = await complete({
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: null,
      modelId: 'qwen-test',
      prompt: { system: 'sys', user: 'usr' },
    });

    expect(result).toMatchObject({ ok: false, reason: 'empty', code: 'empty' });
  });
});
