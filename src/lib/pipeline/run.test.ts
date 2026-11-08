import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import type { CrawlPort } from '@/lib/crawl/port';
import {
  evidenceExtractionSchema,
  type EvidenceExtraction,
  type EvidenceDraft,
} from '@/lib/evidence/schema';
import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import { fail, ok, type Result } from '@/lib/quota/types';
import { exploratoryReportSchema, reportSectionsSchema } from '@/lib/report/assemble';
import type { SaveReportInput } from '@/lib/report/persist';
import { REPORT_SECTIONS } from '@/lib/report/validate';
import type {
  ExtractionSource,
  InsertEvidenceInput,
  InsertEvidenceOutcome,
  ScoringEvidenceRow,
} from '@/lib/runs/evidence-repository';
import type {
  AcceptedEvidence,
  InsertOpportunityInput,
  OpportunityRow,
} from '@/lib/runs/opportunities-repository';
import type { InsertSourceInput } from '@/lib/runs/sources-repository';
import type { DimensionScore } from '@/lib/scoring/types';
import type { SearchHit, SearchPort } from '@/lib/search/port';

import type { RunContext } from './context';
import { runPipeline, type PipelineDeps } from './run';
import { clusteringSchema } from './s3-cluster';
import { ordinalsSchema } from './s4-score';

const SNAPSHOT_TEXT = '多平台库存不同步导致超卖，卖家因此损失订单。人工改库存又容易出错。';
const QUOTE = '多平台库存不同步导致超卖';

const CTX: RunContext = {
  runId: 1,
  idea: '跨境库存同步',
  angles: [],
  deadlineAt: null,
};

const USED: ChainItem = {
  providerId: 1,
  providerName: 'fake',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: 'qwen3:8b',
  headers: {},
};

type Answer = { fail: string } | EvidenceExtraction;

function draft(quote: string, overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    quote,
    signal: 'problem',
    firstHand: true,
    publishedAt: null,
    priceMentioned: null,
    supports: '支持问题存在',
    doesNotProve: '不能证明付费意愿',
    ...overrides,
  };
}

/** A valid eight-part answer; S5 only asks for it when an opportunity exists. */
function reportAnswer(ids: readonly number[]): unknown {
  const cited = [ids[0] ?? 1];
  const sections: Record<string, unknown> = {};
  for (const key of REPORT_SECTIONS) {
    sections[key] = { claims: [{ text: '卖家在手工同步库存', evidenceIds: cited }], unknowns: [] };
  }
  return { sections };
}

interface Event {
  type: string;
  payload: Record<string, unknown>;
}

interface Harness {
  deps: PipelineDeps;
  events: Event[];
  s1Rows: InsertSourceInput[];
  s2Rows: InsertEvidenceInput[];
  opportunities: OpportunityRow[];
  reportSaves: SaveReportInput[];
  profiles: Profile[];
  llmCalls: number;
}

interface HarnessOptions {
  /** The first `listSourceUrls` call fails, which is how S1 dies before searching. */
  failListSourceUrls?: boolean;
  /** S3 cannot list accepted evidence, so the run must stop before S4. */
  failS3?: boolean;
  /** Sources the S2 repository reports; defaults to what S1 inserted. */
  extractionSources?: ExtractionSource[];
  /** Answers the n-th extraction call; `fail` reports LLM_UNAVAILABLE. */
  reply?: (call: number) => Answer;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: Event[] = [];
  const s1Rows: InsertSourceInput[] = [];
  const s2Rows: InsertEvidenceInput[] = [];
  const opportunities: OpportunityRow[] = [];
  const scoresByOpportunity = new Map<number, DimensionScore[]>();
  const reportSaves: SaveReportInput[] = [];
  const urlsByRun = new Map<number, string[]>();
  const profiles: Profile[] = [];
  let nextSourceId = 1;
  let nextOpportunityId = 1;
  let llmCalls = 0;

  /** What S2 stored, as later stages read it back. */
  function evidenceRows(): ScoringEvidenceRow[] {
    return s2Rows.map((row, index) => ({
      id: index + 1,
      sourceId: row.sourceId,
      signal: row.signal,
      platform: row.platform,
      quote: row.quote,
      priceMentioned: row.priceMentioned,
      rejectedReason: row.rejectedReason,
      supports: row.supports,
    }));
  }

  const search: SearchPort = {
    id: 'fake-search',
    platform: 'web',
    async search(): Promise<SearchHit[]> {
      return [
        {
          url: 'https://example.com/a',
          title: '跨境库存同步工具',
          snippet: '每天手工同步库存太麻烦，愿意付费。',
          platform: 'web',
        },
      ];
    },
  };

  const crawl: CrawlPort = {
    async crawl(url) {
      return {
        status: 'ok',
        snapshot: { url, html: `<p>${SNAPSHOT_TEXT}</p>`, text: SNAPSHOT_TEXT, title: '页面' },
      };
    },
  };

  const llm: LlmPort = {
    async structured<T>(
      schema: ZodType<T>,
      prompt: Prompt,
      callOptions: { profile: Profile },
    ): Promise<LlmResult<{ data: T; used: ChainItem; usage: Usage }>> {
      llmCalls += 1;
      if (prompt.user.length === 0) throw new Error('prompt body is empty');
      profiles.push(callOptions.profile);

      const reply = (answer: unknown): LlmResult<{ data: T; used: ChainItem; usage: Usage }> => ({
        ok: true,
        value: { data: answer as T, used: USED, usage: { in: 0, out: 0 } },
      });

      if ((schema as unknown) === evidenceExtractionSchema) {
        const answer = (options.reply ?? (() => ({ items: [draft(QUOTE)] })))(llmCalls - 1);
        if ('fail' in answer) {
          return { ok: false, code: 'LLM_UNAVAILABLE', message: answer.fail };
        }
        return reply(answer);
      }

      if ((schema as unknown) === clusteringSchema) {
        const ids = evidenceRows()
          .filter((row) => row.rejectedReason === null)
          .map((row) => row.id);
        return reply({
          clusters: [{ name: '库存同步', positioning: '多平台库存同步', evidenceIds: ids }],
        });
      }

      // S4's ordinal answer: no tier chosen, so every ordinal dimension is 0.
      if ((schema as unknown) === ordinalsSchema) return reply({});

      if (
        (schema as unknown) === reportSectionsSchema ||
        (schema as unknown) === exploratoryReportSchema
      ) {
        const ids =
          opportunities.length > 0
            ? opportunities.flatMap((opportunity) => opportunity.evidenceIds)
            : evidenceRows()
                .filter((row) => row.rejectedReason === null)
                .map((row) => row.id);
        return reply(reportAnswer(ids));
      }

      throw new Error('unexpected structured() schema');
    },
    async text(): Promise<never> {
      throw new Error('pipeline stages never call text()');
    },
  };

  const extractionRepo = {
    async listSources(_runId: number, limit: number): Promise<Result<ExtractionSource[]>> {
      if (options.extractionSources !== undefined) {
        return ok(options.extractionSources.slice(0, limit));
      }
      const sources = s1Rows.map((row, index) => ({
        id: index + 1,
        canonicalUrl: row.canonicalUrl,
        platform: row.platform,
        snapshotPath: row.snapshotPath ?? null,
        contentHash: row.contentHash,
      }));
      return ok(sources.slice(0, limit));
    },
    async insertEvidence(input: InsertEvidenceInput): Promise<Result<InsertEvidenceOutcome>> {
      s2Rows.push(input);
      return ok({ id: s2Rows.length, inserted: true });
    },
  };

  const deps: PipelineDeps = {
    s1: {
      searchPorts: [search],
      crawl,
      quota: {
        async claim(): Promise<Result<unknown>> {
          return ok(undefined);
        },
      },
      repo: {
        async insertSource(input): Promise<Result<{ id: number; inserted: boolean }>> {
          s1Rows.push(input);
          const urls = urlsByRun.get(input.runId) ?? [];
          urls.push(input.canonicalUrl);
          urlsByRun.set(input.runId, urls);
          return ok({ id: nextSourceId++, inserted: true });
        },
        async listSourceUrls(runId): Promise<Result<string[]>> {
          if (options.failListSourceUrls === true) {
            return fail('STORAGE_FAILED', '读取已有来源失败');
          }
          return ok([...(urlsByRun.get(runId) ?? [])]);
        },
      },
    },
    s2: {
      llm,
      repo: extractionRepo,
      async readSnapshot(): Promise<string | null> {
        return SNAPSHOT_TEXT;
      },
    },
    s3: {
      llm,
      repo: {
        async listAcceptedEvidence(): Promise<Result<AcceptedEvidence[]>> {
          if (options.failS3 === true) return fail('STORAGE_FAILED', '读取已接受证据失败');
          return ok(
            evidenceRows()
              .filter((row) => row.rejectedReason === null)
              .map((row) => ({
                id: row.id,
                signal: row.signal,
                platform: row.platform,
                supports: row.supports ?? null,
                quote: row.quote,
                sourceId: row.sourceId,
                canonicalUrl: `https://example.com/${row.sourceId}`,
              })),
          );
        },
        async insertOpportunity(input: InsertOpportunityInput): Promise<Result<{ id: number }>> {
          const id = nextOpportunityId;
          nextOpportunityId += 1;
          opportunities.push({
            id,
            runId: input.runId,
            name: input.name,
            positioning: input.positioning,
            independentSources: input.independentSources,
            evidenceIds: input.evidenceIds,
          });
          return ok({ id });
        },
      },
    },
    s4: {
      llm,
      repo: {
        async listOpportunities(): Promise<Result<OpportunityRow[]>> {
          return ok([...opportunities]);
        },
        async listEvidenceByIds(ids): Promise<Result<ScoringEvidenceRow[]>> {
          return ok(evidenceRows().filter((row) => ids.includes(row.id)));
        },
        async replaceScores(opportunityId, scores): Promise<Result<void>> {
          scoresByOpportunity.set(opportunityId, [...scores]);
          return ok(undefined);
        },
      },
    },
    s5: {
      llm,
      repo: {
        async listOpportunities(): Promise<Result<OpportunityRow[]>> {
          return ok([...opportunities]);
        },
        async listScores(opportunityId): Promise<Result<DimensionScore[]>> {
          return ok([...(scoresByOpportunity.get(opportunityId) ?? [])]);
        },
        async listEvidenceByIds(ids): Promise<Result<ScoringEvidenceRow[]>> {
          return ok(evidenceRows().filter((row) => ids.includes(row.id)));
        },
        async listAcceptedEvidence(): Promise<Result<AcceptedEvidence[]>> {
          return ok(
            evidenceRows()
              .filter((row) => row.rejectedReason === null)
              .map((row) => ({
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
          reportSaves.push(input);
          return ok({ reportId: 42 });
        },
      },
    },
    onEvent: async (type, payload) => {
      events.push({ type, payload });
    },
  };

  return {
    deps,
    events,
    s1Rows,
    s2Rows,
    opportunities,
    reportSaves,
    profiles,
    get llmCalls() {
      return llmCalls;
    },
  };
}

function stageEvents(events: readonly Event[]): string[] {
  return events
    .filter((event) => event.type === 'stage.started' || event.type === 'stage.finished')
    .map((event) => `${event.type}:${String(event.payload.stage)}`);
}

describe('runPipeline', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'demandx-run-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function harness(options: HarnessOptions = {}): Harness {
    const created = createHarness(options);
    created.deps.s1.snapshotDir = dir;
    return created;
  }

  it('merges S1 and S2 metrics when both stages succeed', async () => {
    const fake = harness();

    const outcome = await runPipeline(CTX, fake.deps);

    expect(outcome).toEqual({
      ok: true,
      value: {
        sources: 1,
        skipped: 0,
        accepted: 1,
        rejected: 0,
        opportunities: 0,
        scored: 0,
        reportId: 42,
      },
    });
    expect(fake.s2Rows).toHaveLength(1);
    expect(fake.s2Rows[0]?.rejectedReason).toBeNull();
    expect(fake.profiles).toEqual(['bulk', 'quality', 'bulk']);
  });

  it('does not start S2 when S1 fails', async () => {
    const fake = harness({ failListSourceUrls: true });

    const outcome = await runPipeline(CTX, fake.deps);

    expect(outcome).toMatchObject({
      ok: false,
      code: 'STORAGE_FAILED',
      summary: { sources: 0, skipped: 0, accepted: 0, rejected: 0 },
    });
    expect(fake.llmCalls).toBe(0);
    expect(stageEvents(fake.events)).toEqual(['stage.started:S1', 'stage.finished:S1']);
  });

  it('returns S2 code while keeping the S1 metrics on the failure', async () => {
    const fake = harness({
      reply: () => ({ fail: 'bulk 链为空' }),
      extractionSources: [1, 2, 3, 4, 5].map((id) => ({
        id,
        canonicalUrl: `https://example.com/${id}`,
        platform: 'web',
        snapshotPath: null,
        contentHash: String(id).padStart(64, 'a'),
      })),
    });

    const outcome = await runPipeline(CTX, fake.deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('LLM_UNAVAILABLE');
    expect(outcome.summary).toEqual({
      sources: 1,
      skipped: 0,
      accepted: 0,
      rejected: 0,
      opportunities: 0,
      scored: 0,
      reportId: null,
    });
    expect(outcome.message).toContain('sources=1');
    expect(fake.llmCalls).toBe(5);

    const finished = fake.events.find(
      (event) => event.type === 'stage.finished' && event.payload.stage === 'S2',
    );
    expect(finished?.payload).toMatchObject({ status: 'failed', code: 'LLM_UNAVAILABLE' });
  });

  it('emits one ordered started/finished pair per stage, S1 through S6', async () => {
    const fake = harness();

    await runPipeline(CTX, fake.deps);

    expect(stageEvents(fake.events)).toEqual([
      'stage.started:S1',
      'stage.finished:S1',
      'stage.started:S2',
      'stage.finished:S2',
      'stage.started:S3',
      'stage.finished:S3',
      'stage.started:S4',
      'stage.finished:S4',
      'stage.started:S5',
      'stage.finished:S5',
      'stage.started:S6',
      'stage.finished:S6',
    ]);
    expect(fake.events.at(-1)?.type).toBe('report.ready');
  });

  it('runs clustering, scoring and the report into one stored report', async () => {
    const fake = harness({
      extractionSources: [1, 2, 3].map((id) => ({
        id,
        canonicalUrl: `https://example.com/${id}`,
        platform: 'web',
        snapshotPath: null,
        contentHash: String(id).padStart(64, 'a'),
      })),
    });

    const outcome = await runPipeline(CTX, fake.deps);

    expect(outcome).toEqual({
      ok: true,
      value: {
        sources: 1,
        skipped: 0,
        accepted: 3,
        rejected: 0,
        opportunities: 1,
        scored: 1,
        reportId: 42,
      },
    });
    expect(fake.opportunities).toHaveLength(1);
    expect(fake.opportunities[0]?.independentSources).toBe(3);
    expect(fake.reportSaves).toHaveLength(1);
    // needs=11 (3 sources), every ordinal 0: S4's total, not the model's.
    expect(fake.reportSaves[0]?.total).toBe(11);
    expect(fake.reportSaves[0]?.sections.summary?.claims).toHaveLength(1);
  });

  it('stops before S4 when S3 fails', async () => {
    const fake = harness({ failS3: true });

    const outcome = await runPipeline(CTX, fake.deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('STORAGE_FAILED');
    expect(stageEvents(fake.events)).toEqual([
      'stage.started:S1',
      'stage.finished:S1',
      'stage.started:S2',
      'stage.finished:S2',
      'stage.started:S3',
      'stage.finished:S3',
    ]);
    expect(fake.reportSaves).toEqual([]);
    expect(fake.opportunities).toEqual([]);
  });
});
