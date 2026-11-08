/**
 * S5's writer: turns one opportunity, its accepted evidence and S4's verdict
 * into the eight-part report body. The model writes prose only — it may not
 * score, may not choose the decision, and may not cite an evidence row this run
 * did not accept. Everything it emits is checked against those three rules
 * after the call, because a prompt is a request and this is the enforcement.
 */

import { z } from 'zod';

import type { Signal } from '@/lib/evidence/schema';
import type { LlmPort, Prompt } from '@/lib/llm/port';
import type { StageOutcome } from '@/lib/pipeline/context';
import { ok } from '@/lib/quota/types';
import type { Credibility } from '@/lib/scoring/credibility';
import type { DecisionResult } from '@/lib/scoring/decision';
import type { DimensionScore } from '@/lib/scoring/types';

import { REPORT_SECTIONS, type ReportSection, type ReportSectionBody } from './validate';

/** Eight parts, 1–6 claims each: enough to be a report, short enough to audit. */
export const MAX_CLAIMS_PER_SECTION = 6;
export const MAX_CLAIM_TEXT = 400;
export const MAX_UNKNOWNS_PER_SECTION = 12;
export const MAX_UNKNOWN_TEXT = 200;
export const MAX_INFERENCES_PER_SECTION = 3;
export const MAX_INFERENCE_TEXT = 300;

/** A claim moved out of the body keeps its text, marked as uncited. */
export const UNREFERENCED_PREFIX = '[未引用] ';

/** A headline the model wrote, e.g. `68/100`; only the derivation's total is legal. */
const SCORE_PATTERN = /(\d+)\s*\/\s*100/g;

/** An inline citation, e.g. `[e19]`; the number must be a row this run accepted. */
const EVIDENCE_REF_PATTERN = /\be(\d+)\b/gi;

/** A quote long enough to recognise the problem; the model never needs more. */
export const MAX_QUOTE_IN_PROMPT = 160;

/** One accepted evidence row as the report prompt shows it. */
export interface ReportEvidence {
  id: number;
  /** The page it came from; two quotes from one page are not two sources. */
  sourceId: number;
  signal: Signal;
  platform: string;
  quote: string;
  supports: string | null;
}

export interface ReportOpportunity {
  name: string | null;
  positioning: string | null;
  independentSources: number;
}

/**
 * S4's verdict, passed in whole. `total`, `credibility` and `decision` are code
 * output; the model is told to quote them, never to recompute them.
 */
export interface ReportDerivation {
  scores: readonly DimensionScore[];
  total: number;
  credibility: Credibility;
  decision: DecisionResult;
}

export interface AssembleInput {
  llm: LlmPort;
  opportunity: ReportOpportunity;
  /** Accepted rows only; the whitelist is built from this list. */
  evidence: readonly ReportEvidence[];
  derivation: ReportDerivation;
  /** The run's idea, used by the exploratory prompt. */
  idea?: string;
  /** No cluster cleared the gate: write an evidence-first exploration. */
  exploratory?: boolean;
}

/** The stored shape of `reports.sections`. */
export interface ReportSections {
  sections: Record<ReportSection, ReportSectionBody>;
}

const claimSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_TEXT),
  evidenceIds: z.array(z.number().int().positive()).min(1),
});

const sectionSchema = z.object({
  claims: z.array(claimSchema).min(1).max(MAX_CLAIMS_PER_SECTION),
  unknowns: z.array(z.string().trim().min(1).max(MAX_UNKNOWN_TEXT)).max(MAX_UNKNOWNS_PER_SECTION),
  /** Explicit analysis; no citations required, but no invented numbers either. */
  inferences: z
    .array(z.string().trim().min(1).max(MAX_INFERENCE_TEXT))
    .max(MAX_INFERENCES_PER_SECTION)
    .default([]),
});

/**
 * All eight parts are required by the schema, so an answer that drops one never
 * reaches the validator with seven sections and a hole.
 */
export const reportSectionsSchema = z.object({
  sections: z.object({
    summary: sectionSchema,
    evidence: sectionSchema,
    competitors: sectionSchema,
    ranking: sectionSchema,
    bestDirection: sectionSchema,
    finance: sectionSchema,
    plan: sectionSchema,
    decision: sectionSchema,
  }),
});

export type ReportAnswer = z.infer<typeof reportSectionsSchema>;

/** Claims may be empty in an exploratory section: inference carries the prose. */
const exploratorySectionSchema = sectionSchema.extend({
  claims: z.array(claimSchema).max(MAX_CLAIMS_PER_SECTION),
});

export const exploratoryReportSchema = z.object({
  sections: z.object({
    summary: exploratorySectionSchema,
    evidence: exploratorySectionSchema,
    competitors: exploratorySectionSchema,
    ranking: exploratorySectionSchema,
    bestDirection: exploratorySectionSchema,
    finance: exploratorySectionSchema,
    plan: exploratorySectionSchema,
    decision: exploratorySectionSchema,
  }),
});

/** Why a report has no prose: no evidence to cite, or no time left to write. */
export const NO_EVIDENCE_REASON = '本轮没有可引用的证据，报告只保留结论框架';
export const DEADLINE_REASON = '本轮已超过截止时间，正文未合成，仅保留已有评分与决策';

function emptyBody(reason: string): ReportSectionBody {
  return { claims: [], unknowns: [reason] };
}

/**
 * The degraded report: eight parts, no claims, the reason stated as an unknown.
 * It still passes `validateReport` (no uncited claim exists) and still carries
 * S4's total, grade and decision in the row, which is what the page shows.
 */
/**
 * Evidence exists, but no cluster cleared the three-source gate. The report
 * still shows what was actually collected — one quote per claim, each cited —
 * and says in plain words why no direction is recommended. This is not a
 * conclusion: every claim is a single-source observation.
 */
export function buildEvidenceOnlyReport(
  evidence: readonly ReportEvidence[],
  reason: string,
): ReportSections {
  const claims = evidence.slice(0, MAX_CLAIMS_PER_SECTION).map((row) => ({
    text: `[${row.platform}] “${row.quote.replace(/\s+/g, ' ').trim().slice(0, 160)}”`,
    evidenceIds: [row.id],
  }));

  return {
    sections: {
      summary: { claims: [], unknowns: [reason] },
      evidence: {
        claims,
        unknowns:
          evidence.length > claims.length
            ? [`仅列出前 ${claims.length} 条，其余 ${evidence.length - claims.length} 条在证据库。`]
            : [],
      },
      competitors: emptyBody('没有足够的独立来源对比竞品，暂时不判断竞争格局。'),
      ranking: emptyBody('没有方向达到证据门槛，暂时不排名。'),
      bestDirection: emptyBody('没有方向达到证据门槛，暂时不推荐方向。'),
      finance: emptyBody('缺少独立来源，暂时不估算收入与成本。'),
      plan: emptyBody('先按上面的线索做几次访谈或预售，再决定是否进入 14 天验证。'),
      decision: emptyBody('证据不足，暂时不能给出开发或放弃的结论。'),
    },
  };
}

export function buildEmptyReport(reason: string): ReportSections {
  return {
    sections: {
      summary: emptyBody(reason),
      evidence: emptyBody(reason),
      competitors: emptyBody(reason),
      ranking: emptyBody(reason),
      bestDirection: emptyBody(reason),
      finance: emptyBody(reason),
      plan: emptyBody(reason),
      decision: emptyBody(reason),
    },
  };
}

/** One line per evidence row, whitespace collapsed so a quote cannot break the list. */
function summarizeEvidence(item: ReportEvidence): string {
  const quote = item.quote.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_IN_PROMPT);
  return [
    `id=${item.id}`,
    `source=${item.sourceId}`,
    `signal=${item.signal}`,
    `platform=${item.platform}`,
    `supports=${item.supports ?? '未知'}`,
    `quote="${quote}"`,
  ].join(' | ');
}

/**
 * The prompt is the contract: only the given evidence, only the given numbers,
 * unsupported conclusions as unknowns. Rule 4 names the one legal way to write
 * a score, which is also what the post-check looks for.
 */
/**
 * The evidence-first exploratory prompt: no opportunity cleared the gate, so
 * the model may form hypotheses, but facts still need citations and every
 * judgement is labelled inference. This is what keeps sections 3–8 from being
 * empty while the corpus is thin.
 */
export function buildExploratoryPrompt(input: AssembleInput): Prompt {
  const list = input.evidence.map(summarizeEvidence).join('\n');

  return {
    system: `你是一名资深市场分析师。这次没有任何方向达到「3 个独立来源」的门槛，请基于已采集证据写一份**探索性分析报告**：可以把单源证据整理成假设，但不能把假设写成结论。

硬性规则：
1. 事实只能来自给定证据；每个 claim 的 evidenceIds 至少 1 个，且只能填列表里的 id。引用原文用中文引号，不得编造数字、价格、用户数或收入。
2. 竞品、财务、获客、风险等无法直接引用证据的判断，写进 inferences，并以“推断：”开头说明依据。
3. ranking / bestDirection 要给出明确倾向（哪个方向先做、为什么），以资深创业者/投资人的身份判断；证据不足时也要说“我倾向先验证 X”，而不是只罗列可能性。
4. finance 只能给带“假设”的区间，不得编造真实价格或收入。
5. plan 给出 14 天内可执行的访谈 / 预售 / 着陆页步骤。
6. decision 写“建议暂缓”，并列出还需要补齐的 3 类证据。
7. 八个 section 都必须有内容：claims 或 inferences 至少一个，不要只写“没有证据”。
8. 如果没有任何证据：claims 一律为空（不得编造）；inferences 仍要以“推断/假设”开头给出判断、优先级与验证动作。

输出 JSON：{ sections: { summary, evidence, competitors, ranking, bestDirection, finance, plan, decision } }。每个 section 形如 { claims: [{ text, evidenceIds }], inferences: string[], unknowns: string[] }。`,
    user: `想法：${input.idea ?? ''}\n\n${
      input.evidence.length === 0
        ? '本轮没有采集到任何外部证据：不要编造事实，claims 留空，用 inferences 给出假设性判断。'
        : `已接受证据（只能引用这些 id）：\n${list}`
    }`,
  };
}

export function buildReportPrompt(input: AssembleInput): Prompt {
  const { opportunity, evidence, derivation } = input;

  const system = [
    '你是一名资深市场分析师，同时具备独立开发者、创业者与早期投资人的判断视角。你的任务是把给定证据与评分整理成八部分中文报告：先用证据陈述事实，再做明确标注的推断分析（市场是否成立、卖点、护城河、获客、单位经济、风险），最后给出可执行的验证建议。',
    '',
    '硬性规则：',
    '1. 事实只能使用输入证据列表里的事实；每条 claim 的 evidenceIds 至少 1 个，且只能填列表中出现过的 id。',
    '2. 证据无法支撑的事实结论写进该节的 unknowns，不得写进 claims；不要把猜测伪装成事实。',
    '3. inferences 是分析判断，不是事实：每条以“推断：”开头，说明推理依据（例如“推断：竞品都按席位收费，说明…，但仍需验证…”）。允许讨论市场、卖点、护城河、获客与风险，但不得编造证据没有的数字、用户量、收入或市场规模。',
    `4. 不得新增任何数字：分数、占比、价格、用户数、市场规模只能原样引用输入。`,
    `5. 总分只能原样写成 “${derivation.total}/100”，不得改写、不得四舍五入、不得给出别的分数或优先级。`,
    '6. 决策只能原样引用输入中的决策，不得自行选择另一个决策。',
    '7. 八节齐全（summary、evidence、competitors、ranking、bestDirection、finance、plan、decision），每节 1–6 条 claim、0–3 条 inferences。',
    '8. 各节分析重点：summary 说清结论与为什么现在；competitors 说清替代方案、差异化与护城河；bestDirection 说清目标人群、卖点与定价假设；finance 说清成本结构与单用户经济；decision 给出投资人视角的风险、反方观点与什么情况下应放弃（kill criteria）；plan 给出可验证的实验。',
  ].join('\n');

  const user = [
    `机会：${opportunity.name ?? '（未命名机会）'}（定位：${opportunity.positioning ?? '未给出'}；独立来源 ${opportunity.independentSources} 个）`,
    '',
    '评分（由代码计算，只能原样引用，不得重算）：',
    `- 总分：${derivation.total}/100`,
    `- 可信度：${derivation.credibility.grade}（${derivation.credibility.reason}）`,
    `- 决策：${derivation.decision.decision}（${derivation.decision.reason}；下一步：${derivation.decision.nextStep}）`,
    ...derivation.scores.map(
      (score) => `- ${score.dimension}：${score.points} 分（${score.rationale}）`,
    ),
    '',
    '证据列表（每行一条，只能引用这些 id）：',
    ...evidence.map(summarizeEvidence),
    '',
    '请返回 JSON：{"sections":{"summary":{"claims":[{"text":"...","evidenceIds":[1]}],"unknowns":[],"inferences":["推断：..."]},"evidence":{...},"competitors":{...},"ranking":{...},"bestDirection":{...},"finance":{...},"plan":{...},"decision":{...}}}',
  ].join('\n');

  return { system, user };
}

/** Trimmed, non-empty, order-preserving dedupe. */
function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }

  return kept;
}

/**
 * A claim survives only if every citation resolves and every number it quotes
 * is the derivation's. One invented id (`e99`, or an id from another run) is
 * enough to evict the claim: a source that does not exist makes the assertion
 * untraceable however many real ids sit next to it.
 */
function isTraceable(text: string, whitelist: ReadonlySet<number>, total: number): boolean {
  for (const match of text.matchAll(EVIDENCE_REF_PATTERN)) {
    if (!whitelist.has(Number(match[1]))) return false;
  }

  for (const match of text.matchAll(SCORE_PATTERN)) {
    if (Number(match[1]) !== total) return false;
  }

  return true;
}

/**
 * Rejects a claim whose citations include any id this run did not accept, or
 * whose text quotes an unresolvable `eN` or a score the derivation did not
 * produce, and moves it to `unknowns` with its text intact. The body therefore
 * never carries a footnote that does not resolve.
 */
function sanitizeSection(
  body: z.infer<typeof sectionSchema>,
  whitelist: ReadonlySet<number>,
  total: number,
): ReportSectionBody {
  const claims: ReportSectionBody['claims'] = [];
  const unknowns = [...body.unknowns];
  const inferences = dedupeStrings(body.inferences).filter((text) =>
    isTraceable(text, whitelist, total),
  );

  for (const claim of body.claims) {
    const evidenceIds = [...new Set(claim.evidenceIds)];
    const allAccepted = evidenceIds.every((id) => whitelist.has(id));

    if (!allAccepted || !isTraceable(claim.text, whitelist, total)) {
      unknowns.push(`${UNREFERENCED_PREFIX}${claim.text}`);
      continue;
    }

    claims.push({ text: claim.text, evidenceIds });
  }

  return {
    claims,
    unknowns: dedupeStrings(unknowns),
    ...(inferences.length === 0 ? {} : { inferences }),
  };
}

/**
 * The report body, or a typed failure. No evidence means no model call: asking
 * it to write eight parts from an empty corpus would only invite fabrication,
 * so the degraded shell is produced directly.
 */
export async function buildReportSections(
  input: AssembleInput,
): Promise<StageOutcome<ReportSections>> {
  if (input.evidence.length === 0 && input.exploratory !== true) {
    return ok(buildEmptyReport(NO_EVIDENCE_REASON));
  }

  const schema = input.exploratory === true ? exploratoryReportSchema : reportSectionsSchema;
  const prompt = input.exploratory === true ? buildExploratoryPrompt(input) : buildReportPrompt(input);

  const asked = await input.llm.structured(schema, prompt, {
    // The exploratory report is already a degraded artefact: the fast chain
    // writes it, and waiting on a slow quality model only delays the fallback.
    profile: input.exploratory === true ? 'bulk' : 'quality',
    ...(input.exploratory === true ? {} : { fallbackProfile: 'bulk' as const }),
    timeoutMs: input.exploratory === true ? 60_000 : 90_000,
  });
  if (!asked.ok) {
    return { ok: false, code: 'LLM_UNAVAILABLE', message: `报告合成失败：${asked.message}` };
  }

  // The port already validates against this schema, but the report is the one
  // artefact that must never be written half-formed: re-checking here keeps the
  // guarantee local instead of relying on which adapter answered.
  const parsed = schema.safeParse(asked.value.data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, code: 'LLM_UNAVAILABLE', message: `报告结构不合 schema：${detail}` };
  }

  const whitelist = new Set(input.evidence.map((item) => item.id));
  const sections = {} as Record<ReportSection, ReportSectionBody>;

  for (const section of REPORT_SECTIONS) {
    sections[section] = sanitizeSection(
      parsed.data.sections[section],
      whitelist,
      input.derivation.total,
    );
  }

  return ok({ sections });
}
