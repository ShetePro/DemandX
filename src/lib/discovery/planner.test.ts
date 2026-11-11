import { describe, expect, it, vi } from 'vitest';

import type { LlmPort } from '@/lib/llm/port';

import {
  cleanDirections,
  EXPLORATION_SEEDS,
  FALLBACK_ANGLE,
  FALLBACK_ANGLES,
  fallbackPlan,
  normalizePlan,
  planScan,
} from './planner';
import type { ScanMemory, TrendItem } from './types';

const MEMORY: ScanMemory = {
  scans: [
    {
      angles: ['小店主财务', '自由职业收款'],
      queries: ['发票 报销 手工 小公司 财务'],
      opportunities: [
        {
          title: '自由职业者发票助手',
          problem: '自由职业者每月手工汇总发票，催客户付款很费劲',
          angle: '自由职业收款',
          fingerprint: '123',
        },
      ],
      createdAt: '2026-11-01T10:00:00.000Z',
    },
  ],
  adopted: [{ title: '自由职业者发票助手', angle: '自由职业收款' }],
  excludedUrls: ['https://example.com/seen'],
};

const TRENDS: TrendItem[] = [
  {
    title: 'Ask HN: scheduling tools for tiny clinics?',
    url: 'https://news.ycombinator.com/item?id=2',
    snippet: 'We run three rooms and still use a spreadsheet.',
    points: 64,
    platform: 'hn',
  },
];

function llmAnswering(data: unknown) {
  const structured = vi.fn<
    (schema: unknown, prompt: unknown, options: unknown) => Promise<unknown>
  >(async () => ({
    ok: true as const,
    value: {
      data,
      used: {
        providerId: 1,
        providerName: 'stub',
        kind: 'openai-compatible',
        baseUrl: 'http://stub',
        modelId: 'stub-planner',
        headers: {},
      },
      usage: { in: 1, out: 1 },
    },
  }));
  const llm = { structured } as unknown as Pick<LlmPort, 'structured'>;
  return { llm, structured };
}

const VALID = {
  angles: ['诊所排班', '门店库存', '外贸单据'],
  queries: [
    { query: '诊所 排班 excel 换班', angle: '诊所排班', language: 'zh' as const },
    { query: 'clinic scheduling spreadsheet tool', angle: '诊所排班', language: 'en' as const },
    { query: '门店 库存 手工 对账', angle: '门店库存', language: 'zh' as const },
    { query: 'retail inventory spreadsheet small shop', angle: '门店库存', language: 'en' as const },
    { query: '外贸 单据 英文 模板', angle: '外贸单据', language: 'zh' as const },
    { query: 'export invoice template tool', angle: '外贸单据', language: 'en' as const },
    { query: '牙科 诊所 预约 管理', angle: '诊所排班', language: 'zh' as const },
    { query: 'dental clinic appointment spreadsheet', angle: '诊所排班', language: 'en' as const },
  ],
  rationale: '热点里诊所排班与门店库存的抱怨最多。',
};

describe('planScan', () => {
  it('shows the model trends, history and adopted directions', async () => {
    const { llm, structured } = llmAnswering(VALID);
    const plan = await planScan({
      llm,
      memory: MEMORY,
      trends: TRENDS,
      trendsAvailable: true,
      random: () => 0,
    });

    expect(plan.strategy).toBe('planned');
    expect(plan.angles).toEqual(['诊所排班', '门店库存', '外贸单据']);

    const prompt = structured.mock.calls[0]?.[1] as { system: string; user: string };
    expect(prompt.user).toContain('scheduling tools for tiny clinics');
    expect(prompt.user).toContain('自由职业者发票助手');
    expect(prompt.user).toContain('小店主财务');
    expect(prompt.user).toContain(EXPLORATION_SEEDS[0]);
  });

  it('states that trends are unavailable instead of pretending', async () => {
    const { llm, structured } = llmAnswering(VALID);
    await planScan({
      llm,
      memory: MEMORY,
      trends: [],
      trendsAvailable: false,
      random: () => 0,
    });

    const prompt = structured.mock.calls[0]?.[1] as { user: string };
    expect(prompt.user).toContain('热点源本轮不可达');
  });

  it('falls back to the static pool when the model cannot plan', async () => {
    const failing: Pick<LlmPort, 'structured'> = {
      structured: vi.fn(async () => ({ ok: false as const, code: 'NO_PROVIDER', message: 'x' })),
    } as unknown as Pick<LlmPort, 'structured'>;

    const plan = await planScan({
      llm: failing,
      memory: MEMORY,
      trends: [],
      trendsAvailable: true,
      random: () => 0.1,
    });

    expect(plan.strategy).toBe('fallback');
    expect(plan.angles.length).toBeGreaterThanOrEqual(3);
    expect(plan.queries.every((item) => plan.angles.includes(item.angle))).toBe(true);
    expect(plan.queries.length).toBeGreaterThanOrEqual(8);
  });

  it('rejects an answer whose queries point at angles it did not declare', async () => {
    const scrambled = {
      ...VALID,
      queries: VALID.queries.map((item) => ({ ...item, angle: '其他角度' })),
    };
    const plan = await planScan({
      llm: llmAnswering(scrambled).llm,
      memory: MEMORY,
      trends: [],
      trendsAvailable: true,
      random: () => 0.1,
    });

    expect(plan.strategy).toBe('fallback');
  });
});

describe('normalizePlan', () => {
  it('dedupes queries and rejects fewer than eight usable ones', () => {
    const plan = normalizePlan(VALID, 'model-x');
    expect(plan?.queries).toHaveLength(8);
    expect(plan?.model).toBe('model-x');

    const tooFew = normalizePlan({ ...VALID, queries: VALID.queries.slice(0, 4) });
    expect(tooFew).toBeNull();
  });

  it('requires at least three angles covered by the queries', () => {
    const single = {
      ...VALID,
      queries: VALID.queries.map((item) => ({ ...item, angle: '诊所排班' })),
    };
    expect(normalizePlan(single)).toBeNull();
  });
});

describe('directed scans', () => {
  const DIRECTED = {
    angles: ['诊所排班', '门店库存'],
    queries: [
      { query: '诊所 排班 excel 换班', angle: '诊所排班', language: 'zh' as const },
      { query: 'clinic scheduling spreadsheet tool', angle: '诊所排班', language: 'en' as const },
      { query: '门店 库存 手工 对账', angle: '门店库存', language: 'zh' as const },
      { query: 'retail inventory spreadsheet small shop', angle: '门店库存', language: 'en' as const },
    ],
    rationale: '按指定方向检索。',
  };

  it('locks the plan to the directions the operator picked', async () => {
    const { llm, structured } = llmAnswering(DIRECTED);
    const plan = await planScan({
      llm,
      memory: MEMORY,
      trends: [],
      trendsAvailable: true,
      directions: ['诊所排班', '门店库存'],
      random: () => 0,
    });

    expect(plan.strategy).toBe('directed');
    expect(plan.angles).toEqual(['诊所排班', '门店库存']);
    expect(plan.queries.map((item) => item.angle)).toEqual([
      '诊所排班',
      '诊所排班',
      '门店库存',
      '门店库存',
    ]);

    const prompt = structured.mock.calls[0]?.[1] as { system: string; user: string };
    expect(prompt.system).toContain('本轮用户指定了方向：诊所排班、门店库存');
    expect(prompt.user).toContain('用户已指定方向，忽略种子');
  });

  it('falls back to template queries on the same directions when the model fails', async () => {
    const failing: Pick<LlmPort, 'structured'> = {
      structured: vi.fn(async () => ({ ok: false as const, code: 'NO_PROVIDER', message: 'x' })),
    } as unknown as Pick<LlmPort, 'structured'>;

    const plan = await planScan({
      llm: failing,
      memory: MEMORY,
      trends: [],
      trendsAvailable: true,
      directions: ['诊所排班'],
      random: () => 0.1,
    });

    expect(plan.strategy).toBe('directed');
    expect(plan.angles).toEqual(['诊所排班']);
    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.queries.every((item) => item.angle === '诊所排班')).toBe(true);
  });

  it('rejects an answer that skipped one of the directions', async () => {
    const partial = {
      ...DIRECTED,
      queries: DIRECTED.queries.filter((item) => item.angle === '诊所排班'),
    };
    const plan = await planScan({
      llm: llmAnswering(partial).llm,
      memory: MEMORY,
      trends: [],
      trendsAvailable: true,
      directions: ['诊所排班', '门店库存'],
      random: () => 0.1,
    });

    // Mechanical fallback still honours the directions rather than dropping one.
    expect(plan.strategy).toBe('directed');
    expect(plan.angles).toEqual(['诊所排班', '门店库存']);
  });
});

describe('domain diversity', () => {
  it('trims a plan that spends its angles on one buyer domain', () => {
    const construction = {
      ...VALID,
      angles: ['工地签证', '装修进度款', '工地验收', '装修报价'],
      queries: VALID.queries.map((item, index) => ({
        ...item,
        angle: ['工地签证', '装修进度款', '工地验收', '装修报价'][index % 4] ?? '工地签证',
      })),
    };
    // Two construction sub-angles survive; fewer than three angles -> reject.
    expect(normalizePlan(construction)).toBeNull();
  });

  it('keeps two sub-angles when a second domain is present', () => {
    const mixed = {
      ...VALID,
      angles: ['工地签证', '装修进度款', '工厂点检', '设备报修'],
      queries: VALID.queries.map((item, index) => ({
        ...item,
        angle: ['工地签证', '装修进度款', '工厂点检', '设备报修'][index % 4] ?? '工地签证',
      })),
    };
    const plan = normalizePlan(mixed);
    expect(plan?.angles).toEqual(['工地签证', '装修进度款', '工厂点检', '设备报修']);
  });

  it('rejects angles that repeat a domain covered by recent scans', () => {
    const plan = normalizePlan(
      VALID,
      undefined,
      [],
      ['health'],
    );
    // VALID contains 诊所排班 (health); the whole plan is refused.
    expect(plan).toBeNull();
  });

  it('keeps a plan with distinct domains', () => {
    expect(normalizePlan(VALID)?.angles).toEqual(['诊所排班', '门店库存', '外贸单据']);
  });
});

describe('cleanDirections', () => {
  it('trims, dedupes, drops blanks and caps at five', () => {
    expect(
      cleanDirections([' 诊所排班 ', '诊所排班', '', '门店库存', ...Array.from({ length: 5 }, (_, i) => `方向${i}`)]),
    ).toEqual(['诊所排班', '门店库存', '方向0', '方向1', '方向2']);
  });
});

describe('fallbackPlan', () => {
  it('tags every sampled query with a themed fallback angle and its language', () => {
    const plan = fallbackPlan(() => 0.5);
    const allowed = [FALLBACK_ANGLE, ...FALLBACK_ANGLES];
    expect(plan.angles.length).toBeGreaterThanOrEqual(3);
    expect(plan.angles.every((angle) => allowed.includes(angle))).toBe(true);
    expect(plan.queries.every((item) => plan.angles.includes(item.angle))).toBe(true);
    expect(new Set(plan.queries.map((item) => item.angle)).size).toBeGreaterThan(1);
    expect(plan.queries.some((item) => item.language === 'zh')).toBe(true);
    expect(plan.queries.some((item) => item.language === 'en')).toBe(true);
  });
});
