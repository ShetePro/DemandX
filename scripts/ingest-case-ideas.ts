import '@/lib/db/load-env';

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import type { CaseIdeaInput } from '@/lib/cases/repository';
import { upsertCaseIdeas } from '@/lib/cases/repository';
import { parseListingPage, type ListingIdea } from '@/lib/cases/listing';
import { createRobotsCache } from '@/lib/crawl/robots';
import { closeDb } from '@/lib/db/client';

/**
 * Fill `case_ideas` from the public `/data` listing. Anonymous access returns
 * one 25-row page per filter, with no pagination (infinite scroll is gated),
 * so coverage comes from walking filter partitions: the default page, the
 * starting-cost buckets and every business-model filter discovered in the
 * rows. The budget is explicit (`--pages`) because each request is a real page.
 *
 * Usage:
 *   pnpm cases:ideas                     # 8 listing requests
 *   pnpm cases:ideas --pages 30          # more partitions, more coverage
 *   pnpm cases:ideas --pages 3 --dry     # measure without writing
 */

const BASE = 'https://www.starterstory.com/data';
const DEFAULT_PAGES = 8;
/** Cloudflare starts resetting TLS on faster bursts; three seconds is polite. */
const DEFAULT_DELAY_MS = 3_000;
const INSERT_BATCH = 100;

interface Options {
  pages: number;
  delayMs: number;
  dry: boolean;
  /** Parse one saved listing page offline (no network, no filter walking). */
  htmlFile: string | null;
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    pages: DEFAULT_PAGES,
    delayMs: DEFAULT_DELAY_MS,
    dry: false,
    htmlFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--pages':
        options.pages = readInt(argv[++index], DEFAULT_PAGES);
        break;
      case '--delay-ms':
        options.delayMs = readInt(argv[++index], DEFAULT_DELAY_MS);
        break;
      case '--dry':
        options.dry = true;
        break;
      case '--html':
        options.htmlFile = argv[++index] ?? null;
        break;
      default:
        throw new Error(`未知参数：${arg ?? ''}`);
    }
  }

  return options;
}

async function fetchRobots(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`robots.txt ${response.status}`);
  return response.text();
}

/** Later pages may know fields an earlier one omitted; merge without losing them. */
function mergeIdea(current: ListingIdea, next: ListingIdea): ListingIdea {
  return {
    slug: current.slug,
    title: next.title || current.title,
    summary: next.summary ?? current.summary,
    domain: next.domain ?? current.domain,
    revenueMonth: next.revenueMonth ?? current.revenueMonth,
    revenueSource: next.revenueSource ?? current.revenueSource,
    soloScore: next.soloScore ?? current.soloScore,
    models: next.models.length > 0 ? next.models : current.models,
    growth: next.growth.length > 0 ? next.growth : current.growth,
    customers: next.customers.length > 0 ? next.customers : current.customers,
    tools: next.tools.length > 0 ? next.tools : current.tools,
    facts: next.facts.length > 0 ? next.facts : current.facts,
  };
}

function toRow(idea: ListingIdea, fetchedAt: Date): CaseIdeaInput {
  return {
    ...idea,
    sourceUrl: `${BASE.replace('/data', '')}/businesses/${idea.slug}`,
    fetchedAt,
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  // The crawler's readability gate is wrong for a listing page (no article):
  // fetch the HTML directly, still honouring robots and the request budget.
  const robots = createRobotsCache({ fetchRobots });

  const queue: string[] = [
    BASE,
    `${BASE}?starting_costs=low`,
    `${BASE}?starting_costs=medium`,
    `${BASE}?starting_costs=high`,
  ];
  const queued = new Set(queue);
  const ideas = new Map<string, ListingIdea>();
  const totals = new Map<string, number>();
  let pages = 0;
  let failed = 0;

  if (options.htmlFile !== null) {
    const html = await readFile(options.htmlFile, 'utf8');
    const parsed = parseListingPage(html);
    for (const idea of parsed.ideas) ideas.set(idea.slug, idea);
    console.log(
      `离线解析 ${options.htmlFile} → ${parsed.ideas.length} 条（分区共 ${parsed.total ?? '未知'}）`,
    );
  }

  while (queue.length > 0 && pages < options.pages && options.htmlFile === null) {
    const url = queue.shift()!;
    pages += 1;

    if (!(await robots.canFetch(url))) {
      failed += 1;
      console.log(`[${pages}/${options.pages}] robots 跳过 ${url}`);
      continue;
    }

    let html = '';
    try {
      const response = await fetch(url, {
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
    } catch (error) {
      failed += 1;
      console.log(
        `[${pages}/${options.pages}] 请求失败 ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const parsed = parseListingPage(html);
    if (parsed.total === null) {
      failed += 1;
      console.log(`[${pages}/${options.pages}] 无数据（落地页？）${url}`);
      continue;
    }
    totals.set(url, parsed.total);

    for (const idea of parsed.ideas) {
      const current = ideas.get(idea.slug);
      ideas.set(idea.slug, current === undefined ? idea : mergeIdea(current, idea));
    }

    // Discover more partitions: each model filter exposes its own 25 rows.
    for (const model of parsed.models) {
      const next = `${BASE}?business_model=${model.id}`;
      if (queued.has(next)) continue;
      queued.add(next);
      queue.push(next);
    }

    console.log(
      `[${pages}/${options.pages}] ${url.replace(BASE, '') || '(默认)'} → ${
        parsed.ideas.length
      } 条 · 分区共 ${parsed.total} · 累计 ${ideas.size}`,
    );

    if (options.delayMs > 0 && queue.length > 0 && pages < options.pages) {
      await sleep(options.delayMs);
    }
  }

  const rows = [...ideas.values()].map((idea) => toRow(idea, new Date()));
  const withRevenue = rows.filter((row) => row.revenueMonth !== null);
  const reported = withRevenue.filter((row) => row.revenueSource === 'reported');
  const withScore = rows.filter((row) => row.soloScore !== null);
  const withModels = rows.filter((row) => row.models.length > 0);

  let written = 0;
  if (!options.dry) {
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      const batch = await upsertCaseIdeas(rows.slice(start, start + INSERT_BATCH));
      if (!batch.ok) {
        console.error(`❌ ${batch.message}`);
        return 1;
      }
      written += batch.value.written;
    }
  }

  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  console.log('');
  console.log(
    `列表页 ${pages} 次（失败 ${failed}）：唯一 business ${rows.length} · 有营收 ${
      withRevenue.length
    }（founder 自报 ${reported.length} / estimated ${withRevenue.length - reported.length}）· 有 Solo 分 ${
      withScore.length
    } · 有模型标签 ${withModels.length}`,
  );
  console.log(`耗时 ${seconds}s · ${options.dry ? 'dry run 未写库' : `写入 ${written} 行`}`);

  return 0;
}

void main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error('❌ idea 列表摄取失败:', error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
