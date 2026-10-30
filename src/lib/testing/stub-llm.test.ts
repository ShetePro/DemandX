import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { buildExtractionPrompt } from '@/lib/evidence/prompt';
import { gateQuote } from '@/lib/evidence/quote-gate';
import { SIGNALS, evidenceExtractionSchema } from '@/lib/evidence/schema';
import { buildClusteringPrompt, clusteringSchema } from '@/lib/pipeline/s3-cluster';
import { buildScoringPrompt, ordinalsSchema } from '@/lib/pipeline/s4-score';
import {
  buildReportPrompt,
  reportSectionsSchema,
  type ReportDerivation,
  type ReportEvidence,
} from '@/lib/report/assemble';
import { REPORT_SECTIONS } from '@/lib/report/validate';
import type { AcceptedEvidence } from '@/lib/runs/opportunities-repository';
import type { ScoringEvidenceRow } from '@/lib/runs/evidence-repository';
import { DIMENSIONS } from '@/lib/scoring/types';

import { FINANCE_UNREFERENCED_CLAIM, createStubLlm } from './stub-llm';

const STUB_TEXT =
  '我们三个店铺的库存每天都要手工对一遍，还是经常超卖。\n每次大促之后都要花两天时间核对订单和库存。';
const EXPECTED_QUOTE = '我们三个店铺的库存每天都要手工对一遍，还是经常超卖。';

function extractionPrompt(text = STUB_TEXT) {
  return buildExtractionPrompt({ url: 'https://example.test/a', platform: 'v2ex', text });
}

function acceptedEvidence(ids: readonly number[]): AcceptedEvidence[] {
  return ids.map((id) => ({
    id,
    signal: 'problem',
    platform: 'v2ex',
    supports: `支持问题 ${id}`,
    quote: `第 ${id} 条原话，描述同一个库存问题`,
    sourceId: 100 + id,
    canonicalUrl: `https://example.test/${id}`,
  }));
}

function scoringEvidence(ids: readonly number[]): ScoringEvidenceRow[] {
  return ids.map((id) => ({
    id,
    sourceId: 100 + id,
    signal: 'problem',
    platform: 'v2ex',
    quote: `第 ${id} 条原话，描述同一个库存问题`,
    priceMentioned: null,
    rejectedReason: null,
  }));
}

const DERIVATION: ReportDerivation = {
  scores: DIMENSIONS.map((dimension) => ({
    dimension,
    points: 0,
    rationale: `${dimension} 的依据`,
    evidenceIds: [],
  })),
  total: 0,
  credibility: { grade: 'C', reason: '假模型验收用' },
  decision: { decision: '建议先验证，再开发', reason: '假模型验收用', nextStep: '访谈 5 个用户' },
};

const REPORT_EVIDENCE: ReportEvidence[] = [
  {
    id: 31,
    sourceId: 301,
    signal: 'problem',
    platform: 'v2ex',
    quote: '库存每天都要手工对一遍，还是经常超卖',
    supports: '用户自述遇到问题',
  },
  {
    id: 32,
    sourceId: 302,
    signal: 'seeking',
    platform: 'xiaohongshu',
    quote: '有没有能同步库存的工具',
    supports: '用户在寻求方案',
  },
];

describe('createStubLlm extraction', () => {
  it('copies the first sentence of the prompt body, and the gate accepts it', async () => {
    const stub = createStubLlm();
    const answer = await stub.structured(evidenceExtractionSchema, extractionPrompt(), {
      profile: 'bulk',
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const item = answer.value.data.items[0];
    expect(item).toBeDefined();
    expect(item?.quote).toBe(EXPECTED_QUOTE);
    expect(gateQuote(STUB_TEXT, EXPECTED_QUOTE)).toEqual({
      ok: true,
      offset: 0,
      length: EXPECTED_QUOTE.length,
    });
    expect(stub.calls).toEqual(['extract']);
  });

  it('rotates through the five signals in order', async () => {
    const stub = createStubLlm();
    const signals: (string | undefined)[] = [];

    for (let call = 0; call < SIGNALS.length; call += 1) {
      const answer = await stub.structured(evidenceExtractionSchema, extractionPrompt(), {
        profile: 'bulk',
      });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      signals.push(answer.value.data.items[0]?.signal);
    }

    expect(signals).toEqual([...SIGNALS]);
    expect(stub.calls).toHaveLength(SIGNALS.length);
  });

  it('returns no items when the prompt has no body', async () => {
    const stub = createStubLlm();
    const answer = await stub.structured(
      evidenceExtractionSchema,
      { system: '抽取', user: '平台：v2ex\n地址：https://example.test/empty\n\n正文：\n"""\n"""' },
      { profile: 'bulk' },
    );

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.data.items).toEqual([]);
  });
});

describe('createStubLlm clustering', () => {
  it('groups the first six listed ids and invents nothing', async () => {
    const stub = createStubLlm();
    const evidence = acceptedEvidence([11, 12, 13, 14, 15, 16, 17, 18]);

    const answer = await stub.structured(clusteringSchema, buildClusteringPrompt(evidence), {
      profile: 'quality',
    });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    expect(answer.value.data.clusters).toHaveLength(1);
    expect(answer.value.data.clusters[0]?.evidenceIds).toEqual([11, 12, 13, 14, 15, 16]);
    expect(stub.calls).toEqual(['cluster']);
  });

  it('returns an empty cluster list when the prompt lists no ids', async () => {
    const stub = createStubLlm();
    const answer = await stub.structured(
      clusteringSchema,
      { system: '聚类', user: '证据列表：' },
      {
        profile: 'quality',
      },
    );

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.data.clusters).toEqual([]);
  });
});

describe('createStubLlm ordinal scoring', () => {
  it('answers tier 2 with the first three listed ids', async () => {
    const stub = createStubLlm();
    const prompt = buildScoringPrompt(
      { name: '库存同步', positioning: '多渠道卖家', independentSources: 3 },
      scoringEvidence([21, 22, 23, 24]),
    );

    const answer = await stub.structured(ordinalsSchema, prompt, { profile: 'quality' });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const data = answer.value.data;
    expect(data.acquisition).toEqual({ ordinal: 2, evidenceIds: [21, 22, 23] });
    expect(data.profit).toEqual({ ordinal: 2, evidenceIds: [21, 22, 23] });
    expect(data.feasibility).toEqual({ ordinal: 2, evidenceIds: [21, 22, 23] });
    expect(stub.calls).toEqual(['ordinals']);
  });
});

describe('createStubLlm report', () => {
  it('writes one claim per section, citing the first whitelisted id', async () => {
    const stub = createStubLlm();
    const prompt = buildReportPrompt({
      llm: stub,
      opportunity: { name: '库存同步', positioning: '多渠道卖家', independentSources: 2 },
      evidence: REPORT_EVIDENCE,
      derivation: DERIVATION,
    });

    const answer = await stub.structured(reportSectionsSchema, prompt, { profile: 'quality' });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;

    const sections = answer.value.data.sections;
    expect(Object.keys(sections)).toEqual([...REPORT_SECTIONS]);

    for (const section of REPORT_SECTIONS) {
      const claims = sections[section].claims;
      expect(claims.length).toBeGreaterThanOrEqual(1);
      expect(claims[0]?.evidenceIds).toEqual([31]);
    }

    const finance = sections.finance.claims;
    expect(finance).toHaveLength(2);
    const unreferenced = finance[1];
    expect(unreferenced?.text).toBe(FINANCE_UNREFERENCED_CLAIM);
    expect(unreferenced?.evidenceIds.some((id) => id === 31 || id === 32)).toBe(false);
    expect(stub.calls).toEqual(['sections']);
  });
});

describe('createStubLlm routing', () => {
  it('reports LLM_BAD_OUTPUT for a schema it cannot answer', async () => {
    const stub = createStubLlm();
    const answer = await stub.structured(
      z.object({ unrelated: z.string() }),
      {
        system: 'x',
        user: 'y',
      },
      { profile: 'bulk' },
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('LLM_BAD_OUTPUT');
    expect(stub.calls).toEqual(['unsupported']);
  });
});
