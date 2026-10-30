import { z } from 'zod';

import type { LlmPort, Prompt } from '@/lib/llm/port';
import { assertAlive } from '@/lib/quota/deadline';
import { ok, type Result } from '@/lib/quota/types';
import type { AcceptedEvidence, InsertOpportunityInput } from '@/lib/runs/opportunities-repository';

import type { RunContext, StageOutcome } from './context';

/**
 * The hard gate from the design: one loud thread is a complaint, three
 * independent pages are a market signal. A cluster below this never becomes an
 * opportunity, no matter how confident the model sounds.
 */
export const MIN_INDEPENDENT_SOURCES = 3;

/** A model that groups evidence into more than this is splitting, not clustering. */
export const MAX_CLUSTERS = 8;

/** Enough of a quote to recognise the problem; the model never needs the rest. */
export const MAX_QUOTE_IN_PROMPT = 120;

export const MAX_CLUSTER_NAME = 20;
export const MAX_CLUSTER_POSITIONING = 80;

/**
 * What one clustering call returns. Deliberately no score, rating or priority
 * field: scoring is code (`src/lib/scoring`), and a model that cannot emit a
 * number cannot invent one. `evidenceIds` is the only link back to the corpus,
 * so a cluster without them is unusable.
 */
export const clusteringSchema = z.object({
  clusters: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(MAX_CLUSTER_NAME),
        positioning: z.string().trim().min(1).max(MAX_CLUSTER_POSITIONING),
        evidenceIds: z.array(z.number().int().positive()),
      }),
    )
    .max(MAX_CLUSTERS),
});

export type Clustering = z.infer<typeof clusteringSchema>;

export interface S3Summary {
  /** Clusters stored as opportunities. */
  opportunities: number;
  /** Clusters refused because fewer than `MIN_INDEPENDENT_SOURCES` pages backed them. */
  dropped: number;
}

export interface ClusterDeps {
  llm: LlmPort;
  repo: {
    listAcceptedEvidence(runId: number): Promise<Result<AcceptedEvidence[]>>;
    insertOpportunity(input: InsertOpportunityInput): Promise<Result<{ id: number }>>;
  };
  /** Optional audit log; its failure never fails the run. */
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

/**
 * Telemetry must never abort clustering: opportunities already stored stay
 * stored even if writing the event fails.
 */
async function emit(
  deps: Pick<ClusterDeps, 'onEvent'>,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.onEvent?.(type, payload);
  } catch {
    // Intentionally swallowed: the opportunity row is the durable record.
  }
}

/** One line per evidence row, whitespace collapsed so a quote cannot break the list. */
function summarize(item: AcceptedEvidence): string {
  const quote = item.quote.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_IN_PROMPT);
  return [
    `id=${item.id}`,
    `signal=${item.signal}`,
    `platform=${item.platform}`,
    `support=${item.supports ?? '未知'}`,
    `quote="${quote}"`,
  ].join(' | ');
}

/**
 * The system prompt is the whole contract: group by the problem the user has,
 * not by vocabulary or platform, name the group, state the positioning, and
 * cite only the ids it was given. No scores — the prompt says so explicitly and
 * the schema has no field for one.
 */
export function buildClusteringPrompt(evidence: readonly AcceptedEvidence[]): Prompt {
  const system = [
    '你是需求聚类器。唯一的任务是把多条用户证据按“同一个用户问题”分组，并为每组起名和定位。',
    '',
    '硬性规则：',
    '1. 只按用户面对的问题分组：同一个问题换了说法、换了平台仍算一组；不同问题不得合并，哪怕它们同属一个大行业。',
    `2. 每组给出 name（不超过 ${MAX_CLUSTER_NAME} 字）与 positioning（不超过 ${MAX_CLUSTER_POSITIONING} 字），只能概括证据里已经出现的内容。`,
    '3. evidenceIds 只能填输入中出现过的 id，不得编造、不得填写范围或负数；每条证据最多归入一组。',
    `4. 最多 ${MAX_CLUSTERS} 组；没有证据支撑的问题不要写，无法归入任何组的证据不要强行归类。`,
    '5. 不得输出任何分数、评分、优先级或市场规模；你没有这些输入，也不允许推测。',
    '6. 不得编造证据之外的事实、用户数量、价格或竞品。',
  ].join('\n');

  const user = [
    '证据列表（每行一条）：',
    ...evidence.map(summarize),
    '',
    `请返回 JSON：{"clusters":[{"name":"...","positioning":"...","evidenceIds":[1,2]}]}`,
  ].join('\n');

  return { system, user };
}

/**
 * S3: accepted evidence → clusters → `opportunities`, with independence decided
 * in code, never by the model. A cluster's source count is the number of
 * distinct `sourceId`s among its (surviving) evidence ids: the model cannot
 * promote a one-thread complaint by citing the same page twice, and an id it
 * hallucinated simply does not count.
 *
 * Dropped clusters are events, not rows: `opportunities` only ever contains
 * opportunities that cleared the threshold, which is what S4 may score.
 */
export async function clusterS3(
  ctx: RunContext,
  deps: ClusterDeps,
): Promise<StageOutcome<S3Summary>> {
  const now = deps.now ?? (() => new Date());

  // Stage entrance check, before listing or calling the model.
  const alive = assertAlive(ctx.deadlineAt, now());
  if (!alive.ok) return alive;

  const listed = await deps.repo.listAcceptedEvidence(ctx.runId);
  if (!listed.ok) return listed;

  const evidence = listed.value;
  // Nothing accepted means nothing to group; asking the model would only invite
  // it to invent clusters out of an empty list.
  if (evidence.length === 0) return ok({ opportunities: 0, dropped: 0 });

  const asked = await deps.llm.structured(clusteringSchema, buildClusteringPrompt(evidence), {
    profile: 'quality',
  });
  if (!asked.ok) {
    // Every model failure is terminal here: the only call of the stage failed,
    // and a partial grouping would silently hide evidence from every later stage.
    return { ok: false, code: 'LLM_UNAVAILABLE', message: `聚类失败：${asked.message}` };
  }

  let opportunities = 0;
  let dropped = 0;
  /**
   * Evidence already spent on an earlier cluster. The prompt asks the model to
   * file each id once; a model that repeats them would otherwise let the same
   * three pages back two opportunities, doubling the result off one signal.
   */
  const claimedIds = new Set<number>();

  for (const cluster of asked.value.data.clusters.slice(0, MAX_CLUSTERS)) {
    // Unknown ids are dropped, not trusted: a wrong id would otherwise inflate
    // the source count with a page that does not exist in this run. Filtering
    // the corpus (not the model's array) also dedupes repeated ids. Ids already
    // claimed by an earlier cluster are removed before the source count, so the
    // later cluster is judged on what is actually left to it.
    const citedIds = new Set(cluster.evidenceIds);
    const cited = evidence.filter((item) => citedIds.has(item.id) && !claimedIds.has(item.id));
    const evidenceIds = cited.map((item) => item.id);
    for (const id of evidenceIds) claimedIds.add(id);
    const independentSources = new Set(cited.map((item) => item.sourceId)).size;

    if (independentSources < MIN_INDEPENDENT_SOURCES) {
      dropped += 1;
      await emit(deps, 'cluster.dropped', {
        stage: 'S3',
        name: cluster.name,
        independentSources,
        evidenceIds,
        reason: 'insufficient_independence',
      });
      continue;
    }

    const inserted = await deps.repo.insertOpportunity({
      runId: ctx.runId,
      name: cluster.name,
      positioning: cluster.positioning,
      independentSources,
      evidenceIds,
    });
    // Losing the store is not one bad cluster: later stages would read a gap.
    if (!inserted.ok) return inserted;

    opportunities += 1;
    await emit(deps, 'cluster.created', {
      stage: 'S3',
      opportunityId: inserted.value.id,
      name: cluster.name,
      positioning: cluster.positioning,
      independentSources,
      evidenceIds,
    });
  }

  return ok({ opportunities, dropped });
}
