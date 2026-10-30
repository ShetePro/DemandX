import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import type { ChainItem, LlmPort, Profile, Prompt, Usage } from '@/lib/llm/port';
import type { Result as LlmResult } from '@/lib/llm/types';
import { ok, type Result } from '@/lib/quota/types';
import type { AcceptedEvidence, InsertOpportunityInput } from '@/lib/runs/opportunities-repository';

import type { RunContext, StageOutcome } from './context';
import {
  MAX_QUOTE_IN_PROMPT,
  MIN_INDEPENDENT_SOURCES,
  clusterS3,
  type ClusterDeps,
  type Clustering,
  type S3Summary,
} from './s3-cluster';

const NOW = new Date('2026-10-30T12:00:00.000Z');

const USED: ChainItem = {
  providerId: 2,
  providerName: 'fake',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: 'qwen3:14b',
  headers: {},
};

type Answer = { fail: string } | Clustering;

interface FakeLlm {
  port: LlmPort;
  prompts: Prompt[];
  profiles: Profile[];
}

/** Answers the n-th clustering call; `fail` makes the port report LLM_UNAVAILABLE. */
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
      throw new Error('S3 must only use structured()');
    },
  };

  return { port, prompts, profiles };
}

interface FakeRepo {
  listAcceptedEvidence: ClusterDeps['repo']['listAcceptedEvidence'];
  insertOpportunity: ClusterDeps['repo']['insertOpportunity'];
  rows: InsertOpportunityInput[];
  stats: { listCalls: number };
}

function createRepo(evidence: readonly AcceptedEvidence[], insertFails = false): FakeRepo {
  const rows: InsertOpportunityInput[] = [];
  const stats = { listCalls: 0 };

  return {
    rows,
    stats,
    async listAcceptedEvidence(): Promise<Result<AcceptedEvidence[]>> {
      stats.listCalls += 1;
      return ok([...evidence]);
    },
    async insertOpportunity(input): Promise<Result<{ id: number }>> {
      if (insertFails) return { ok: false, code: 'STORAGE_FAILED', message: '写入机会失败' };
      rows.push(input);
      return ok({ id: rows.length });
    },
  };
}

interface EventRecord {
  type: string;
  payload: Record<string, unknown>;
}

function setup(options: {
  evidence: readonly AcceptedEvidence[];
  reply: (call: number) => Answer;
  insertFails?: boolean;
  deps?: Partial<ClusterDeps>;
}): {
  deps: ClusterDeps;
  events: EventRecord[];
  repo: FakeRepo;
  llm: FakeLlm;
} {
  const llm = createLlm(options.reply);
  const repo = createRepo(options.evidence, options.insertFails ?? false);
  const events: EventRecord[] = [];

  const deps: ClusterDeps = {
    llm: llm.port,
    repo,
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

function accepted(
  id: number,
  sourceId: number,
  overrides: Partial<AcceptedEvidence> = {},
): AcceptedEvidence {
  return {
    id,
    signal: 'problem',
    platform: 'v2ex',
    supports: `证据 ${id} 支持的问题`,
    quote: `第 ${id} 条证据的原话`,
    sourceId,
    canonicalUrl: `https://example.com/p/${sourceId}`,
    ...overrides,
  };
}

function cluster(
  name: string,
  evidenceIds: number[],
  positioning = '面向小团队的库存同步工具',
): Clustering['clusters'][number] {
  return { name, positioning, evidenceIds };
}

function expectOk(result: StageOutcome<S3Summary>): S3Summary {
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

describe('clusterS3', () => {
  it('creates an opportunity when three independent sources back one cluster', async () => {
    const evidence = [accepted(1, 10), accepted(2, 11), accepted(3, 12)];
    const { deps, events, llm, repo } = setup({
      evidence,
      reply: () => ({ clusters: [cluster('库存同步', [1, 2, 3])] }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 1, dropped: 0 });
    expect(repo.rows).toEqual([
      {
        runId: 11,
        name: '库存同步',
        positioning: '面向小团队的库存同步工具',
        independentSources: 3,
        evidenceIds: [1, 2, 3],
      },
    ]);

    // Clustering is the one quality-profile call of this stage.
    expect(llm.profiles).toEqual(['quality']);

    const created = eventsOf(events, 'cluster.created');
    expect(created).toEqual([
      {
        stage: 'S3',
        opportunityId: 1,
        name: '库存同步',
        positioning: '面向小团队的库存同步工具',
        independentSources: 3,
        evidenceIds: [1, 2, 3],
      },
    ]);
    expect(eventsOf(events, 'cluster.dropped')).toEqual([]);
  });

  it('drops a cluster backed by only two sources and never stores it', async () => {
    expect(MIN_INDEPENDENT_SOURCES).toBe(3);

    const evidence = [accepted(1, 10), accepted(2, 11)];
    const { deps, events, repo } = setup({
      evidence,
      reply: () => ({ clusters: [cluster('只看了一眼', [1, 2])] }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 0, dropped: 1 });
    expect(repo.rows).toEqual([]);
    expect(eventsOf(events, 'cluster.created')).toEqual([]);

    const dropped = eventsOf(events, 'cluster.dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      stage: 'S3',
      name: '只看了一眼',
      independentSources: 2,
      evidenceIds: [1, 2],
      reason: 'insufficient_independence',
    });
  });

  it('drops a hallucinated evidence id before counting the sources', async () => {
    // Two pages, one of which supplied two quotes; the model adds a third id
    // that does not exist and would otherwise make the cluster look independent.
    const evidence = [accepted(1, 10), accepted(2, 10), accepted(3, 11)];
    const { deps, events, repo } = setup({
      evidence,
      reply: () => ({ clusters: [cluster('编造出来的第三页', [1, 2, 3, 999])] }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 0, dropped: 1 });
    expect(repo.rows).toEqual([]);

    const dropped = eventsOf(events, 'cluster.dropped');
    expect(dropped[0]).toMatchObject({
      independentSources: 2,
      evidenceIds: [1, 2, 3],
    });
  });

  it('counts one page once even when it supplies several quotes', async () => {
    // Four evidence rows over two pages: volume is not independence.
    const evidence = [accepted(1, 10), accepted(2, 10), accepted(3, 11), accepted(4, 11)];
    const { deps, events, repo } = setup({
      evidence,
      reply: () => ({ clusters: [cluster('同一页的四句话', [1, 2, 3, 4])] }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 0, dropped: 1 });
    expect(repo.rows).toEqual([]);
    expect(eventsOf(events, 'cluster.dropped')[0]).toMatchObject({
      independentSources: 2,
      evidenceIds: [1, 2, 3, 4],
    });
  });

  it('returns LLM_UNAVAILABLE when the clustering call fails', async () => {
    const { deps, events, llm, repo } = setup({
      evidence: [accepted(1, 10), accepted(2, 11), accepted(3, 12)],
      reply: () => ({ fail: 'provider down' }),
    });

    const failure = expectFailure(await clusterS3(context(), deps));

    expect(failure.code).toBe('LLM_UNAVAILABLE');
    expect(failure.message).toContain('provider down');
    expect(repo.rows).toEqual([]);
    expect(llm.prompts).toHaveLength(1);
    expect(eventsOf(events, 'cluster.created')).toEqual([]);
    expect(eventsOf(events, 'cluster.dropped')).toEqual([]);
  });

  it('emits cluster.created for kept clusters and cluster.dropped for refused ones', async () => {
    const evidence = [accepted(1, 10), accepted(2, 11), accepted(3, 12), accepted(4, 20)];
    const { deps, events } = setup({
      evidence,
      reply: () => ({
        clusters: [cluster('保留的簇', [1, 2, 3]), cluster('被丢弃的簇', [4])],
      }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 1, dropped: 1 });
    expect(events.map((event) => event.type)).toEqual(['cluster.created', 'cluster.dropped']);
    expect(eventsOf(events, 'cluster.dropped')[0]).toMatchObject({
      name: '被丢弃的簇',
      independentSources: 1,
      evidenceIds: [4],
    });
  });

  it('never lets the same evidence back two opportunities', async () => {
    // Three independent pages, cited twice by the model: the second cluster has
    // nothing left, so it must not become a second opportunity off one signal.
    const evidence = [accepted(1, 10), accepted(2, 11), accepted(3, 12)];
    const { deps, events, repo } = setup({
      evidence,
      reply: () => ({
        clusters: [cluster('第一个机会', [1, 2, 3]), cluster('第二个机会', [1, 2, 3])],
      }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 1, dropped: 1 });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      name: '第一个机会',
      independentSources: 3,
      evidenceIds: [1, 2, 3],
    });

    expect(eventsOf(events, 'cluster.created')).toHaveLength(1);
    expect(eventsOf(events, 'cluster.dropped')).toEqual([
      expect.objectContaining({
        name: '第二个机会',
        independentSources: 0,
        evidenceIds: [],
        reason: 'insufficient_independence',
      }),
    ]);
  });

  it('sends summaries with a truncated quote, never the full text or the URL', async () => {
    const longQuote = '库'.repeat(MAX_QUOTE_IN_PROMPT + 180);
    const evidence = [accepted(1, 10, { quote: longQuote })];
    const { deps, llm } = setup({
      evidence,
      reply: () => ({ clusters: [] }),
    });

    expectOk(await clusterS3(context(), deps));

    const user = llm.prompts[0]?.user ?? '';
    const truncated = '库'.repeat(MAX_QUOTE_IN_PROMPT);

    expect(user).toContain('id=1');
    expect(user).toContain('signal=problem');
    expect(user).toContain('platform=v2ex');
    expect(user).toContain('support=证据 1 支持的问题');
    expect(user).toContain(`quote="${truncated}"`);
    expect(user).not.toContain(`quote="${truncated}库"`);
    expect(user).not.toContain(evidence[0]?.canonicalUrl ?? '');
  });

  it('never calls the model when the run has no accepted evidence', async () => {
    const { deps, events, llm, repo } = setup({
      evidence: [],
      reply: () => ({ clusters: [cluster('凭空捏造', [1, 2, 3])] }),
    });

    const summary = expectOk(await clusterS3(context(), deps));

    expect(summary).toEqual({ opportunities: 0, dropped: 0 });
    expect(repo.stats.listCalls).toBe(1);
    expect(llm.prompts).toEqual([]);
    expect(repo.rows).toEqual([]);
    expect(events).toEqual([]);
  });

  it('returns DEADLINE_EXCEEDED before listing evidence when the deadline has passed', async () => {
    const { deps, llm, repo } = setup({
      evidence: [accepted(1, 10)],
      reply: () => ({ clusters: [] }),
    });

    const failure = expectFailure(await clusterS3(context({ deadlineAt: NOW }), deps));

    expect(failure.code).toBe('DEADLINE_EXCEEDED');
    expect(repo.stats.listCalls).toBe(0);
    expect(llm.prompts).toEqual([]);
  });

  it('returns the storage failure instead of reporting a stored opportunity', async () => {
    const evidence = [accepted(1, 10), accepted(2, 11), accepted(3, 12)];
    const { deps, events } = setup({
      evidence,
      insertFails: true,
      reply: () => ({ clusters: [cluster('写不进去', [1, 2, 3])] }),
    });

    const failure = expectFailure(await clusterS3(context(), deps));

    expect(failure.code).toBe('STORAGE_FAILED');
    expect(failure.message).toContain('写入机会');
    expect(events).toEqual([]);
  });
});
