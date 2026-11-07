import '@/lib/db/load-env';

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

import { parseCasePage } from '@/lib/cases/parse';
import { upsertCaseStudies, type CaseStudyInput } from '@/lib/cases/repository';
import { createCrawler } from '@/lib/crawl';
import { createRobotsCache } from '@/lib/crawl/robots';
import { closeDb } from '@/lib/db/client';
import { writeSnapshot } from '@/lib/evidence/snapshot';

/**
 * Phase 0 of the case library: crawl a slice of Starter Story's public
 * `/stories/` pages, parse only what the page literally states (title,
 * revenue, founding year, summary), store the content-addressed snapshot and
 * report field hit rates. No LLM, no categories, no retrieval — this run
 * answers one question: is the corpus good enough to build on?
 *
 * Usage:
 *   pnpm tsx scripts/ingest-cases.ts --limit 50
 *   pnpm tsx scripts/ingest-cases.ts --limit 20 --dry
 *   pnpm tsx scripts/ingest-cases.ts --limit 50 --offset 50 --sitemap data/cases/sitemap.xml.gz
 *
 * `--dry` still crawls (polite, robots-aware) but writes no snapshot and no
 * row, so a sample can be measured before the database is touched.
 */

const SITEMAP_URL = 'https://www.starterstory.com/sitemap';
const DEFAULT_LIMIT = 50;
const DEFAULT_DELAY_MS = 1_000;
/** Sitemap URLs are collected in one batch; keep the statement modest. */
const INSERT_BATCH = 50;

interface Options {
  limit: number;
  offset: number;
  dry: boolean;
  delayMs: number;
  sitemapFile: string | null;
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Unknown flags fail loudly: a typo must not silently ingest 50 more pages. */
function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    limit: DEFAULT_LIMIT,
    offset: 0,
    dry: false,
    delayMs: DEFAULT_DELAY_MS,
    sitemapFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--limit':
        options.limit = readInt(argv[++index], DEFAULT_LIMIT);
        break;
      case '--offset':
        options.offset = readInt(argv[++index], 0);
        break;
      case '--delay-ms':
        options.delayMs = readInt(argv[++index], DEFAULT_DELAY_MS);
        break;
      case '--dry':
        options.dry = true;
        break;
      case '--sitemap':
        options.sitemapFile = argv[++index] ?? null;
        break;
      default:
        throw new Error(`未知参数：${arg ?? ''}`);
    }
  }

  return options;
}

/** The sitemap is served as a raw `.gz` file, sometimes with/without a gzip header. */
async function readSitemap(file: string | null): Promise<string> {
  const bytes =
    file === null
      ? Buffer.from(
          await (
            await fetch(SITEMAP_URL, {
              headers: { 'accept-encoding': 'gzip' },
              signal: AbortSignal.timeout(30_000),
            })
          ).arrayBuffer(),
        )
      : await readFile(file);

  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (gzipped ? gunzipSync(bytes) : bytes).toString('utf8');
}

/** Public founder interviews only; `/businesses/` profiles come later. */
function storyUrls(xml: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = (match[1] ?? '').trim().replace(/&amp;/g, '&');
    if (!url.includes('/stories/')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}

/** `robots.txt` is read directly, like the worker does, without a limiter. */
async function fetchRobots(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`robots.txt ${response.status}`);
  return response.text();
}

interface Metrics {
  attempted: number;
  ok: number;
  robots: number;
  needsHuman: number;
  errors: Map<string, number>;
  revenue: number;
  founded: number;
  summary: number;
  textBytes: number;
}

function emptyMetrics(): Metrics {
  return {
    attempted: 0,
    ok: 0,
    robots: 0,
    needsHuman: 0,
    errors: new Map(),
    revenue: 0,
    founded: 0,
    summary: 0,
    textBytes: 0,
  };
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const xml = await readSitemap(options.sitemapFile);
  const allStories = storyUrls(xml);
  const slice = allStories.slice(options.offset, options.offset + options.limit);
  if (slice.length === 0) {
    console.error(`❌ sitemap 中没有可摄取的故事（共 ${allStories.length} 条）`);
    return 1;
  }

  console.log(
    `📚 案例库 P0：${slice.length} 条（sitemap 共 ${allStories.length} 条 /stories/）` +
      `${options.dry ? '，dry run 不写库' : ''}`,
  );

  const crawler = createCrawler({
    strategy: 'static',
    robots: createRobotsCache({ fetchRobots }),
  });

  const metrics = emptyMetrics();
  const rows: CaseStudyInput[] = [];

  try {
    for (const [index, url] of slice.entries()) {
      metrics.attempted += 1;
      const result = await crawler.crawl(url);

      if (result.status === 'skipped') {
        metrics.robots += 1;
        console.log(`[${index + 1}/${slice.length}] robots 跳过 ${url}`);
        continue;
      }
      if (result.status === 'needs_human') {
        metrics.needsHuman += 1;
        console.log(`[${index + 1}/${slice.length}] 需要人工（${result.reason}）${url}`);
        continue;
      }
      if (result.status === 'error') {
        metrics.errors.set(result.code, (metrics.errors.get(result.code) ?? 0) + 1);
        console.log(`[${index + 1}/${slice.length}] 失败 ${result.code} ${url}`);
        continue;
      }

      const parsed = parseCasePage({
        url,
        title: result.snapshot.title,
        text: result.snapshot.text,
        html: result.snapshot.html,
      });
      metrics.ok += 1;
      metrics.textBytes += Buffer.byteLength(result.snapshot.text, 'utf8');
      if (parsed.revenueMonth !== null) metrics.revenue += 1;
      if (parsed.foundedYear !== null) metrics.founded += 1;
      if (parsed.summary !== null) metrics.summary += 1;

      console.log(
        `[${index + 1}/${slice.length}] ok ${parsed.revenueNote ?? '无营收字段'} · ${
          parsed.foundedYear ?? '无成立年'
        } · ${parsed.title.slice(0, 40)}`,
      );

      if (!options.dry) {
        const snapshot = await writeSnapshot({
          text: result.snapshot.text,
          html: result.snapshot.html,
          url,
        });
        rows.push({
          url,
          slug: parsed.slug,
          title: parsed.title,
          sourceKind: 'story',
          revenueMonth: parsed.revenueMonth,
          revenueNote: parsed.revenueNote,
          foundedYear: parsed.foundedYear,
          summary: parsed.summary,
          snapshotHash: snapshot.hash,
          fetchedAt: new Date(),
        });
      }

      if (options.delayMs > 0 && index < slice.length - 1) await sleep(options.delayMs);
    }
  } finally {
    await crawler.dispose();
  }

  let written = 0;
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const writtenBatch = await upsertCaseStudies(rows.slice(start, start + INSERT_BATCH));
    if (!writtenBatch.ok) {
      console.error(`❌ ${writtenBatch.message}`);
      return 1;
    }
    written += writtenBatch.value.written;
  }

  const errorSummary = [...metrics.errors.entries()]
    .map(([code, count]) => `${code}=${count}`)
    .join(' ');
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  const averageKb =
    metrics.ok === 0 ? '—' : `${(metrics.textBytes / metrics.ok / 1024).toFixed(1)}KB`;

  console.log('');
  console.log(
    `摄取 ${metrics.attempted} 条：ok=${metrics.ok} robots=${metrics.robots} needs_human=${
      metrics.needsHuman
    }${errorSummary === '' ? '' : ` ${errorSummary}`}`,
  );
  console.log(
    `字段命中（基于 ok）：营收 ${metrics.revenue}/${metrics.ok} ${percent(
      metrics.revenue,
      metrics.ok,
    )} · 成立年 ${metrics.founded}/${metrics.ok} ${percent(
      metrics.founded,
      metrics.ok,
    )} · 摘要 ${metrics.summary}/${metrics.ok} ${percent(metrics.summary, metrics.ok)}`,
  );
  console.log(
    `正文均值 ${averageKb} · 耗时 ${seconds}s · ${options.dry ? 'dry run 未写库' : `写入 ${written} 行`}`,
  );

  return 0;
}

void main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error('❌ 案例摄取失败:', error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
