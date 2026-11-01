import { z } from 'zod';

import type { LlmPort, Prompt } from '@/lib/llm/port';
import { assertAlive } from '@/lib/quota/deadline';
import { ok, type Result } from '@/lib/quota/types';
import type { ScoringEvidenceRow } from '@/lib/runs/evidence-repository';
import type { OpportunityRow } from '@/lib/runs/opportunities-repository';
import { aggregateEvidence } from '@/lib/scoring/aggregate';
import { scoreOpportunity, type OrdinalSelections } from '@/lib/scoring/rubric';
import type { DimensionScore } from '@/lib/scoring/types';
import { deriveVerdict } from '@/lib/scoring/verdict';

import type { RunContext, StageOutcome } from './context';

/** The three ordinals the model may answer; anything else is not in the schema. */
const THREE_TIERS = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const TWO_TIERS = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const citedIds = z.array(z.number().int().positive());

/**
 * What one rating call returns. There is no score field on purpose: the model
 * only picks a tier and cites the evidence rows that justify it, and the code
 * multiplies the tier by 5 (spec §9). A model that cannot emit a number cannot
 * invent one.
 */
export const ordinalsSchema = z.object({
  acquisition: z.object({ ordinal: THREE_TIERS, evidenceIds: citedIds }).optional(),
  profit: z.object({ ordinal: THREE_TIERS, evidenceIds: citedIds }).optional(),
  /** Feasibility stops at 2: spec §9 has no "everything is ready-made" tier 3. */
  feasibility: z.object({ ordinal: TWO_TIERS, evidenceIds: citedIds }).optional(),
});

export type OrdinalAnswer = z.infer<typeof ordinalsSchema>;

/** Enough of a quote to justify a tier; the model never needs the full snapshot. */
export const MAX_QUOTE_IN_PROMPT = 120;

export interface S4Summary {
  /** Opportunities that were scored and stored. */
  opportunities: number;
  /** Decision → how many opportunities landed on it. */
  decisions: Record<string, number>;
}

export interface ScoreDeps {
  llm: LlmPort;
  repo: {
    listOpportunities(runId: number): Promise<Result<OpportunityRow[]>>;
    /** Rows behind one opportunity's `evidenceIds`; rejected rows are filtered here. */
    listEvidenceByIds(ids: readonly number[]): Promise<Result<ScoringEvidenceRow[]>>;
    /** Replaces the opportunity's seven rows atomically; never appends. */
    replaceScores(opportunityId: number, scores: readonly DimensionScore[]): Promise<Result<void>>;
  };
  /** Optional audit log; its failure never fails the run. */
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

/**
 * Telemetry must never abort scoring: scores already stored stay stored even if
 * writing the event fails.
 */
async function emit(
  deps: Pick<ScoreDeps, 'onEvent'>,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.onEvent?.(type, payload);
  } catch {
    // Intentionally swallowed: the scores row is the durable record.
  }
}

/** One line per evidence row, whitespace collapsed so a quote cannot break the list. */
function summarize(item: ScoringEvidenceRow): string {
  const quote = item.quote.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_IN_PROMPT);
  const price =
    item.priceMentioned === null
      ? '无'
      : `${item.priceMentioned.amount} ${item.priceMentioned.currency}`;

  return [
    `id=${item.id}`,
    `signal=${item.signal}`,
    `platform=${item.platform}`,
    `price=${price}`,
    `quote="${quote}"`,
  ].join(' | ');
}

/**
 * The anchors are the whole contract of the ordinal call: the model may only
 * choose one of these tiers, and the numbers never leave the prompt. They are
 * quoted from spec §9 so a model asked to "score 0–10" cannot silently invent
 * its own scale.
 */
export function buildScoringPrompt(
  opportunity: Pick<OpportunityRow, 'name' | 'positioning' | 'independentSources'>,
  evidence: readonly ScoringEvidenceRow[],
): Prompt {
  const system = [
    '你是商业机会评级助手。你的唯一任务是为获客可行性、收入潜力、技术可行性各选一个档位（序数），并附上支撑该档位的证据 id。分数由代码计算，你不得输出任何分数、百分比或优先级。',
    '',
    '档位锚点（只能从中选一个）：',
    '获客可行性（0–3）：',
    '0 = 无任何可行渠道证据',
    '1 = 仅泛化渠道（“发小红书”“做 SEO”）',
    '2 = 具体社区/关键词/帖子位置证据',
    '3 = 有已付费投放、渠道成本或社区版主/群主入口证据',
    '收入潜力（0–3）：',
    '0 = 无价格证据',
    '1 = 只有免费替代品',
    '2 = 竞品有公开定价页',
    '3 = 用户已实际支付的价格 + 可覆盖成本的结构',
    '技术可行性（0–2）：',
    '0 = 存在不可控依赖或合规阻断',
    '1 = 依赖第三方但可替换',
    '2 = 全部可用现成 API / 开源组件',
    '',
    '硬性规则：',
    '1. evidenceIds 只能填输入中出现过的 id，至少 1 条；没有证据支撑的维度就不要输出该键。',
    '2. 不得编造证据、价格、竞品或市场规模；证据没说的内容一律不要补。',
    '3. 不得输出 score、评分、评级或任何 0–100 的数字。',
    '4. 技术可行性最高只有 2 档。',
  ].join('\n');

  const user = [
    `机会：${opportunity.name ?? '（未命名机会）'}（定位：${opportunity.positioning ?? '未给出'}；独立来源 ${opportunity.independentSources} 个）`,
    '',
    '证据列表（每行一条）：',
    ...evidence.map(summarize),
    '',
    '请返回 JSON：{"acquisition":{"ordinal":0-3,"evidenceIds":[1]},"profit":{"ordinal":0-3,"evidenceIds":[1]},"feasibility":{"ordinal":0-2,"evidenceIds":[1]}}',
  ].join('\n');

  return { system, user };
}

/** Dedupes and keeps only ids the model was actually shown. */
function sanitizeChoice<T extends number>(
  choice: { ordinal: T; evidenceIds: number[] } | undefined,
  allowed: ReadonlySet<number>,
): { ordinal: T; evidenceIds: number[] } | undefined {
  if (choice === undefined) return undefined;
  return {
    ordinal: choice.ordinal,
    evidenceIds: [...new Set(choice.evidenceIds)].filter((id) => allowed.has(id)),
  };
}

/**
 * A hallucinated `e99` must not buy points: the same rule S3 applies to clusters.
 * The three keys are rebuilt one by one because `exactOptionalPropertyTypes`
 * distinguishes "absent" from "present and undefined".
 */
function toSelections(answer: OrdinalAnswer, allowed: ReadonlySet<number>): OrdinalSelections {
  const selections: OrdinalSelections = {};

  const acquisition = sanitizeChoice(answer.acquisition, allowed);
  if (acquisition !== undefined) selections.acquisition = acquisition;

  const profit = sanitizeChoice(answer.profit, allowed);
  if (profit !== undefined) selections.profit = profit;

  const feasibility = sanitizeChoice(answer.feasibility, allowed);
  if (feasibility !== undefined) selections.feasibility = feasibility;

  return selections;
}

/**
 * The rubric counts sources and signals without keeping the row ids, but a
 * score without a citation is not admissible (spec §9). Attaching the accepted
 * rows behind each counted dimension is what lets the credibility gate mean
 * something; ordinal dimensions already carry the ids the model cited.
 *
 * `unknownReason` has no column in `scores`, so it is appended to the rationale:
 * a missing input must survive the write as a stated unknown, not vanish.
 */
function toStoredScore(
  score: DimensionScore,
  accepted: readonly ScoringEvidenceRow[],
): DimensionScore {
  let evidenceIds = score.evidenceIds;

  if (score.dimension === 'needs') {
    evidenceIds = accepted.map((row) => row.id);
  } else if (score.dimension === 'payment') {
    evidenceIds = accepted.filter((row) => row.signal === 'paying').map((row) => row.id);
  } else if (score.dimension === 'longevity') {
    evidenceIds = accepted.filter((row) => row.signal === 'recurring').map((row) => row.id);
  }

  return {
    ...score,
    evidenceIds,
    ...(score.unknownReason === undefined
      ? {}
      : { rationale: `${score.rationale}（未知：${score.unknownReason}）` }),
  };
}

/**
 * S4: opportunities → seven-dimension rubric → `scores`, with credibility and
 * the five-way decision computed in code. The model answers only three ordinals;
 * every counted dimension comes from the evidence aggregate, and a missing
 * ordinal scores 0 with its reason recorded rather than being estimated.
 *
 * Replacing the scores (not appending) keeps a re-run idempotent: the stage is
 * safe to resume after a crash, and `scores` always equals the last verdict.
 */
export async function scoreS4(ctx: RunContext, deps: ScoreDeps): Promise<StageOutcome<S4Summary>> {
  const now = deps.now ?? (() => new Date());

  // Stage entrance check, before reading opportunities or calling the model.
  const alive = assertAlive(ctx.deadlineAt, now());
  if (!alive.ok) return alive;

  const listed = await deps.repo.listOpportunities(ctx.runId);
  if (!listed.ok) return listed;

  let opportunities = 0;
  const decisions: Record<string, number> = {};

  for (const opportunity of listed.value) {
    const fetched = await deps.repo.listEvidenceByIds(opportunity.evidenceIds);
    if (!fetched.ok) return fetched;

    const accepted = fetched.value.filter((row) => row.rejectedReason === null);
    const aggregate = aggregateEvidence(accepted);

    // With nothing to cite, every ordinal is 0 by construction; asking the
    // model would only invite it to attach a tier to evidence it cannot see.
    let answer: OrdinalAnswer = {};
    if (accepted.length > 0) {
      const asked = await deps.llm.structured(
        ordinalsSchema,
        buildScoringPrompt(opportunity, accepted),
        { profile: 'quality', fallbackProfile: 'bulk', timeoutMs: 90_000 },
      );
      if (!asked.ok) {
        return {
          ok: false,
          code: 'LLM_UNAVAILABLE',
          message: `机会 ${opportunity.id} 评级失败：${asked.message}`,
        };
      }
      answer = asked.value.data;
    }

    const allowed = new Set(accepted.map((row) => row.id));
    const scored = scoreOpportunity({
      aggregate,
      ordinals: toSelections(answer, allowed),
    });
    const scores = scored.scores.map((score) => toStoredScore(score, accepted));

    const verdict = deriveVerdict(scores, aggregate.n);

    const stored = await deps.repo.replaceScores(opportunity.id, scores);
    if (!stored.ok) return stored;

    opportunities += 1;
    decisions[verdict.decision.decision] = (decisions[verdict.decision.decision] ?? 0) + 1;

    await emit(deps, 'opportunity.scored', {
      opportunityId: opportunity.id,
      total: verdict.total,
      grade: verdict.credibility.grade,
      decision: verdict.decision.decision,
    });
  }

  return ok({ opportunities, decisions });
}
