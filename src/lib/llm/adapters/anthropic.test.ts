import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { complete } from './anthropic';
import { JSON_ONLY_INSTRUCTION, type AdapterRequest } from './types';

const SCHEMA = { type: 'object', properties: { score: { type: 'number' } } };

const REQUEST: AdapterRequest = {
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  modelId: 'claude-test',
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

describe('anthropic adapter', () => {
  it('posts a messages request with the version and api key headers', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: 'part one ' },
            { type: 'text', text: 'part two' },
          ],
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
      ),
    );

    const result = await complete(REQUEST);

    expect(result).toEqual({ ok: true, text: 'part one part two', usage: { in: 9, out: 4 } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe('sk-ant-test');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-test');
    expect(body.temperature).toBe(0);
    expect(body.system).toBe('system text');
    expect(body.messages).toEqual([{ role: 'user', content: 'user text' }]);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('appends a JSON-only instruction for structured calls instead of a schema', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '{"score":3}' }] })),
    );

    await complete({ ...REQUEST, jsonSchema: SCHEMA });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(String(body.system)).toContain('system text');
    expect(String(body.system)).toContain(JSON_ONLY_INSTRUCTION);
    expect(body.response_format).toBeUndefined();
  });

  it('does not append the instruction to a plain text call', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'plain' }] })),
    );

    await complete(REQUEST);

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body.system).toBe('system text');
  });

  it('rejects an empty content array as a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ content: [] })));

    const result = await complete(REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'empty', code: 'empty' });
  });
});
