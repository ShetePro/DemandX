import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { complete } from './google';
import { JSON_ONLY_INSTRUCTION, type AdapterRequest } from './types';

const SCHEMA = { type: 'object', properties: { score: { type: 'number' } } };

const REQUEST: AdapterRequest = {
  baseUrl: 'https://generativelanguage.googleapis.com/',
  apiKey: 'sk-google-test',
  modelId: 'gemini-test',
  prompt: { system: 'system text', user: 'user text' },
  structured: false,
};

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('google adapter', () => {
  it('posts generateContent with the key in the query and maps usageMetadata', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'gem ' }, { text: 'answer' }] } },
          ],
          usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
        }),
      ),
    );

    const result = await complete(REQUEST);

    expect(result).toEqual({ ok: true, text: 'gem answer', usage: { in: 6, out: 3 } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=sk-google-test',
    );

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'user text' }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'system text' }] });
    expect((body.generationConfig as Record<string, unknown>).temperature).toBe(0);
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBeUndefined();
  });

  it('asks for JSON output and adds the instruction for structured calls', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"score":4}' }] } }] }),
      ),
    );

    await complete({ ...REQUEST, structured: true, jsonSchema: SCHEMA });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBe(
      'application/json',
    );
    const instruction = body.systemInstruction as { parts: { text: string }[] };
    expect(instruction.parts[0]?.text).toContain(JSON_ONLY_INSTRUCTION);
  });

  it('omits the key from the URL when the provider has none', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })),
    );

    await complete({ ...REQUEST, apiKey: null });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
  });

  it('sends provider-configured headers alongside the query-string key', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })),
    );

    await complete({ ...REQUEST, headers: { 'x-opencode-session': 'session-1' } });

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBe('session-1');
    expect(headers['content-type']).toBe('application/json');
  });

  it('classifies a provider error without echoing the request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"quota"}}', { status: 429 }));

    const result = await complete(REQUEST);

    expect(result).toMatchObject({ ok: false, status: 429, reason: 'http', code: '429' });
    expect(JSON.stringify(result)).not.toContain('sk-google-test');
  });
});
