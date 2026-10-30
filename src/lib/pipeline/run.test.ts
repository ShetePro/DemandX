import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import type { CrawlPort } from '@/lib/crawl/port';
import type { EvidenceExtraction, EvidenceDraft } from '@/lib/evidence/schema';
import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import { fail, ok, type Result } from '@/lib/quota/types';
import type {
  ExtractionSource,
  InsertEvidenceInput,
  InsertEvidenceOutcome,
} from '@/lib/runs/evidence-repository';
import type { InsertSourceInput } from '@/lib/runs/sources-repository';
import type { SearchHit, SearchPort } from '@/lib/search/port';

import type { RunContext } from './context';
import { runPipeline, type PipelineDeps } from './run';

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

interface Event {
  type: string;
  payload: Record<string, unknown>;
}

interface Harness {
  deps: PipelineDeps;
  events: Event[];
  s1Rows: InsertSourceInput[];
  s2Rows: InsertEvidenceInput[];
  profiles: Profile[];
  llmCalls: number;
}

interface HarnessOptions {
  /** The first `listSourceUrls` call fails, which is how S1 dies before searching. */
  failListSourceUrls?: boolean;
  /** Sources the S2 repository reports; defaults to what S1 inserted. */
  extractionSources?: ExtractionSource[];
  /** Answers the n-th extraction call; `fail` reports LLM_UNAVAILABLE. */
  reply?: (call: number) => Answer;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const events: Event[] = [];
  const s1Rows: InsertSourceInput[] = [];
  const s2Rows: InsertEvidenceInput[] = [];
  const urlsByRun = new Map<number, string[]>();
  const profiles: Profile[] = [];
  let nextSourceId = 1;
  let llmCalls = 0;

  const search: SearchPort = {
    id: 'fake-search',
    platform: 'web',
    async search(): Promise<SearchHit[]> {
      return [
        {
          url: 'https://example.com/a',
          title: '页面',
          snippet: '摘要',
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
      _schema: ZodType<T>,
      prompt: Prompt,
      callOptions: { profile: Profile },
    ): Promise<LlmResult<{ data: T; used: ChainItem; usage: Usage }>> {
      llmCalls += 1;
      if (prompt.user.length === 0) throw new Error('prompt body is empty');
      profiles.push(callOptions.profile);
      const answer = (options.reply ?? (() => ({ items: [draft(QUOTE)] })))(llmCalls - 1);
      if ('fail' in answer) {
        return { ok: false, code: 'LLM_UNAVAILABLE', message: answer.fail };
      }
      return {
        ok: true,
        value: { data: answer as unknown as T, used: USED, usage: { in: 0, out: 0 } },
      };
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
    onEvent: async (type, payload) => {
      events.push({ type, payload });
    },
  };

  return {
    deps,
    events,
    s1Rows,
    s2Rows,
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
      value: { sources: 1, skipped: 0, accepted: 1, rejected: 0 },
    });
    expect(fake.s2Rows).toHaveLength(1);
    expect(fake.s2Rows[0]?.rejectedReason).toBeNull();
    expect(fake.profiles).toEqual(['bulk']);
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
    });
    expect(outcome.message).toContain('sources=1');
    expect(fake.llmCalls).toBe(5);

    const finished = fake.events.find(
      (event) => event.type === 'stage.finished' && event.payload.stage === 'S2',
    );
    expect(finished?.payload).toMatchObject({ status: 'failed', code: 'LLM_UNAVAILABLE' });
  });

  it('emits one ordered started/finished pair per stage', async () => {
    const fake = harness();

    await runPipeline(CTX, fake.deps);

    expect(stageEvents(fake.events)).toEqual([
      'stage.started:S1',
      'stage.finished:S1',
      'stage.started:S2',
      'stage.finished:S2',
    ]);
  });
});
