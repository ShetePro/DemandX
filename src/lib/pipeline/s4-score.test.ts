import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import { fail, ok, type Result } from '@/lib/quota/types';
import type { ScoringEvidenceRow } from '@/lib/runs/evidence-repository';
import type { OpportunityRow } from '@/lib/runs/opportunities-repository';
import type { Dimension, DimensionScore } from '@/lib/scoring/types';

import type { RunContext, StageOutcome } from './context';
import {
  MAX_QUOTE_IN_PROMPT,
  scoreS4,
  type OrdinalAnswer,
  type S4Summary,
  type ScoreDeps,
} from './s4-score';

const NOW = new Date('2026-10-30T12:00:00.000Z');

const USED: ChainItem = {
  providerId: 2,
  providerName: 'fake',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: 'qwen3:14b',
  headers: {},
};

type Answer = { fail: string } | OrdinalAnswer;

interface FakeLlm {
  port: LlmPort;
  prompts: Prompt[];
  profiles: Profile[];
}

/** Answers the n-th rating call; `fail` makes the port report LLM_UNAVAILABLE. */
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
      if ('fail' in answer) {
        return { ok: false, code: 'LLM_UNAVAILABLE', message: answer.fail };
      }
      return {
        ok: true,
        value: { data: answer as unknown as T, used: USED, usage: { in: 0, out: 0 } },
      };
    },
    async text(): Promise<never> {
      throw new Error('S4 must only use structured()');
    },
  };

  return { port, prompts, profiles };
}

interface WriteRecord {
  opportunityId: number;
  scores: DimensionScore[];
}

interface FakeRepo {
  repo: ScoreDeps['repo'];
  writes: WriteRecord[];
  store: Map<number, DimensionScore[]>;
  stats: { listCalls: number; evidenceCalls: number };
}

interface RepoOptions {
  opportunities: readonly OpportunityRow[];
  evidence: readonly ScoringEvidenceRow[];
  listFails?: boolean;
  evidenceFails?: boolean;
  writeFails?: boolean;
}

/** Mirrors the real repository: a write replaces the opportunity's rows. */
function createRepo(options: RepoOptions): FakeRepo {
  const writes: WriteRecord[] = [];
  const store = new Map<number, DimensionScore[]>();
  const stats = { listCalls: 0, evidenceCalls: 0 };

  const repo: ScoreDeps['repo'] = {
    async listOpportunities(): Promise<Result<OpportunityRow[]>> {
      stats.listCalls += 1;
      if (options.listFails) return fail('STORAGE_FAILED', '读取机会失败');
      return ok([...options.opportunities]);
    },
    async listEvidenceByIds(ids): Promise<Result<ScoringEvidenceRow[]>> {
      stats.evidenceCalls += 1;
      if (options.evidenceFails) return fail('STORAGE_FAILED', '读取证据失败');
      return ok(options.evidence.filter((row) => ids.includes(row.id)));
    },
    async replaceScores(opportunityId, scores): Promise<Result<void>> {
      if (options.writeFails) return fail('STORAGE_FAILED', '写入评分失败');
      const snapshot = [...scores];
      writes.push({ opportunityId, scores: snapshot });
      store.set(opportunityId, snapshot);
      return ok(undefined);
    },
  };

  return { repo, writes, store, stats };
}

interface SetupOptions extends RepoOptions {
  reply: (call: number) => Answer;
  deps?: Partial<ScoreDeps>;
}

function setup(options: SetupOptions): {
  deps: ScoreDeps;
  events: { type: string; payload: Record<string, unknown> }[];
  repo: FakeRepo;
  llm: FakeLlm;
} {
  const llm = createLlm(options.reply);
  const repo = createRepo(options);
  const events: { type: string; payload: Record<string, unknown> }[] = [];

  const deps: ScoreDeps = {
    llm: llm.port,
    repo: repo.repo,
    onEvent: async (type, payload) => {
      events.push({ type, payload });
    },
    now: () => NOW,
    ...options.deps,
  };

  return { deps, events, repo, llm };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 11,
    idea: '跨境库存同步',
    angles: [],
    deadlineAt: null,
    ...overrides,
  };
}

function evidence(
  id: number,
  sourceId: number,
  overrides: Partial<ScoringEvidenceRow> = {},
): ScoringEvidenceRow {
  return {
    id,
    sourceId,
    signal: 'problem',
    platform: 'v2ex',
    quote: `第 ${id} 条证据的原话`,
    priceMentioned: null,
    rejectedReason: null,
    ...overrides,
  };
}

function opportunity(
  id: number,
  evidenceIds: number[],
  overrides: Partial<OpportunityRow> = {},
): OpportunityRow {
  return {
    id,
    runId: 11,
    name: `机会 ${id}`,
    positioning: `定位 ${id}`,
    independentSources: 3,
    evidenceIds,
    ...overrides,
  };
}

function expectOk(result: StageOutcome<S4Summary>): S4Summary {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

function expectFailure(result: StageOutcome<unknown>): { code: string; message: string } {
  if (result.ok) throw new Error('expected a failure');
  return { code: result.code, message: result.message };
}

function stored(repo: FakeRepo, opportunityId: number): DimensionScore[] {
  const rows = repo.store.get(opportunityId);
  if (rows === undefined) throw new Error(`opportunity ${opportunityId} has no scores`);
  return rows;
}

function pointsFor(rows: readonly DimensionScore[], dimension: Dimension): number {
  return rows.find((row) => row.dimension === dimension)?.points ?? -1;
}

describe('scoreS4', () => {
  it('scores every opportunity with seven dimensions and counts the decisions', async () => {
    const answers: OrdinalAnswer[] = [
      {
        acquisition: { ordinal: 2, evidenceIds: [1] },
        profit: { ordinal: 1, evidenceIds: [2] },
        feasibility: { ordinal: 1, evidenceIds: [3] },
      },
      {
        acquisition: { ordinal: 2, evidenceIds: [4] },
        profit: { ordinal: 1, evidenceIds: [5] },
        feasibility: { ordinal: 1, evidenceIds: [6] },
      },
    ];
    const { deps, events, repo } = setup({
      opportunities: [opportunity(1, [1, 2, 3]), opportunity(2, [4, 5, 6])],
      evidence: [
        evidence(1, 10),
        evidence(2, 11),
        evidence(3, 12),
        evidence(4, 20),
        evidence(5, 21),
        evidence(6, 22),
      ],
      reply: (call) => answers[call] ?? {},
    });

    const summary = expectOk(await scoreS4(context(), deps));

    expect(summary.opportunities).toBe(2);
    expect(Object.values(summary.decisions).reduce((sum, count) => sum + count, 0)).toBe(2);

    for (const id of [1, 2]) {
      const rows = stored(repo, id);
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((row) => row.dimension)).size).toBe(7);
      expect(rows.reduce((sum, row) => sum + row.points, 0)).toBeLessThanOrEqual(100);
    }

    expect(events.map((event) => event.type)).toEqual(['opportunity.scored', 'opportunity.scored']);
    expect(events[0]?.payload).toEqual({
      opportunityId: 1,
      total: 31,
      grade: 'B',
      decision: '建议调整定位',
    });
  });

  it('scores a missing ordinal as zero and records the unknown reason', async () => {
    const { deps, repo } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [evidence(1, 10), evidence(2, 11), evidence(3, 12)],
      reply: () => ({}),
    });

    expectOk(await scoreS4(context(), deps));

    const rows = stored(repo, 1);
    for (const dimension of ['acquisition', 'profit', 'feasibility'] as const) {
      expect(pointsFor(rows, dimension)).toBe(0);
    }
    expect(rows.find((row) => row.dimension === 'acquisition')?.rationale).toContain(
      'acquisition_ordinal_missing',
    );
    expect(rows.find((row) => row.dimension === 'gap')?.rationale).toContain(
      'competitors_not_collected',
    );
  });

  it('returns LLM_UNAVAILABLE and stores nothing when the rating call fails', async () => {
    const { deps, events, repo } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [evidence(1, 10), evidence(2, 11), evidence(3, 12)],
      reply: () => ({ fail: 'provider down' }),
    });

    const failure = expectFailure(await scoreS4(context(), deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).toContain('provider down');
    expect(repo.writes).toEqual([]);
    expect(repo.store.size).toBe(0);
    expect(events).toEqual([]);
  });

  it('keeps exactly seven rows when the same opportunity is scored twice', async () => {
    const { deps, repo } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [evidence(1, 10), evidence(2, 11), evidence(3, 12)],
      reply: () => ({ acquisition: { ordinal: 1, evidenceIds: [1] } }),
    });

    expectOk(await scoreS4(context(), deps));
    expectOk(await scoreS4(context(), deps));

    expect(repo.writes).toHaveLength(2);
    expect(repo.writes[0]?.scores).toHaveLength(7);
    expect(repo.writes[1]?.scores).toHaveLength(7);
    // The second write replaced the first instead of appending to it.
    expect(stored(repo, 1)).toHaveLength(7);
  });

  it('drops evidence ids the model was never shown and dedupes the rest', async () => {
    const { deps, repo } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [evidence(1, 10), evidence(2, 11), evidence(3, 12)],
      reply: () => ({
        acquisition: { ordinal: 3, evidenceIds: [999] },
        profit: { ordinal: 3, evidenceIds: [2, 2] },
      }),
    });

    expectOk(await scoreS4(context(), deps));

    const rows = stored(repo, 1);
    const acquisition = rows.find((row) => row.dimension === 'acquisition');
    const profit = rows.find((row) => row.dimension === 'profit');

    expect(acquisition?.points).toBe(0);
    expect(acquisition?.evidenceIds).toEqual([]);
    expect(acquisition?.rationale).toContain('acquisition_evidence_missing');
    expect(profit?.points).toBe(15);
    expect(profit?.evidenceIds).toEqual([2]);
  });

  it('ignores rejected evidence in both the aggregate and the prompt', async () => {
    const { deps, llm, repo } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [
        evidence(1, 10),
        evidence(2, 11, {
          signal: 'paying',
          priceMentioned: { amount: 99, currency: 'USD' },
          rejectedReason: 'quote_mismatch',
        }),
        evidence(3, 12),
      ],
      reply: () => ({}),
    });

    expectOk(await scoreS4(context(), deps));

    const rows = stored(repo, 1);
    expect(pointsFor(rows, 'needs')).toBe(6);
    expect(pointsFor(rows, 'payment')).toBe(0);
    expect(llm.prompts[0]?.user).not.toContain('id=2');
  });

  it('reaches the development decision on maximal evidence', async () => {
    const rows: ScoringEvidenceRow[] = [];
    for (let id = 1; id <= 5; id += 1) {
      rows.push(
        evidence(id, 100 + id, {
          signal: 'paying',
          priceMentioned: { amount: 99, currency: 'USD' },
        }),
      );
    }
    for (let id = 6; id <= 8; id += 1) rows.push(evidence(id, 100 + id, { signal: 'recurring' }));
    for (let id = 9; id <= 10; id += 1) rows.push(evidence(id, 100 + id));

    const { deps, events } = setup({
      opportunities: [opportunity(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])],
      evidence: rows,
      reply: () => ({
        acquisition: { ordinal: 3, evidenceIds: [1] },
        profit: { ordinal: 3, evidenceIds: [2] },
        feasibility: { ordinal: 2, evidenceIds: [3] },
      }),
    });

    expectOk(await scoreS4(context(), deps));

    expect(events[0]?.payload).toEqual({
      opportunityId: 1,
      total: 85,
      grade: 'A',
      decision: '建议开发',
    });
    expect(events[0]?.payload.total).toBeLessThanOrEqual(100);
  });

  it('sends the tier anchors and a truncated quote on the quality chain', async () => {
    const longQuote = '库'.repeat(MAX_QUOTE_IN_PROMPT + 60);
    const { deps, llm } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [evidence(1, 10, { quote: longQuote }), evidence(2, 11), evidence(3, 12)],
      reply: () => ({}),
    });

    expectOk(await scoreS4(context(), deps));

    expect(llm.profiles).toEqual(['quality']);
    const prompt = llm.prompts[0];
    expect(prompt?.system).toContain('获客可行性');
    expect(prompt?.system).toContain('技术可行性最高只有 2 档');
    expect(prompt?.system).toContain('不得输出任何分数');
    expect(prompt?.user).toContain('id=1');
    expect(prompt?.user).toContain(`quote="${'库'.repeat(MAX_QUOTE_IN_PROMPT)}"`);
    expect(prompt?.user).not.toContain(`quote="${'库'.repeat(MAX_QUOTE_IN_PROMPT)}库"`);
  });

  it('never calls the model when the opportunity has no usable evidence', async () => {
    const { deps, llm, repo } = setup({
      opportunities: [opportunity(1, [], { independentSources: 0 })],
      evidence: [],
      reply: () => ({ acquisition: { ordinal: 3, evidenceIds: [1] } }),
    });

    const summary = expectOk(await scoreS4(context(), deps));

    expect(summary.opportunities).toBe(1);
    expect(llm.prompts).toEqual([]);
    expect(stored(repo, 1).every((row) => row.points === 0)).toBe(true);
  });

  it('returns zero opportunities without calling the model when there is nothing to score', async () => {
    const { deps, llm, repo } = setup({
      opportunities: [],
      evidence: [],
      reply: () => ({}),
    });

    const summary = expectOk(await scoreS4(context(), deps));

    expect(summary).toEqual({ opportunities: 0, decisions: {} });
    expect(repo.stats.listCalls).toBe(1);
    expect(llm.prompts).toEqual([]);
  });

  it('returns DEADLINE_EXCEEDED before reading opportunities', async () => {
    const { deps, llm, repo } = setup({
      opportunities: [opportunity(1, [1])],
      evidence: [evidence(1, 10)],
      reply: () => ({}),
    });

    const failure = expectFailure(await scoreS4(context({ deadlineAt: NOW }), deps));

    expect(failure.code).toBe('DEADLINE_EXCEEDED');
    expect(repo.stats.listCalls).toBe(0);
    expect(llm.prompts).toEqual([]);
  });

  it('returns the storage failure instead of reporting stored scores', async () => {
    const { deps, events } = setup({
      opportunities: [opportunity(1, [1, 2, 3])],
      evidence: [evidence(1, 10), evidence(2, 11), evidence(3, 12)],
      writeFails: true,
      reply: () => ({}),
    });

    const failure = expectFailure(await scoreS4(context(), deps));

    expect(failure.code).toBe('STORAGE_FAILED');
    expect(failure.message).toContain('写入评分');
    expect(events).toEqual([]);
  });

  it('returns the evidence read failure without calling the model', async () => {
    const { deps, llm } = setup({
      opportunities: [opportunity(1, [1])],
      evidence: [evidence(1, 10)],
      evidenceFails: true,
      reply: () => ({}),
    });

    const failure = expectFailure(await scoreS4(context(), deps));

    expect(failure.code).toBe('STORAGE_FAILED');
    expect(failure.message).toContain('读取证据');
    expect(llm.prompts).toEqual([]);
  });
});
