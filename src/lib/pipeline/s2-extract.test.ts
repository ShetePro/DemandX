import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import type { EvidenceExtraction, EvidenceDraft } from '@/lib/evidence/schema';
import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import { ok, type Result } from '@/lib/quota/types';
import type {
  ExtractionSource,
  InsertEvidenceInput,
  InsertEvidenceOutcome,
} from '@/lib/runs/evidence-repository';

import type { RunContext, StageOutcome } from './context';
import {
  MAX_CONSECUTIVE_FAILURES,
  MIN_REJECTION_SAMPLE,
  extractS2,
  type ExtractDeps,
  type S2Summary,
} from './s2-extract';

const NOW = new Date('2026-10-30T12:00:00.000Z');

const USED: ChainItem = {
  providerId: 1,
  providerName: 'fake',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: 'qwen3:8b',
  headers: {},
};

type Answer = { fail: string } | EvidenceExtraction;

interface FakeLlm {
  port: LlmPort;
  prompts: Prompt[];
  profiles: Profile[];
}

/** Answers the n-th extraction call; `fail` makes the port report LLM_UNAVAILABLE. */
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
      throw new Error('S2 must only use structured()');
    },
  };

  return { port, prompts, profiles };
}

interface FakeRepo {
  listSources: ExtractDeps['repo']['listSources'];
  insertEvidence: ExtractDeps['repo']['insertEvidence'];
  rows: InsertEvidenceInput[];
  stats: { listCalls: number };
}

/** Mirrors the `(run_id, source_id, quote)` unique index: a repeat returns the stored id. */
function createRepo(sources: readonly ExtractionSource[]): FakeRepo {
  const rows: InsertEvidenceInput[] = [];
  const ids = new Map<string, number>();
  const stats = { listCalls: 0 };

  return {
    rows,
    stats,
    async listSources(_runId, limit) {
      stats.listCalls += 1;
      return ok(sources.slice(0, limit));
    },
    async insertEvidence(input): Promise<Result<InsertEvidenceOutcome>> {
      const key = `${input.runId}|${input.sourceId}|${input.quote}`;
      const existing = ids.get(key);
      if (existing !== undefined) return ok({ id: existing, inserted: false });

      const id = ids.size + 1;
      ids.set(key, id);
      rows.push(input);
      return ok({ id, inserted: true });
    },
  };
}

function source(id: number): ExtractionSource {
  return {
    id,
    canonicalUrl: `https://example.com/post/${id}`,
    platform: 'web',
    snapshotPath: `/tmp/snapshots/${id}.txt.gz`,
    contentHash: String(id).padStart(64, 'a'),
  };
}

function draft(quote: string, overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    quote,
    signal: 'problem',
    firstHand: true,
    publishedAt: null,
    priceMentioned: null,
    supports: '作者在描述自己的问题',
    doesNotProve: '不能证明这个问题有多普遍',
    ...overrides,
  };
}

interface EventRecord {
  type: string;
  payload: Record<string, unknown>;
}

function setup(options: {
  sources: readonly ExtractionSource[];
  snapshots: ReadonlyMap<number, string>;
  reply: (call: number) => Answer;
  deps?: Partial<ExtractDeps>;
}): {
  deps: ExtractDeps;
  events: EventRecord[];
  repo: FakeRepo;
  llm: FakeLlm;
} {
  const llm = createLlm(options.reply);
  const repo = createRepo(options.sources);
  const events: EventRecord[] = [];

  const deps: ExtractDeps = {
    llm: llm.port,
    repo,
    readSnapshot: async (item) => options.snapshots.get(item.id) ?? null,
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
    runId: 7,
    idea: '跨境库存同步',
    angles: [],
    deadlineAt: null,
    ...overrides,
  };
}

function expectOk(result: StageOutcome<S2Summary>): S2Summary {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

function expectFailure(result: StageOutcome<unknown>): { code: string; message: string } {
  if (result.ok) throw new Error('expected a failure');
  return { code: result.code, message: result.message };
}

function eventsOf(events: readonly EventRecord[], type: string): Record<string, unknown>[] {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

describe('extractS2', () => {
  it('stores exact quotes as accepted and keeps a paraphrase as a rejection with its reason', async () => {
    const pages = [source(1), source(2), source(3)];
    const snapshots = new Map([
      [1, '我在三个平台之间手工同步库存，每天要花两个小时。'],
      [2, '每次改价格都要登录四个后台，太麻烦了。'],
      [3, '原文是三个平台库存同步很麻烦。'],
    ]);

    const { deps, events, repo } = setup({
      sources: pages,
      snapshots,
      reply: (call) =>
        call === 2
          ? { items: [draft('多平台库存同步非常麻烦')] }
          : {
              items: [
                draft(call === 0 ? '我在三个平台之间手工同步库存' : '每次改价格都要登录四个后台'),
              ],
            },
    });

    const summary = expectOk(await extractS2(context(), deps));

    expect(summary).toEqual({ accepted: 2, rejected: 1, failedSources: 0 });
    expect(repo.rows).toHaveLength(3);

    const rejectedRow = repo.rows[2];
    expect(rejectedRow).toMatchObject({
      sourceId: 3,
      quote: '多平台库存同步非常麻烦',
      rejectedReason: 'quote_not_in_snapshot',
      quoteOffset: null,
      platform: 'web',
    });
    expect(rejectedRow?.supports).toBe('作者在描述自己的问题');

    const acceptedRow = repo.rows[0];
    expect(acceptedRow?.rejectedReason).toBeNull();
    expect(acceptedRow?.quoteOffset).toBe(0);

    const progress = eventsOf(events, 'stage.progress');
    expect(progress).toHaveLength(3);
    expect(progress.at(-1)).toEqual({ stage: 'S2', done: 3, total: 3, accepted: 2, rejected: 1 });
  });

  it('asks the bulk profile with the page URL and snapshot as prompt input', async () => {
    const page = source(1);
    const text = '我已经为这个功能付过两次钱了，不想再换工具。';

    const { deps, llm } = setup({
      sources: [page],
      snapshots: new Map([[1, text]]),
      reply: () => ({ items: [draft('我已经为这个功能付过两次钱了')] }),
    });

    expectOk(await extractS2(context(), deps));

    expect(llm.profiles).toEqual(['bulk']);
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]?.user).toContain(page.canonicalUrl);
    expect(llm.prompts[0]?.user).toContain(text);
  });

  it('stops with LLM_UNAVAILABLE after five consecutive extraction failures', async () => {
    const pages = [1, 2, 3, 4, 5, 6, 7].map(source);
    const { deps, events, llm } = setup({
      sources: pages,
      snapshots: new Map(pages.map((page) => [page.id, `第${page.id}页正文，足够长。`])),
      reply: () => ({ fail: 'provider down' }),
    });

    const failure = expectFailure(await extractS2(context(), deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).toContain('provider down');
    expect(llm.prompts).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(eventsOf(events, 'source.failed')).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(eventsOf(events, 'stage.progress')).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });

  it('aborts once more than half of the calls fail, even without a streak', async () => {
    const pages = [1, 2, 3, 4, 5, 6, 7, 8].map(source);
    // ok, fail, ok, fail, ok, fail, fail → the seventh call crosses 50%.
    const failing = new Set([1, 3, 5, 6]);

    const { deps, llm } = setup({
      sources: pages,
      snapshots: new Map(pages.map((page) => [page.id, `第${page.id}页正文，足够长。`])),
      reply: (call) => (failing.has(call) ? { fail: 'flaky' } : { items: [] }),
    });

    const failure = expectFailure(await extractS2(context(), deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(llm.prompts).toHaveLength(7);
  });

  it('returns DEADLINE_EXCEEDED before listing sources when the deadline has passed', async () => {
    const { deps, llm, repo } = setup({
      sources: [source(1)],
      snapshots: new Map([[1, '正文。']]),
      reply: () => ({ items: [] }),
    });

    const failure = expectFailure(await extractS2(context({ deadlineAt: NOW }), deps));

    expect(failure.code).toBe('DEADLINE_EXCEEDED');
    expect(repo.stats.listCalls).toBe(0);
    expect(llm.prompts).toHaveLength(0);
  });

  it('checks the deadline before every page, keeping what the earlier pages stored', async () => {
    const pages = [source(1), source(2)];
    // Entrance, page 1 and page 2 read three distinct instants: only the last
    // one is past the deadline, so page 1 must have been processed.
    const instants = [NOW.getTime() - 2000, NOW.getTime() - 1000, NOW.getTime() + 1000];
    let read = 0;

    const { deps, llm, repo } = setup({
      sources: pages,
      snapshots: new Map([
        [1, '第一页正文，有可以引用的话。'],
        [2, '第二页正文，也有可以引用的话。'],
      ]),
      reply: () => ({ items: [draft('第一页正文')] }),
      deps: {
        now: () => new Date(instants[read++] ?? NOW.getTime()),
      },
    });

    const failure = expectFailure(await extractS2(context({ deadlineAt: NOW }), deps));

    expect(failure.code).toBe('DEADLINE_EXCEEDED');
    expect(llm.prompts).toHaveLength(1);
    expect(repo.rows).toHaveLength(1);
  });

  it('reports a missing snapshot as a failed source and never calls the model for it', async () => {
    const pages = [source(1), source(2)];

    const { deps, events, llm } = setup({
      sources: pages,
      snapshots: new Map([[2, '第二页有快照，可以抽取。']]),
      reply: () => ({ items: [draft('第二页有快照')] }),
    });

    const summary = expectOk(await extractS2(context(), deps));

    expect(summary).toEqual({ accepted: 1, rejected: 0, failedSources: 1 });
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]?.user).toContain(pages[1]?.canonicalUrl);

    const failures = eventsOf(events, 'source.failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'S2',
      sourceId: 1,
      code: 'SNAPSHOT_MISSING',
      url: pages[0]?.canonicalUrl,
    });
  });

  it('treats a throwing snapshot reader as a failed source instead of aborting the stage', async () => {
    const pages = [source(1), source(2)];

    const { deps, events, llm } = setup({
      sources: pages,
      snapshots: new Map([[2, '第二页有快照，可以抽取。']]),
      reply: () => ({ items: [draft('第二页有快照')] }),
      deps: {
        readSnapshot: async (item) => {
          if (item.id === 1) throw new Error('EACCES');
          return '第二页有快照，可以抽取。';
        },
      },
    });

    const summary = expectOk(await extractS2(context(), deps));

    expect(summary.failedSources).toBe(1);
    expect(summary.accepted).toBe(1);
    expect(llm.prompts).toHaveLength(1);
    expect(eventsOf(events, 'source.failed')[0]).toMatchObject({
      code: 'SNAPSHOT_FAILED',
      message: 'EACCES',
    });
  });

  it('warns about a high rejection rate once the sample is large enough', async () => {
    const pages = [1, 2, 3, 4].map(source);
    const snapshots = new Map(
      pages.map((page) => [
        page.id,
        `第${page.id}页原话一。第${page.id}页原话二。第${page.id}页原话三。`,
      ]),
    );

    const { deps, events } = setup({
      sources: pages,
      snapshots,
      reply: (call) => {
        const page = pages[call];
        if (page === undefined) return { items: [] };

        if (call < 2) {
          return {
            items: [1, 2, 3].map((index) => draft(`第${page.id}页原话${'一二三'[index - 1]}`)),
          };
        }
        return {
          items: [1, 2, 3].map((index) => draft(`改写过的第${page.id}页句子${index}`)),
        };
      },
    });

    const summary = expectOk(await extractS2(context(), deps));

    expect(summary).toEqual({ accepted: 6, rejected: 6, failedSources: 0 });
    const warnings = eventsOf(events, 'stage.warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({ stage: 'S2', code: 'high_rejection_rate', rate: 0.5 });
  });

  it('stays quiet when the rejection sample is below the warning threshold', async () => {
    const page = source(1);

    const { deps, events } = setup({
      sources: [page],
      snapshots: new Map([[1, '一句原文写在这里，足够长。']]),
      reply: () => ({ items: [draft('一句原文写在这里'), draft('这是模型改写的内容')] }),
    });

    const summary = expectOk(await extractS2(context(), deps));

    expect(summary).toEqual({ accepted: 1, rejected: 1, failedSources: 0 });
    expect(MIN_REJECTION_SAMPLE).toBeGreaterThan(2);
    expect(eventsOf(events, 'stage.warning')).toEqual([]);
  });

  it('never stores more than three candidates from one page', async () => {
    const page = source(1);
    const quotes = ['原话甲乙丙丁一', '原话甲乙丙丁二', '原话甲乙丙丁三', '原话甲乙丙丁四'];

    const { deps, repo } = setup({
      sources: [page],
      snapshots: new Map([[1, `${quotes.join('。')}。`]]),
      // A model that ignores the schema limit is still capped here.
      reply: () => ({
        items: quotes.map((quote) => draft(quote)),
      }),
    });

    const summary = expectOk(await extractS2(context(), deps));

    expect(summary.accepted).toBe(3);
    expect(repo.rows).toHaveLength(3);
  });

  it('does not count a duplicate verdict twice', async () => {
    const page = source(1);
    const { deps, repo } = setup({
      sources: [page],
      snapshots: new Map([[1, '同一句原文被抽了两次，足够长。']]),
      reply: () => ({ items: [draft('同一句原文被抽了两次')] }),
    });

    expectOk(await extractS2(context(), deps));
    const second = expectOk(await extractS2(context(), deps));

    expect(second).toEqual({ accepted: 0, rejected: 0, failedSources: 0 });
    expect(repo.rows).toHaveLength(1);
  });
});
