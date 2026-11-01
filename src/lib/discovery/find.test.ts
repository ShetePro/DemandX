import { describe, expect, it, vi } from 'vitest';

import type { LlmPort } from '@/lib/llm/port';
import type { SearchHit, SearchPort } from '@/lib/search/port';

import { DISCOVERY_LLM_TIMEOUT_MS, findOpportunities, MAX_SOURCES } from './find';

function hit(n: number): SearchHit {
  return {
    url: `https://example.com/post-${n}`,
    title: `帖子 ${n}`,
    snippet: '每天手工同步库存，太麻烦了，有没有推荐的工具？',
    platform: 'web',
  };
}

function port(id: string, hits: SearchHit[]): SearchPort {
  return {
    id,
    platform: 'web',
    async search() {
      return hits;
    },
  };
}

function brokenPort(id: string): SearchPort {
  return {
    id,
    platform: 'web',
    async search() {
      throw new Error('HTTP 429');
    },
  };
}

function llmReturning(data: unknown): LlmPort {
  return {
    async structured() {
      return {
        ok: true,
        value: {
          data,
          used: {
            providerId: 1,
            providerName: 'stub',
            kind: 'openai-compatible',
            baseUrl: 'http://stub',
            modelId: 'stub',
            headers: {},
          },
          usage: { in: 1, out: 1 },
        },
      } as never;
    },
    async text() {
      throw new Error('unused');
    },
  };
}

const OPPORTUNITY = {
  title: '跨境库存同步',
  problem: '卖家在三个平台之间手工同步库存，经常超卖',
  audience: '跨境小卖家',
  signal: 'problem' as const,
  evidence: [{ url: 'https://example.com/post-1', quote: '每天手工同步太麻烦' }],
};

describe('findOpportunities', () => {
  it('collects snippets from every port, then asks the model once', async () => {
    const structured = vi.fn(llmReturning({ opportunities: [OPPORTUNITY] }).structured);
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2)]), port('bing', [hit(3)])],
      llm: { structured, text: vi.fn() } as unknown as LlmPort,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(3);
    expect(result.value.providers).toEqual(['ddg', 'bing']);
    expect(result.value.opportunities).toEqual([OPPORTUNITY]);

    const prompt = structured.mock.calls[0]?.[1] as { user: string };
    expect(prompt.user).toContain('https://example.com/post-1');
  });

  it('dedupes URLs across ports and stops at the source cap', async () => {
    const many = Array.from({ length: 30 }, (_, index) => hit(index));
    const result = await findOpportunities({
      searchPorts: [port('a', many), port('b', many)],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sources.length).toBeLessThanOrEqual(MAX_SOURCES);
  });

  it('survives a blocked engine as long as another port answers', async () => {
    const result = await findOpportunities({
      searchPorts: [brokenPort('ddg'), port('bing', [hit(1)])],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.providers).toEqual(['bing']);
  });

  it('fails with NO_SOURCES when nothing answers', async () => {
    const result = await findOpportunities({
      searchPorts: [brokenPort('ddg'), port('bing', [])],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
    });

    expect(result).toEqual({
      ok: false,
      code: 'NO_SOURCES',
      message: expect.stringContaining('没有返回结果'),
    });
  });

  it('drops candidates whose evidence is not one of the supplied URLs', async () => {
    const invented = {
      ...OPPORTUNITY,
      evidence: [{ url: 'https://invented.example.com/x', quote: '编造的引文' }],
    };
    const mixed = await findOpportunities({
      searchPorts: [port('ddg', [hit(1)])],
      llm: llmReturning({ opportunities: [invented, OPPORTUNITY] }),
    });

    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(mixed.value.opportunities).toEqual([OPPORTUNITY]);

    const onlyInvented = await findOpportunities({
      searchPorts: [port('ddg', [hit(1)])],
      llm: llmReturning({ opportunities: [invented] }),
    });
    expect(onlyInvented.ok).toBe(false);
    if (!onlyInvented.ok) expect(onlyInvented.code).toBe('INVALID_OUTPUT');
  });

  it('reports the model failure as LLM_UNAVAILABLE', async () => {
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1)])],
      llm: {
        async structured() {
          return { ok: false, code: 'NO_PROVIDER', message: '没有可用模型' } as never;
        },
        async text() {
          throw new Error('unused');
        },
      } as unknown as LlmPort,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('LLM_UNAVAILABLE');
      expect(result.message).toContain('没有可用模型');
    }
  });

  it('gives up when the model never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = findOpportunities({
        searchPorts: [port('ddg', [hit(1)])],
        llm: {
          structured: () => new Promise(() => undefined),
          text: () => new Promise(() => undefined),
        } as unknown as LlmPort,
      });

      await vi.advanceTimersByTimeAsync(DISCOVERY_LLM_TIMEOUT_MS);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('LLM_UNAVAILABLE');
        expect(result.message).toContain('超时');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one citation per URL inside an opportunity', async () => {
    const duplicated = {
      ...OPPORTUNITY,
      evidence: [
        { url: 'https://example.com/post-1', quote: '第一段' },
        { url: 'https://example.com/post-1', quote: '同一链接的第二段' },
      ],
    };
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1)])],
      llm: llmReturning({ opportunities: [duplicated] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.opportunities[0]?.evidence).toHaveLength(1);
  });
});
