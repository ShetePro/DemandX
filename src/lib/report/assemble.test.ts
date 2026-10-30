import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import type { StageOutcome } from '@/lib/pipeline/context';
import type { DimensionScore } from '@/lib/scoring/types';

import {
  buildReportPrompt,
  buildReportSections,
  MAX_CLAIMS_PER_SECTION,
  NO_EVIDENCE_REASON,
  UNREFERENCED_PREFIX,
  type AssembleInput,
  type ReportDerivation,
  type ReportEvidence,
  type ReportSections,
} from './assemble';
import { REPORT_SECTIONS, validateReport, type ReportSectionBody } from './validate';

const USED: ChainItem = {
  providerId: 3,
  providerName: 'fake',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: 'qwen3:14b',
  headers: {},
};

type Answer = { fail: string } | unknown;

interface FakeLlm {
  port: LlmPort;
  prompts: Prompt[];
  profiles: Profile[];
}

/** Answers the n-th report call; `fail` makes the port report LLM_UNAVAILABLE. */
function createLlm(reply: (call: number) => Answer): FakeLlm {
  const prompts: Prompt[] = [];
  const profiles: Profile[] = [];

  const port: LlmPort = {
    async structured<T>(
      _schema: ZodType<T>,
      prompt: Prompt,
      options: { profile: Profile },
    ): Promise<LlmResult<{ data: T; used: ChainItem; usage: Usage }>> {
      prompts.push(prompt);
      profiles.push(options.profile);

      const answer = reply(prompts.length - 1);
      if (typeof answer === 'object' && answer !== null && 'fail' in answer) {
        return { ok: false, code: 'LLM_UNAVAILABLE', message: String(answer.fail) };
      }
      return {
        ok: true,
        value: { data: answer as T, used: USED, usage: { in: 0, out: 0 } },
      };
    },
    async text(): Promise<never> {
      throw new Error('the report stage must only use structured()');
    },
  };

  return { port, prompts, profiles };
}

function evidence(id: number, overrides: Partial<ReportEvidence> = {}): ReportEvidence {
  return {
    id,
    sourceId: 100 + id,
    signal: 'problem',
    platform: 'v2ex',
    quote: `第 ${id} 条证据的原话`,
    supports: '支持问题存在',
    ...overrides,
  };
}

/** 16 + 13 + 0 + 10 + 15 + 10 + 4 = 68. */
const SCORES: DimensionScore[] = [
  { dimension: 'needs', points: 16, rationale: '独立来源 5 个', evidenceIds: [1] },
  { dimension: 'payment', points: 13, rationale: '已付费证据 2 条', evidenceIds: [1] },
  { dimension: 'gap', points: 0, rationale: '直接竞品 0 个', evidenceIds: [] },
  { dimension: 'acquisition', points: 10, rationale: '2 档 × 5', evidenceIds: [1] },
  { dimension: 'profit', points: 15, rationale: '3 档 × 5', evidenceIds: [1] },
  { dimension: 'feasibility', points: 10, rationale: '2 档 × 5', evidenceIds: [1] },
  { dimension: 'longevity', points: 4, rationale: '持续使用证据 2 条', evidenceIds: [1] },
];

function derivation(overrides: Partial<ReportDerivation> = {}): ReportDerivation {
  return {
    scores: SCORES,
    total: 68,
    credibility: { grade: 'B', reason: '需求 16 分、论断有引用、独立来源 5 个' },
    decision: {
      decision: '建议先验证，再开发',
      reason: '总分 68 分（<70），证据方向成立但未达到开发门槛',
      nextStep: '5 个目标用户访谈 + 一页落地页 + 价格测试',
    },
    ...overrides,
  };
}

function body(
  text = '卖家在多个平台之间手工同步库存',
  evidenceIds: number[] = [1],
  unknowns: string[] = [],
): ReportSectionBody {
  return { claims: [{ text, evidenceIds }], unknowns };
}

/** A complete answer; each test replaces the one section it breaks. */
function answer(overrides: Record<string, unknown> = {}): { sections: Record<string, unknown> } {
  const sections: Record<string, unknown> = {};
  for (const key of REPORT_SECTIONS) sections[key] = body();
  return { sections: { ...sections, ...overrides } };
}

interface SetupOptions {
  reply?: (call: number) => Answer;
  evidence?: readonly ReportEvidence[];
  total?: number;
}

function setup(options: SetupOptions = {}): {
  deps: AssembleInput;
  llm: FakeLlm;
} {
  const llm = createLlm(options.reply ?? (() => answer()));

  return {
    llm,
    deps: {
      llm: llm.port,
      opportunity: {
        name: '多平台库存同步',
        positioning: '面向跨境卖家的库存同步工具',
        independentSources: 5,
      },
      evidence: options.evidence ?? [evidence(1), evidence(2), evidence(3)],
      derivation: derivation(options.total === undefined ? {} : { total: options.total }),
    },
  };
}

function expectOk(result: StageOutcome<ReportSections>): ReportSections {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

function expectFailure(result: StageOutcome<ReportSections>): { code: string; message: string } {
  if (result.ok) throw new Error('expected a failure');
  return { code: result.code, message: result.message };
}

describe('buildReportSections', () => {
  it('keeps every claim whose citations are accepted rows of this run', async () => {
    const { deps } = setup();

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.claims).toEqual([
      { text: '卖家在多个平台之间手工同步库存', evidenceIds: [1] },
    ]);
    expect(
      validateReport({
        sections: report.sections,
        rubricTotal: 68,
        scoresTotal: 68,
      }),
    ).toEqual({ ok: true });
  });

  it('moves a claim citing an id from another run into unknowns', async () => {
    const { deps } = setup({
      reply: () => answer({ summary: body('卖家普遍愿意为库存同步付费', [99]) }),
    });

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.claims).toEqual([]);
    expect(report.sections.summary.unknowns).toEqual([
      `${UNREFERENCED_PREFIX}卖家普遍愿意为库存同步付费`,
    ]);
  });

  it('never leaves a hallucinated e99 citation in the body', async () => {
    const { deps } = setup({
      reply: () => answer({ summary: body('据 e99，卖家普遍愿意付费', [1]) }),
    });

    const report = expectOk(await buildReportSections(deps));

    const bodyText = JSON.stringify(report.sections.summary.claims);
    expect(bodyText).not.toContain('e99');
    expect(report.sections.summary.claims).toEqual([]);
    expect(report.sections.summary.unknowns[0]).toContain(UNREFERENCED_PREFIX);
  });

  it('rejects a headline score the derivation did not produce', async () => {
    const { deps } = setup({
      reply: () => answer({ summary: body('总分 99/100，建议开发', [1]) }),
    });

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.claims).toEqual([]);
    expect(report.sections.summary.unknowns).toEqual([
      `${UNREFERENCED_PREFIX}总分 99/100，建议开发`,
    ]);
  });

  it('keeps a claim that quotes the derivation total unchanged', async () => {
    const { deps } = setup({
      reply: () => answer({ summary: body('总分 68/100，证据方向成立', [1]) }),
    });

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.claims).toEqual([
      { text: '总分 68/100，证据方向成立', evidenceIds: [1] },
    ]);
  });

  it('moves a claim that cites any id outside this run, even next to a real one', async () => {
    const { deps } = setup({
      reply: () => answer({ summary: body('卖家在手工同步库存', [1, 99, 1]) }),
    });

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.claims).toEqual([]);
    expect(report.sections.summary.unknowns).toEqual([`${UNREFERENCED_PREFIX}卖家在手工同步库存`]);
  });

  it('dedupes repeated accepted ids on a kept claim', async () => {
    const { deps } = setup({
      reply: () => answer({ summary: body('卖家在手工同步库存', [1, 1, 1]) }),
    });

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.claims).toEqual([
      { text: '卖家在手工同步库存', evidenceIds: [1] },
    ]);
  });

  it('dedupes repeated unknowns', async () => {
    const { deps } = setup({
      reply: () =>
        answer({ summary: body('卖家在手工同步库存', [1], ['缺少竞品定价', '缺少竞品定价']) }),
    });

    const report = expectOk(await buildReportSections(deps));

    expect(report.sections.summary.unknowns).toEqual(['缺少竞品定价']);
  });

  it('fails when the answer drops one of the eight sections', async () => {
    const { deps } = setup({
      reply: () => {
        const broken = answer();
        delete broken.sections.competitors;
        return broken;
      },
    });

    const failure = expectFailure(await buildReportSections(deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).toContain('报告结构不合 schema');
    expect(failure.message).toContain('competitors');
  });

  it('fails when one section exceeds the six-claim ceiling', async () => {
    const claims = Array.from({ length: MAX_CLAIMS_PER_SECTION + 1 }, (_, index) => ({
      text: `论断 ${index}`,
      evidenceIds: [1],
    }));
    const { deps } = setup({
      reply: () => answer({ summary: { claims, unknowns: [] } }),
    });

    const failure = expectFailure(await buildReportSections(deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).toContain('summary');
  });

  it('returns LLM_UNAVAILABLE when the synthesis call fails', async () => {
    const { deps } = setup({ reply: () => ({ fail: 'quality 链为空' }) });

    const failure = expectFailure(await buildReportSections(deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).toContain('quality 链为空');
  });

  it('builds eight empty sections without calling the model when there is no evidence', async () => {
    const { deps, llm } = setup({ evidence: [] });

    const report = expectOk(await buildReportSections(deps));

    expect(llm.prompts).toEqual([]);
    for (const section of REPORT_SECTIONS) {
      expect(report.sections[section]).toEqual({ claims: [], unknowns: [NO_EVIDENCE_REASON] });
    }
    expect(validateReport({ sections: report.sections, rubricTotal: 0, scoresTotal: 0 })).toEqual({
      ok: true,
    });
  });

  it('shows the derivation and the accepted ids in the prompt, and forbids rescoring', async () => {
    const { deps, llm } = setup();

    expectOk(await buildReportSections(deps));

    const prompt = llm.prompts[0];
    expect(prompt).toBeDefined();
    if (prompt === undefined) return;

    expect(llm.profiles).toEqual(['quality']);
    expect(prompt.user).toContain('68/100');
    expect(prompt.user).toContain('建议先验证，再开发');
    expect(prompt.user).toContain('id=1');
    expect(prompt.user).toContain('id=3');
    expect(prompt.system).toContain('evidenceIds');
    expect(prompt.system).toContain('unknowns');
    expect(prompt.user).toContain('不得重算');
  });
});

describe('buildReportPrompt', () => {
  it('names all eight sections and the one legal score format', () => {
    const prompt = buildReportPrompt({
      llm: createLlm(() => answer()).port,
      opportunity: { name: null, positioning: null, independentSources: 0 },
      evidence: [evidence(7)],
      derivation: derivation(),
    });

    for (const section of REPORT_SECTIONS) {
      expect(prompt.system).toContain(section);
    }
    expect(prompt.system).toContain('68/100');
    expect(prompt.user).toContain('id=7');
  });
});
