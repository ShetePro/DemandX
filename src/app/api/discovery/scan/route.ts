import { z } from 'zod';

import { findOpportunities } from '@/lib/discovery/find';
import { loadScanMemory, priorFingerprints, recordScan } from '@/lib/discovery/memory';
import { planScan } from '@/lib/discovery/planner';
import { pickDiscoveryQueries } from '@/lib/discovery/queries';
import { createDiscoveryRuntime } from '@/lib/discovery/runtime';
import { fetchTrends } from '@/lib/discovery/trends';
import {
  SOCIAL_QUERY_OFFSETS,
  socialQueryFor,
  socialSupportsQuery,
} from '@/lib/search/social';
import { platformProfileDir } from '@/lib/crawl/session-status';
import { existsSync } from 'node:fs';
import type { DiscoveryPlan, DiscoveryResult, ScanMemory } from '@/lib/discovery/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/** Sort key: English-only queries before mixed/Chinese ones. */
function englishFirst(query: string): number {
  return /[a-z]{4}/i.test(query) && !/[\u4e00-\u9fff]/.test(query) ? 0 : 1;
}

const inputSchema = z
  .object({
    excludeUrls: z.array(z.string().trim().max(2000)).max(300).optional(),
    /** Operator-chosen angles; absent or empty means the model plans them. */
    directions: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
  })
  .strict();

type Phase = 'plan' | 'search' | 'filter' | 'model';

/** One replan is enough: two model attempts still fit the interactive budget. */
const MAX_ATTEMPTS = 2;

/** One scan at a time: two tabs must not fight over the same browser profiles. */
let scanInFlight = false;

/**
 * Proven business-shaped probes appended to every plan. The planner supplies
 * the novelty; these guarantee the pool contains commercially anchored
 * snippets even when a newly invented angle is too narrow for the engines.
 */
const FALLBACK_PROBES = 8;

/**
 * Two demand-shaped searches run every round: the planner invents novelty, but
 * these guarantee the evidence pool contains first-person "I need / 求推荐"
 * posts instead of only vendor pages and third-person complaints.
 */
const DEMAND_PROBES = [
  '求推荐 小公司 手工 工具 发票 对账',
  'I need a tool to automate manual invoices and reconciliation',
] as const;

/**
 * NDJSON instead of a server action: the dialog must show which phase is
 * running, and a single JSON response cannot update the UI until the last one
 * finishes. Each scan is planned from persisted history and recent trends, then
 * written back so the next round can be different.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      if (scanInFlight) {
        send({ type: 'error', code: 'SCAN_BUSY', message: '已有一轮扫描在进行中，请等它结束再扫。' });
        controller.close();
        return;
      }
      scanInFlight = true;
      // Safety net: the flag must not stay stuck forever if a provider call
      // ignores an abort. The normal path clears it in `finally`.
      const watchdog = setTimeout(() => {
        scanInFlight = false;
      }, 540_000);

      try {
        const runtime = await createDiscoveryRuntime();

        const memory = await loadScanMemory();
        if (!memory.ok) {
          send({ type: 'error', code: 'STORAGE_FAILED', message: memory.message });
          return;
        }

        const trends = await fetchTrends();
        const trendItems = trends.ok ? trends.value : [];
        const trendTitles = trendItems.map((trend) => trend.title);

        const baseMemory: ScanMemory = {
          ...memory.value,
          excludedUrls: [
            ...new Set([...(parsed.data.excludeUrls ?? []), ...memory.value.excludedUrls]),
          ].slice(0, 300),
        };

        let lastError: {
          code: string;
          message: string;
          partial?: { sources: { url: string; title: string; snippet: string; platform: string }[]; providers: string[] };
        } | null = null;
        let attemptMemory = baseMemory;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          send({ type: 'phase', phase: 'plan' satisfies Phase, detail: attempt });
          const plan: DiscoveryPlan = await planScan({
            llm: runtime.llm,
            memory: attemptMemory,
            trends: trendItems,
            trendsAvailable: trends.ok,
            directions: parsed.data.directions ?? [],
          });

          // English queries first: the capped community ports (Reddit, GitHub)
          // only see the first few, and their corpus is English.
          const executed = [
            ...new Set([
              ...plan.queries.map((item) => item.query),
              ...pickDiscoveryQueries(FALLBACK_PROBES),
              ...DEMAND_PROBES,
            ]),
          ].sort((left, right) => englishFirst(left) - englishFirst(right));

          const result = await findOpportunities({
            ...runtime,
            plan,
            queries: executed,
            excludeUrls: attemptMemory.excludedUrls,
            priorFingerprints: priorFingerprints(attemptMemory),
            priorIdeas: attemptMemory.scans
              .flatMap((scan) => scan.opportunities)
              .map((item) => ({ title: item.title, problem: item.problem })),
            onPhase: (phase: 'search' | 'filter' | 'model', detail?: number) =>
              send({ type: 'phase', phase, detail }),
          });

          if (result.ok) {
            const excluded = new Set(attemptMemory.excludedUrls);
            const newUrls = result.value.sources.filter((source) => !excluded.has(source.url)).length;
            const total = result.value.sources.length;

            const stored = await recordScan({
              plan,
              queries: executed,
              result: result.value,
              trendTitles,
            });

            const socialQueries = (
              ['zhihu', 'xiaohongshu', 'douyin', 'twitter'] as const
            ).flatMap((platform) => {
              if (!existsSync(platformProfileDir(platform))) return [];
              const supported = executed.filter((item) => socialSupportsQuery(platform, item));
              const query = supported[SOCIAL_QUERY_OFFSETS[platform]];
              return query === undefined ? [] : [{ platform, query: socialQueryFor(platform, query) }];
            });

            const value: DiscoveryResult = {
              scanId: stored.ok ? stored.value : null,
              ...result.value,
              queries: executed,
              socialQueries,
              angles: plan.angles,
              rationale: plan.rationale,
              strategy: plan.strategy,
              novelty: { newUrls, total, ratio: total === 0 ? 0 : newUrls / total },
              avoided: attemptMemory.excludedUrls.length,
              providers: result.value.providers,
            };
            send({ type: 'result', value });
            return;
          }

          lastError = {
            code: result.code,
            message: result.message,
            ...(result.partial === undefined ? {} : { partial: result.partial }),
          };

          // A duplicate-heavy, empty or ungrounded round is worth exactly one
          // replan; a model/provider failure is not, because the next attempt
          // would hit the same provider state.
          // Only a different angle/query set can fix these; re-running the
          // model on a slow provider after an evidence rejection only doubles
          // the wait (`find` already does one corrective retry internally).
          if (result.code !== 'TOO_SIMILAR' && result.code !== 'NO_SOURCES') {
            break;
          }

          attemptMemory = {
            ...attemptMemory,
            scans: [
              {
                angles: plan.angles,
                queries: plan.queries.map((item) => item.query),
                opportunities: [],
                createdAt: new Date().toISOString(),
              },
              ...attemptMemory.scans,
            ],
          };
        }

        send({
          type: 'error',
          code: lastError?.code ?? 'SCAN_FAILED',
          message:
            lastError?.code === 'TOO_SIMILAR'
              ? '连续两轮结果都与最近扫描过于相似，稍后再扫或检查搜索配置。'
              : (lastError?.message ?? '扫描失败：服务端错误'),
          ...(lastError?.partial === undefined ? {} : { partial: lastError.partial }),
        });
      } catch {
        send({ type: 'error', code: 'SCAN_FAILED', message: '扫描失败：服务端错误' });
      } finally {
        clearTimeout(watchdog);
        scanInFlight = false;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
