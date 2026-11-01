import { describe, expect, it, vi } from 'vitest';

import type { LlmPort } from '@/lib/llm/port';
import type { SearchHit, SearchPort } from '@/lib/search/port';

import { DISCOVERY_LLM_TIMEOUT_MS, findOpportunities, MAX_SOURCES } from './find';

function hit(n: number): SearchHit {
  return {
    url: `https://example.com/post-${n}`,
    title: `帖子 ${n}`,
    snippet: `案例 ${n}：卖家 ${'甲乙丙丁戊己庚辛'[n % 8]} 每天手工同步库存太麻烦，愿意付费买工具，预算 ${n}00 元。`,
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
  currentAlternative: '每天手工复制表格',
  competitors: ['同步工具 A'],
  monetization: 'subscription' as const,
  mvp: '先做两个平台的库存拉取与超卖提醒',
  evidence: [{ url: 'https://example.com/post-1', quote: '愿意付费买工具' }],
};

describe('findOpportunities', () => {
  it('collects snippets from every port, then asks the model once', async () => {
    const structured = vi.fn(llmReturning({ opportunities: [OPPORTUNITY] }).structured);
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3)]), port('bing', [hit(4), hit(5)])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: { structured, text: vi.fn() } as unknown as LlmPort,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sources).toHaveLength(5);
    expect(result.value.providers).toEqual(['ddg', 'bing']);
    expect(result.value.opportunities).toEqual([OPPORTUNITY]);

    const prompt = structured.mock.calls[0]?.[1] as { user: string };
    expect(prompt.user).toContain('https://example.com/post-1');
  });

  it('dedupes URLs across ports and stops at the source cap', async () => {
    const many = Array.from({ length: 30 }, (_, index) => hit(index));
    const result = await findOpportunities({
      searchPorts: [port('a', many), port('b', many)],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sources.length).toBeLessThanOrEqual(MAX_SOURCES);
  });

  it('survives a blocked engine as long as another port answers', async () => {
    const result = await findOpportunities({
      searchPorts: [brokenPort('ddg'), port('bing', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.providers).toEqual(['bing']);
  });

  it('fails with NO_SOURCES when nothing answers', async () => {
    const result = await findOpportunities({
      searchPorts: [brokenPort('ddg'), port('bing', [])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
    });

    expect(result).toEqual({
      ok: false,
      code: 'NO_SOURCES',
      message: expect.stringContaining('样本不足'),
    });
  });

  it('drops candidates whose evidence is not one of the supplied URLs', async () => {
    const invented = {
      ...OPPORTUNITY,
      evidence: [{ url: 'https://invented.example.com/x', quote: '编造的引文' }],
    };
    const mixed = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: llmReturning({ opportunities: [invented, OPPORTUNITY] }),
    });

    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(mixed.value.opportunities).toEqual([OPPORTUNITY]);

    const onlyInvented = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: llmReturning({ opportunities: [invented] }),
    });
    expect(onlyInvented.ok).toBe(false);
    if (!onlyInvented.ok) expect(onlyInvented.code).toBe('INVALID_OUTPUT');
  });

  it('reports the model failure as LLM_UNAVAILABLE', async () => {
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
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
        searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
        queries: ['库存 同步', '库存 卖家', '库存 超卖'],
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
        { url: 'https://example.com/post-1', quote: '愿意付费买工具' },
        { url: 'https://example.com/post-1', quote: '每天手工同步库存太麻烦' },
      ],
    };
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      queries: ['库存 同步', '库存 卖家', '库存 超卖'],
      llm: llmReturning({ opportunities: [duplicated] }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.opportunities[0]?.evidence).toHaveLength(1);
  });

  it('reports search → filter → model phases in order', async () => {
    const phases: string[] = [];
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      llm: llmReturning({ opportunities: [OPPORTUNITY] }),
      queries: ['库存 同步'],
      onPhase: (phase) => phases.push(phase),
    });

    expect(result.ok).toBe(true);
    expect(phases[0]).toBe('search');
    expect(phases).toContain('filter');
    expect(phases).toContain('model');
    expect(phases.lastIndexOf('filter')).toBeLessThan(phases.indexOf('model'));
  });

  it('explains network and cooldown failures in actionable terms', async () => {
    const result = await findOpportunities({
      searchPorts: [port('ddg', [hit(1), hit(2), hit(3), hit(4), hit(5)])],
      llm: {
        async structured() {
          return {
            ok: false,
            code: 'LLM_UNAVAILABLE',
            message:
              '所有 provider 均失败（bulk）：OpenCode Go#glm-5.3-flash: network、OpenCode Go#big-pickle: cooldown',
          } as never;
        },
        async text() {
          throw new Error('unused');
        },
      } as unknown as LlmPort,
      queries: ['库存 同步'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('网络或代理');
    expect(result.message).toContain('切换链');
  });
});
