import { describe, expect, it, vi } from 'vitest';

import type { LlmPort } from '@/lib/llm/port';

import { buildQueryPlanPrompt, normalizeQueryPlan, planSearchQueries } from './query-plan';
import type { AngleGroup } from './angles';

const GROUPS: AngleGroup[] = [
  { angle: 'problem', queries: ['invoice chasing small business', '发票 催收 太麻烦'] },
  { angle: 'seeking', queries: ['looking for invoicing tool reddit', '求推荐 发票 工具'] },
  { angle: 'paying', queries: ['invoice software pricing', '发票 软件 多少钱'] },
  {
    angle: 'competitor',
    queries: ['invoice generator alternative pricing', '发票 工具 竞品 对比'],
  },
];

function llmReturning(data: unknown): Pick<LlmPort, 'structured'> {
  return {
    structured: vi.fn(async () => ({
      ok: true as const,
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
    })) as unknown as LlmPort['structured'],
  };
}

describe('planSearchQueries', () => {
  it('asks for short bilingual queries and returns them grouped', async () => {
    const llm = llmReturning({ groups: GROUPS });
    const groups = await planSearchQueries('自由职业者的发票催收工具', llm);

    expect(groups).toEqual(GROUPS);
    const prompt = (llm.structured as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      user: string;
    };
    expect(prompt.user).toContain('自由职业者的发票催收工具');
  });

  it('falls back when the model returns too little', async () => {
    const llm = llmReturning({ groups: GROUPS.slice(0, 2) });
    expect(await planSearchQueries('x', llm)).toBeNull();
  });

  it('falls back when the provider fails', async () => {
    const llm = {
      structured: vi.fn(async () => ({ ok: false as const, code: 'NO_PROVIDER', message: 'x' })),
    } as unknown as Pick<LlmPort, 'structured'>;
    expect(await planSearchQueries('x', llm)).toBeNull();
  });

  it('keeps the prompt short-query rules', () => {
    const prompt = buildQueryPlanPrompt('idea');
    expect(prompt.system).toContain('不要粘贴整段想法');
    expect(prompt.system).toContain('英文至少 4 条');
  });
});

describe('normalizeQueryPlan', () => {
  it('dedupes queries and angles', () => {
    const plan = normalizeQueryPlan([
      ...GROUPS,
      { angle: 'problem', queries: ['发票 催收 太麻烦'] },
    ]);
    expect(plan?.map((group) => group.angle)).toEqual([
      'problem',
      'seeking',
      'paying',
      'competitor',
    ]);
    expect(new Set(plan?.flatMap((group) => group.queries)).size).toBe(
      plan?.flatMap((group) => group.queries).length,
    );
  });
});
