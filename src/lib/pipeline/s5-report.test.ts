import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import { fail, ok, type Result } from '@/lib/quota/types';
import type { SaveReportInput } from '@/lib/report/persist';
import { REPORT_SECTIONS, type ReportSectionBody } from '@/lib/report/validate';
import type { ScoringEvidenceRow } from '@/lib/runs/evidence-repository';
import type { AcceptedEvidence } from '@/lib/runs/opportunities-repository';
import type { OpportunityRow } from '@/lib/runs/opportunities-repository';
import { DIMENSIONS, type Dimension, type DimensionScore } from '@/lib/scoring/types';
import { deriveVerdict } from '@/lib/scoring/verdict';

import type { RunContext, StageOutcome } from './context';
import { reportS5, type ReportDeps, type ReportS5Summary } from './s5-report';

const NOW = new Date('2026-10-30T12:00:00.000Z');

const USED: ChainItem = {
  providerId: 4,
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

/** Answers the n-th synthesis call; `fail` makes the port report LLM_UNAVAILABLE. */
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
      return { ok: true, value: { data: answer as T, used: USED, usage: { in: 0, out: 0 } } };
    },
    async text(): Promise<never> {
      throw new Error('S5 must only use structured()');
    },
  };

  return { port, prompts, profiles };
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

function scored(overrides: Partial<Record<Dimension, number>> = {}): DimensionScore[] {
  const points: Record<Dimension, number> = {
    needs: 16,
    payment: 13,
    gap: 0,
    acquisition: 10,
    profit: 15,
    feasibility: 10,
    longevity: 4,
    ...overrides,
  };

  return DIMENSIONS.map((dimension) => ({
    dimension,
    points: points[dimension],
    rationale: `${dimension} 的依据`,
    evidenceIds: points[dimension] === 0 ? [] : [1],
  }));
}

function opportunity(id: number, evidenceIds: number[] = [1, 2, 3]): OpportunityRow {
  return {
    id,
    runId: 11,
    name: `机会 ${id}`,
    positioning: `定位 ${id}`,
    independentSources: 5,
    evidenceIds,
  };
}

function evidence(id: number, overrides: Partial<ScoringEvidenceRow> = {}): ScoringEvidenceRow {
  return {
    id,
    sourceId: 100 + id,
    signal: 'problem',
    platform: 'v2ex',
    quote: `第 ${id} 条证据的原话`,
    priceMentioned: null,
    rejectedReason: null,
    supports: '支持问题存在',
    ...overrides,
  };
}

interface RepoOptions {
  opportunities?: readonly OpportunityRow[];
  scores?: Map<number, DimensionScore[]>;
  evidence?: readonly ScoringEvidenceRow[];
  failOpportunities?: boolean;
  failSave?: boolean;
}

interface FakeRepo {
  repo: ReportDeps['repo'];
  saves: SaveReportInput[];
}

function createRepo(options: RepoOptions = {}): FakeRepo {
  const saves: SaveReportInput[] = [];

  const repo: ReportDeps['repo'] = {
    async listOpportunities(): Promise<Result<OpportunityRow[]>> {
      if (options.failOpportunities) return fail('STORAGE_FAILED', '读取机会失败');
      return ok([...(options.opportunities ?? [])]);
    },
    async listScores(opportunityId): Promise<Result<DimensionScore[]>> {
      return ok([...(options.scores?.get(opportunityId) ?? [])]);
    },
    async listEvidenceByIds(ids): Promise<Result<ScoringEvidenceRow[]>> {
      return ok((options.evidence ?? []).filter((row) => ids.includes(row.id)));
    },
    async listAcceptedEvidence(): Promise<Result<AcceptedEvidence[]>> {
      return ok(
        (options.evidence ?? []).map((row) => ({
          id: row.id,
          sourceId: row.sourceId,
          signal: row.signal,
          platform: row.platform,
          quote: row.quote,
          supports: row.supports ?? null,
          canonicalUrl: '',
        })),
      );
    },
    async saveReport(input): Promise<Result<{ reportId: number }>> {
      if (options.failSave) return fail('STORAGE_FAILED', '写入报告失败');
      saves.push(input);
      return ok({ reportId: 42 });
    },
  };

  return { repo, saves };
}

interface SetupOptions extends RepoOptions {
  reply?: (call: number) => Answer;
}

function setup(options: SetupOptions = {}): {
  deps: ReportDeps;
  events: { type: string; payload: Record<string, unknown> }[];
  llm: FakeLlm;
  repo: FakeRepo;
} {
  const llm = createLlm(options.reply ?? (() => answer()));
  const repo = createRepo(options);
  const events: { type: string; payload: Record<string, unknown> }[] = [];

  const deps: ReportDeps = {
    llm: llm.port,
    repo: repo.repo,
    onEvent: async (type, payload) => {
      events.push({ type, payload });
    },
    now: () => NOW,
  };

  return { deps, events, llm, repo };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return { runId: 11, idea: '跨境库存同步', angles: [], deadlineAt: null, ...overrides };
}

function expectOk(result: StageOutcome<ReportS5Summary>): ReportS5Summary {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

function expectFailure(result: StageOutcome<ReportS5Summary>): {
  code: string;
  message: string;
  issues: unknown;
} {
  if (result.ok) throw new Error('expected a failure');
  return { code: result.code, message: result.message, issues: result.issues };
}

describe('reportS5', () => {
  it('picks the highest S4 total and stores its verdict, not the model’s', async () => {
    const { deps, repo, events } = setup({
      opportunities: [opportunity(1), opportunity(2)],
      scores: new Map([
        [1, scored()],
        [2, scored({ needs: 20 })],
      ]),
      evidence: [evidence(1), evidence(2), evidence(3)],
    });

    const summary = expectOk(await reportS5(context(), deps));

    const verdict = deriveVerdict(scored({ needs: 20 }), 3);
    expect(summary).toEqual({
      reportId: 42,
      opportunityId: 2,
      total: 72,
      grade: verdict.credibility.grade,
      decision: verdict.decision.decision,
      claims: 8,
      citations: 8,
    });
    expect(repo.saves).toHaveLength(1);
    expect(repo.saves[0]?.total).toBe(72);
    expect(repo.saves[0]?.grade).toBe(verdict.credibility.grade);
    expect(repo.saves[0]?.decision).toBe(verdict.decision.decision);
    expect(repo.saves[0]?.sections.summary?.claims[0]).toEqual({
      text: '卖家在多个平台之间手工同步库存',
      evidenceIds: [1],
    });

    expect(events.map((event) => event.type)).toEqual([
      'stage.started',
      'stage.finished',
      'stage.started',
      'stage.finished',
      'report.ready',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ reportId: 42, opportunityId: 2, total: 72 });
  });

  it('breaks a tie by the smaller opportunity id', async () => {
    const { deps } = setup({
      opportunities: [opportunity(1), opportunity(2)],
      scores: new Map([
        [1, scored()],
        [2, scored()],
      ]),
      evidence: [evidence(1), evidence(2), evidence(3)],
    });

    const summary = expectOk(await reportS5(context(), deps));

    expect(summary.opportunityId).toBe(1);
  });

  it('refuses to persist a report the validator rejects', async () => {
    const { deps, repo, events } = setup({
      opportunities: [opportunity(1)],
      scores: new Map([[1, scored()]]),
      evidence: [evidence(1)],
      reply: () =>
        answer({
          finance: {
            claims: [{ text: '市场年增长 30%，本轮无来源', evidenceIds: [1] }],
            unknowns: ['市场年增长 30%'],
          },
        }),
    });

    const failure = expectFailure(await reportS5(context(), deps));

    expect(failure.code).toBe('REPORT_INVALID');
    expect(failure.message).toContain('unknown_leaked');
    expect(Array.isArray(failure.issues)).toBe(true);
    expect(repo.saves).toEqual([]);

    const s6 = events.find(
      (event) => event.type === 'stage.finished' && event.payload.stage === 'S6',
    );
    expect(s6?.payload).toMatchObject({ status: 'failed', code: 'REPORT_INVALID' });
  });

  it('writes the evidence-insufficient report when no opportunity survived S3', async () => {
    const { deps, repo, events, llm } = setup({ opportunities: [], evidence: [] });

    const summary = expectOk(await reportS5(context(), deps));

    expect(llm.prompts).toEqual([]);
    expect(summary).toMatchObject({
      reportId: 42,
      opportunityId: null,
      total: 0,
      grade: 'D',
      decision: '建议放弃',
      claims: 0,
      citations: 0,
    });
    expect(repo.saves[0]?.sections.summary).toEqual({
      claims: [],
      unknowns: [expect.stringContaining('没有可引用的证据')],
    });
    expect(events.at(-1)?.type).toBe('report.ready');
  });

  it('returns LLM_UNAVAILABLE and stores nothing when synthesis fails', async () => {
    const { deps, repo } = setup({
      opportunities: [opportunity(1)],
      scores: new Map([[1, scored()]]),
      evidence: [evidence(1)],
      reply: () => ({ fail: 'quality 链为空' }),
    });

    const failure = expectFailure(await reportS5(context(), deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(repo.saves).toEqual([]);
  });

  it('degrades to the shell after the deadline without calling the model', async () => {
    const { deps, repo, llm } = setup({
      opportunities: [opportunity(1)],
      scores: new Map([[1, scored()]]),
      evidence: [evidence(1)],
    });

    const summary = expectOk(
      await reportS5(context({ deadlineAt: new Date('2026-10-30T11:00:00.000Z') }), deps),
    );

    expect(llm.prompts).toEqual([]);
    expect(summary.total).toBe(68);
    expect(summary.claims).toBe(0);
    expect(repo.saves[0]?.sections.summary?.claims).toEqual([]);
  });

  it('keeps rejected evidence out of the prompt', async () => {
    const { deps, llm } = setup({
      opportunities: [opportunity(1)],
      scores: new Map([[1, scored()]]),
      evidence: [evidence(1), evidence(2, { rejectedReason: 'quote_not_in_snapshot' })],
    });

    expectOk(await reportS5(context(), deps));

    const prompt = llm.prompts[0];
    expect(prompt?.user).toContain('id=1');
    expect(prompt?.user).not.toContain('id=2');
  });

  it('counts one citation per kept evidence link', async () => {
    const { deps, repo } = setup({
      opportunities: [opportunity(1)],
      scores: new Map([[1, scored()]]),
      evidence: [evidence(1), evidence(2)],
      reply: () =>
        answer({ summary: body('卖家在手工同步库存', [1, 2]), evidence: body('证据', [1, 2]) }),
    });

    const summary = expectOk(await reportS5(context(), deps));

    // six sections with one link each, plus two sections with two links.
    expect(summary.citations).toBe(10);
    expect(summary.claims).toBe(8);
    expect(repo.saves[0]?.sections.summary?.claims[0]?.evidenceIds).toEqual([1, 2]);
  });

  it('drops a claim whose headline score the derivation did not produce', async () => {
    const { deps, repo } = setup({
      opportunities: [opportunity(1)],
      scores: new Map([[1, scored()]]),
      evidence: [evidence(1)],
      reply: () => answer({ summary: body('总分 99/100，建议开发', [1]) }),
    });

    const summary = expectOk(await reportS5(context(), deps));

    expect(summary.total).toBe(68);
    expect(repo.saves[0]?.total).toBe(68);
    expect(repo.saves[0]?.sections.summary?.claims).toEqual([]);
    expect(repo.saves[0]?.sections.summary?.unknowns[0]).toContain('99/100');
  });

  it('returns the storage failure without saving when opportunities cannot be read', async () => {
    const { deps, repo } = setup({ failOpportunities: true });

    const failure = expectFailure(await reportS5(context(), deps));

    expect(failure.code).toBe('STORAGE_FAILED');
    expect(repo.saves).toEqual([]);
  });
});
