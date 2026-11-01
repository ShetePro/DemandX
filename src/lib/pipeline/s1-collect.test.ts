import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CrawlPort, CrawlResult } from '@/lib/crawl/port';
import type { Result } from '@/lib/quota/types';
import type { RecordQueryInput } from '@/lib/runs/sources-repository';
import type { SearchHit, SearchPort } from '@/lib/search/port';

import type { RunContext } from './context';
import { collectS1, type CollectDeps, type S1Summary } from './s1-collect';

const IDEA = '跨境库存同步';
const NOW = new Date('2026-10-30T12:00:00.000Z');

function hit(url: string, platform: SearchHit['platform'] = 'web'): SearchHit {
  return { url, title: `标题 ${url}`, snippet: '摘要', platform };
}

function okSnapshot(url: string, text: string): CrawlResult {
  return {
    status: 'ok',
    snapshot: { url, html: `<html><body>${text}</body></html>`, text, title: '页面' },
  };
}

function createCrawl(
  routes: Readonly<Record<string, CrawlResult | (() => Promise<CrawlResult>)>>,
  calls: string[],
): CrawlPort {
  return {
    async crawl(url) {
      calls.push(url);
      const route = routes[url];
      if (route === undefined) return { status: 'error', code: 'HTTP_ERROR', url };
      return typeof route === 'function' ? route() : route;
    },
  };
}

function createPort(
  id: string,
  hits: readonly SearchHit[],
  calls?: string[],
  fallback = false,
): SearchPort {
  return {
    id,
    platform: 'web',
    ...(fallback ? { fallback: true } : {}),
    async search(query) {
      calls?.push(query);
      return [...hits];
    },
  };
}

interface FakeRepo {
  insertSource: CollectDeps['repo']['insertSource'];
  listSourceUrls: CollectDeps['repo']['listSourceUrls'];
  rows: Map<string, { id: number; runId: number }>;
}

function createRepo(seededUrls: readonly string[] = []): FakeRepo {
  const rows = new Map<string, { id: number; runId: number }>();
  const urlsByRun = new Map<number, Set<string>>();
  let nextId = 1;

  function remember(runId: number, url: string): void {
    const urls = urlsByRun.get(runId) ?? new Set<string>();
    urls.add(url);
    urlsByRun.set(runId, urls);
  }

  for (const url of seededUrls) {
    rows.set(`${url}|seed`, { id: nextId++, runId: 1 });
    remember(1, url);
  }

  return {
    rows,
    async insertSource(input): Promise<Result<{ id: number; inserted: boolean }>> {
      const key = `${input.canonicalUrl}|${input.contentHash}`;
      const existing = rows.get(key);
      if (existing) return { ok: true, value: { id: existing.id, inserted: false } };
      const id = nextId++;
      rows.set(key, { id, runId: input.runId });
      remember(input.runId, input.canonicalUrl);
      return { ok: true, value: { id, inserted: true } };
    },
    async listSourceUrls(runId): Promise<Result<string[]>> {
      return { ok: true, value: [...(urlsByRun.get(runId) ?? [])] };
    },
  };
}

function createQuota(refused: ReadonlySet<string> = new Set()): CollectDeps['quota'] {
  return {
    async claim(source) {
      return refused.has(source)
        ? { ok: false, code: 'QUOTA_EXCEEDED', message: `${source} 配额已用尽` }
        : { ok: true, value: { source } };
    },
  };
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 1,
    idea: IDEA,
    angles: ['problem'],
    deadlineAt: null,
    ...overrides,
  };
}

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.value;
}

describe('collectS1', () => {
  let snapshotDir: string;

  beforeEach(async () => {
    snapshotDir = await mkdtemp(path.join(tmpdir(), 'demandx-s1-'));
  });

  afterEach(async () => {
    await rm(snapshotDir, { recursive: true, force: true });
  });

  function deps(
    port: SearchPort,
    crawl: CrawlPort,
    repo: FakeRepo,
    extra: Partial<CollectDeps> = {},
  ): CollectDeps {
    return {
      searchPorts: [port],
      crawl,
      quota: createQuota(),
      repo,
      snapshotDir,
      now: () => NOW,
      ...extra,
    };
  }

  it('crawls a repeated URL once and inserts it once', async () => {
    const repo = createRepo();
    const crawlCalls: string[] = [];
    const url = 'https://example.com/post?utm_source=x';
    const port = createPort('ddg', [hit(url)]);
    const crawl = createCrawl(
      { [url]: okSnapshot(url, '库存同步每天都要在三个平台之间手工核对表格，非常费时间。') },
      crawlCalls,
    );

    const summary = expectOk(await collectS1(context(), deps(port, crawl, repo)));

    expect(summary).toEqual({ sources: 1, skipped: 0, needsHuman: 0 });
    expect(crawlCalls).toEqual([url]);
    expect(repo.rows.size).toBe(1);
  });

  it('skips a near-duplicate page with a different URL', async () => {
    const repo = createRepo();
    const crawlCalls: string[] = [];
    const text = '库存同步每天都要在三个平台之间手工核对表格，非常费时间。'.repeat(20);
    const first = 'https://a.example.com/post';
    const second = 'https://b.example.com/post';
    // Punctuation only: identical tokens, so the two fingerprints are identical.
    const port = createPort('ddg', [hit(first), hit(second)]);
    const crawl = createCrawl(
      { [first]: okSnapshot(first, text), [second]: okSnapshot(second, `${text}。`) },
      crawlCalls,
    );

    const summary = expectOk(await collectS1(context(), deps(port, crawl, repo)));

    expect(summary.sources).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(repo.rows.size).toBe(1);
    expect(crawlCalls).toEqual([first, second]);
  });

  it('skips a source whose quota claim is refused without searching', async () => {
    const repo = createRepo();
    const crawlCalls: string[] = [];
    const searchCalls: string[] = [];
    const port = createPort('ddg', [hit('https://example.com/post')], searchCalls);
    const crawl = createCrawl({}, crawlCalls);

    const summary = expectOk(
      await collectS1(context(), deps(port, crawl, repo, { quota: createQuota(new Set(['ddg'])) })),
    );

    // One group with three queries; every claim is refused.
    expect(summary.sources).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(searchCalls).toEqual([]);
    expect(crawlCalls).toEqual([]);
  });

  it('counts a login wall as needs_human and keeps going', async () => {
    const repo = createRepo();
    const url = 'https://example.com/login';
    const port = createPort('ddg', [hit(url)]);
    const crawl: CrawlPort = {
      async crawl(): Promise<CrawlResult> {
        return { status: 'needs_human', reason: 'login', url };
      },
    };

    const summary = expectOk(await collectS1(context(), deps(port, crawl, repo)));

    expect(summary).toEqual({ sources: 0, skipped: 0, needsHuman: 1 });
    expect(repo.rows.size).toBe(0);
  });

  it('returns DEADLINE_EXCEEDED before issuing a search when the deadline has passed', async () => {
    const repo = createRepo();
    const searchCalls: string[] = [];
    const port = createPort('ddg', [hit('https://example.com/post')], searchCalls);
    const crawl = createCrawl({}, []);

    const result = await collectS1(
      context({ deadlineAt: new Date(NOW.getTime() - 1_000) }),
      deps(port, crawl, repo),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a deadline failure');
    expect(result.code).toBe('DEADLINE_EXCEEDED');
    expect(searchCalls).toEqual([]);
  });

  it('writes a progress event after each query and one event per stored source', async () => {
    const repo = createRepo();
    const url = 'https://example.com/post';
    const port = createPort('ddg', [hit(url)]);
    const crawl = createCrawl(
      { [url]: okSnapshot(url, '手工同步库存很麻烦，每天要花两小时。') },
      [],
    );
    const events: { type: string; payload: Record<string, unknown> }[] = [];

    const summary = expectOk(
      await collectS1(
        context(),
        deps(port, crawl, repo, {
          onEvent: async (type, payload) => {
            events.push({ type, payload });
          },
        }),
      ),
    );

    expect(summary.sources).toBe(1);
    const types = events.map((event) => event.type);
    expect(types).toContain('source.added');
    expect(types).toContain('stage.progress');

    // The URL is stored by the first query, so the later two skip it silently.
    expect(types.filter((type) => type === 'source.added')).toHaveLength(1);
    const progress = events.filter((event) => event.type === 'stage.progress');
    expect(progress).toHaveLength(3);
    expect(progress.at(-1)?.payload).toMatchObject({ stage: 'S1', done: 3, total: 3, sources: 1 });
    expect(events.find((event) => event.type === 'source.added')?.payload).toMatchObject({
      url,
      platform: 'web',
    });
  });

  it('records every query with its provider and result count', async () => {
    const repo = createRepo();
    const port = createPort('ddg', [hit('https://example.com/post')]);
    const crawl = createCrawl(
      { 'https://example.com/post': okSnapshot('https://example.com/post', '库存同步很麻烦。') },
      [],
    );
    const recorded: RecordQueryInput[] = [];

    await collectS1(
      context(),
      deps(port, crawl, repo, {
        recordQuery: async (input) => {
          recorded.push(input);
          return { ok: true, value: { id: recorded.length } };
        },
      }),
    );

    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({
      runId: 1,
      angle: 'problem',
      provider: 'ddg',
      resultCount: 1,
    });
  });

  it('turns a failing search into a skip instead of a failed run', async () => {
    const repo = createRepo();
    const port: SearchPort = {
      id: 'ddg',
      platform: 'web',
      async search() {
        throw new Error('network down');
      },
    };
    const crawl = createCrawl({}, []);
    const events: string[] = [];

    const summary = expectOk(
      await collectS1(
        context(),
        deps(port, crawl, repo, {
          onEvent: async (type) => {
            events.push(type);
          },
        }),
      ),
    );

    expect(summary).toEqual({ sources: 0, skipped: 3, needsHuman: 0 });
    expect(events).toContain('query.failed');
  });

  it('falls back to every angle when the run stored no matching angle name', async () => {
    const repo = createRepo();
    const searchCalls: string[] = [];
    const port = createPort('ddg', [], searchCalls);
    const crawl = createCrawl({}, []);

    const summary: S1Summary = expectOk(
      await collectS1(context({ angles: ['定价', '获客'] }), deps(port, crawl, repo)),
    );

    expect(summary.skipped).toBe(0);
    // Five signal classes plus the competitor scan, three queries each.
    expect(searchCalls).toHaveLength(18);
  });

  it('stops fetching once the page cap is reached and records it', async () => {
    const repo = createRepo();
    const urls = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ];
    const crawlCalls: string[] = [];
    const port = createPort(
      'ddg',
      urls.map((url) => hit(url)),
    );
    const crawl = createCrawl(
      Object.fromEntries(
        urls.map((url) => [url, { status: 'needs_human' as const, reason: 'login' as const, url }]),
      ),
      crawlCalls,
    );
    const events: { type: string; payload: Record<string, unknown> }[] = [];

    const summary = expectOk(
      await collectS1(
        context(),
        deps(port, crawl, repo, {
          limits: { delayMs: 0, maxPages: 2 },
          onEvent: async (type, payload) => {
            events.push({ type, payload });
          },
        }),
      ),
    );

    expect(crawlCalls).toHaveLength(2);
    expect(summary).toEqual({ sources: 0, skipped: 0, needsHuman: 2 });
    expect(events.find((event) => event.type === 'stage.capped')?.payload).toMatchObject({
      stage: 'S1',
      maxPages: 2,
    });
  });

  it('skips the fallback port when a primary adapter returned hits', async () => {
    const repo = createRepo();
    const crawlCalls: string[] = [];
    const fallbackCalls: string[] = [];
    const url = 'https://example.com/post';
    const primary = createPort('hn', [hit(url, 'hn')]);
    const fallback = createPort('web-api-tavily', [], fallbackCalls, true);
    const crawl = createCrawl(
      { [url]: okSnapshot(url, 'Show HN: 我做了库存同步工具') },
      crawlCalls,
    );

    const summary = expectOk(
      await collectS1(context(), deps(primary, crawl, repo, { searchPorts: [primary, fallback] })),
    );

    expect(summary.sources).toBe(1);
    expect(fallbackCalls).toEqual([]);
  });

  it('uses the fallback port for a query the primaries left empty', async () => {
    const repo = createRepo();
    const crawlCalls: string[] = [];
    const fallbackCalls: string[] = [];
    const url = 'https://blog.example.com/compare';
    const primary = createPort('hn', []);
    const fallback = createPort('web-api-tavily', [hit(url)], fallbackCalls, true);
    const crawl = createCrawl(
      { [url]: okSnapshot(url, '对比了三个库存同步工具的定价，最便宜的每月 29 美元。') },
      crawlCalls,
    );

    const summary = expectOk(
      await collectS1(context(), deps(primary, crawl, repo, { searchPorts: [primary, fallback] })),
    );

    // One selected angle has three queries; each falls back once.
    expect(fallbackCalls).toHaveLength(3);
    expect(summary.sources).toBe(1);
  });

  it('falls back when the primary adapter throws', async () => {
    const repo = createRepo();
    const crawlCalls: string[] = [];
    const fallbackCalls: string[] = [];
    const url = 'https://blog.example.com/post';
    const primary: SearchPort = {
      id: 'hn',
      platform: 'hn',
      async search() {
        throw new Error('HTTP 429');
      },
    };
    const fallback = createPort('web-api-tavily', [hit(url)], fallbackCalls, true);
    const crawl = createCrawl(
      { [url]: okSnapshot(url, '库存同步工具的真实报价与用户评价整理。') },
      crawlCalls,
    );

    const summary = expectOk(
      await collectS1(context(), deps(primary, crawl, repo, { searchPorts: [primary, fallback] })),
    );

    expect(fallbackCalls).toHaveLength(3);
    expect(summary.sources).toBe(1);
    expect(summary.skipped).toBe(3);
  });
});
