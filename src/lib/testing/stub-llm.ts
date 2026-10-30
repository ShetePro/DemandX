/**
 * Deterministic stand-in for the LLM, used by `scripts/acceptance.ts` and by
 * tests. NEVER import this from production code: the answers below are fixed
 * strings, not model output, and the acceptance script's whole premise is that
 * they prove the pipeline's contract — nothing about extraction quality.
 *
 * Routing is by the schema's top-level keys, so each stage gets an answer shaped
 * the way that stage actually parses:
 *
 *   `items`                 → S2 extraction (one quote copied from the prompt body)
 *   `clusters`              → S3 clustering (one cluster over the first 6 ids)
 *   `acquisition`/…         → S4 ordinals (tier 2 for all three dimensions)
 *   `sections`              → S5/S6 report (one claim per section, plus one
 *                             deliberately uncitable finance claim)
 *
 * Every answer is still run through the caller's schema before it is returned;
 * a stub that cannot satisfy the schema reports `LLM_BAD_OUTPUT` instead of
 * handing a malformed object to a stage.
 */

import type { ZodType } from 'zod';

import { MAX_QUOTE_LENGTH, MIN_QUOTE_LENGTH, SIGNALS } from '@/lib/evidence/schema';
import type { ChainItem, LlmPort, Prompt, Usage } from '@/lib/llm/port';
import type { Result } from '@/lib/llm/types';
import { REPORT_SECTIONS, type ReportSection } from '@/lib/report/validate';

/** The fake provider every stub call reports as `used`. */
export const STUB_CHAIN: ChainItem = {
  providerId: 0,
  providerName: 'deterministic-stub',
  kind: 'openai-compatible',
  baseUrl: 'stub://acceptance',
  modelId: 'stub-deterministic',
  headers: {},
};

export const STUB_CLUSTER_NAME = '库存同步与超卖';
export const STUB_CLUSTER_POSITIONING = '多渠道卖家手工核对库存，导致超卖与缺货';

/**
 * The one claim the report answer deliberately cannot cite: its `evidenceIds`
 * point at a row this run never stored, so S5's sanitizer must move it to
 * `unknowns`. The acceptance test reads this constant back.
 */
export const FINANCE_UNREFERENCED_CLAIM = '财务模型：缺少可引用的收入证据，按未知处理';

/** Offsets the bogus id far past any real row, so it can never collide. */
const BOGUS_ID_OFFSET = 1_000_000;

/** Placeholder prose per section; the `【假模型】` prefix makes fake text obvious. */
const SECTION_CLAIMS: Record<ReportSection, string> = {
  summary: '【假模型】执行摘要：基于已接受证据的占位结论',
  evidence: '【假模型】需求证据：基于已接受证据的占位结论',
  competitors: '【假模型】竞品调查：基于已接受证据的占位结论',
  ranking: '【假模型】机会排名：基于已接受证据的占位结论',
  bestDirection: '【假模型】最佳方向：基于已接受证据的占位结论',
  finance: '【假模型】财务模型：基于已接受证据的占位结论',
  plan: '【假模型】14 天验证计划：基于已接受证据的占位结论',
  decision: '【假模型】最终决策：基于已接受证据的占位结论',
};

/** What `schema` is asking for; `null` means the stub has no answer for it. */
type Route = 'extract' | 'cluster' | 'ordinals' | 'sections';

/**
 * `LlmPort` plus the call log the acceptance script asserts on. Returning the
 * subtype is still an `LlmPort`, so stages cannot see or depend on `calls`.
 */
export interface StubLlm extends LlmPort {
  /** One entry per `structured()` call, in order: `extract`, `cluster`, … */
  calls: string[];
}

/**
 * Top-level keys of a Zod object schema. `shape` is not on `ZodType`, so it is
 * narrowed at runtime instead of asserted: a schema without it routes nowhere.
 */
function schemaKeys(schema: ZodType<unknown>): Set<string> {
  if (!('shape' in schema)) return new Set();

  const shape: unknown = schema.shape;
  if (typeof shape !== 'object' || shape === null) return new Set();

  return new Set(Object.keys(shape));
}

function routeOf(schema: ZodType<unknown>): Route | null {
  const keys = schemaKeys(schema);

  if (keys.has('items')) return 'extract';
  if (keys.has('clusters')) return 'cluster';
  if (keys.has('sections')) return 'sections';
  // The ordinals schema is the only one shaped as the three rubric tiers.
  if (keys.has('acquisition') || keys.has('profit') || keys.has('feasibility')) return 'ordinals';
  return null;
}

/** The page body between the prompt's `"""` fences, or the whole user turn. */
function promptBody(user: string): string {
  const open = user.indexOf('"""');
  if (open === -1) return user.trim();

  const close = user.lastIndexOf('"""');
  if (close <= open) return user.slice(open + 3).trim();
  return user.slice(open + 3, close).trim();
}

/**
 * The first sentence of the body, split on `。！？` or a newline; a fragment too
 * short to be a quote falls back to the first 20 characters. The result is a
 * verbatim prefix of the body, which is what the quote gate checks.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';

  let end = trimmed.length;
  for (const mark of ['。', '！', '？', '\n']) {
    const index = trimmed.indexOf(mark);
    if (index !== -1 && index + 1 < end) end = index + 1;
  }

  let quote = trimmed.slice(0, end).trim();
  if (quote.length < MIN_QUOTE_LENGTH) quote = trimmed.slice(0, 20).trim();
  return quote.slice(0, MAX_QUOTE_LENGTH);
}

/**
 * Ids the prompt lists, one per line (`id=12 | …`). Anchored at the line start
 * so an id inside a quoted sentence is never mistaken for a listed row.
 */
function listedIds(prompt: Prompt): number[] {
  const ids: number[] = [];

  for (const match of prompt.user.matchAll(/^id[=:]\s*(\d+)/gm)) {
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) ids.push(id);
  }

  return ids;
}

/** One extraction answer: one quote, with the five signals rotating by call. */
function extractionAnswer(prompt: Prompt, call: number): unknown {
  const quote = firstSentence(promptBody(prompt.user));
  if (quote === '') return { items: [] };

  return {
    items: [
      {
        quote,
        signal: SIGNALS[call % SIGNALS.length] ?? 'problem',
        firstHand: true,
        publishedAt: null,
        priceMentioned: null,
        supports: '用户自述遇到该问题',
        doesNotProve: '不能证明用户愿意付费',
      },
    ],
  };
}

/** One cluster over the first six listed ids; never an id the prompt omitted. */
function clusterAnswer(prompt: Prompt): unknown {
  const evidenceIds = [...new Set(listedIds(prompt))].slice(0, 6);
  if (evidenceIds.length === 0) return { clusters: [] };

  return {
    clusters: [
      {
        name: STUB_CLUSTER_NAME,
        positioning: STUB_CLUSTER_POSITIONING,
        evidenceIds,
      },
    ],
  };
}

/** Tier 2 on all three ordinals, citing the first three listed evidence rows. */
function ordinalsAnswer(prompt: Prompt): unknown {
  const evidenceIds = [...new Set(listedIds(prompt))].slice(0, 3);

  return {
    acquisition: { ordinal: 2, evidenceIds },
    profit: { ordinal: 2, evidenceIds },
    feasibility: { ordinal: 2, evidenceIds },
  };
}

/**
 * Eight sections, one claim each citing the first whitelisted id. `finance`
 * gets a second claim whose id is not in the prompt, so S5 must evict it into
 * `unknowns` rather than let an unreferenced assertion into the body.
 */
function reportAnswer(prompt: Prompt): unknown {
  const ids = [...new Set(listedIds(prompt))];
  const first = ids[0];
  if (first === undefined) return { sections: {} };

  const bogus = Math.max(...ids) + BOGUS_ID_OFFSET;
  const sections: Record<
    string,
    { claims: { text: string; evidenceIds: number[] }[]; unknowns: string[] }
  > = {};

  for (const section of REPORT_SECTIONS) {
    const claims = [{ text: SECTION_CLAIMS[section], evidenceIds: [first] }];
    if (section === 'finance') {
      claims.push({ text: FINANCE_UNREFERENCED_CLAIM, evidenceIds: [bogus] });
    }
    sections[section] = { claims, unknowns: [] };
  }

  return { sections };
}

function answerFor(route: Route, prompt: Prompt, extractions: number): unknown {
  switch (route) {
    case 'extract':
      return extractionAnswer(prompt, extractions);
    case 'cluster':
      return clusterAnswer(prompt);
    case 'ordinals':
      return ordinalsAnswer(prompt);
    case 'sections':
      return reportAnswer(prompt);
  }
}

/**
 * A fresh stub per run. `calls` grows in call order, which is what the
 * acceptance script asserts on; `extractions` only drives signal rotation.
 */
export function createStubLlm(): StubLlm {
  const calls: string[] = [];
  let extractions = 0;

  function record(route: Route): void {
    calls.push(route);
  }

  return {
    calls,

    async structured<T>(
      schema: ZodType<T>,
      prompt: Prompt,
    ): Promise<Result<{ data: T; used: ChainItem; usage: Usage }>> {
      const route = routeOf(schema);
      if (route === null) {
        calls.push('unsupported');
        return {
          ok: false,
          code: 'LLM_BAD_OUTPUT',
          message: '假模型不支持该 schema：顶层键不在 items/clusters/ordinals/sections 之内',
        };
      }

      record(route);
      const answer = answerFor(route, prompt, extractions);
      if (route === 'extract') extractions += 1;

      const parsed = schema.safeParse(answer);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return {
          ok: false,
          code: 'LLM_BAD_OUTPUT',
          message: `假模型输出与 schema 不符：${detail}`,
        };
      }

      return {
        ok: true,
        value: { data: parsed.data, used: STUB_CHAIN, usage: { in: 0, out: 0 } },
      };
    },

    async text() {
      calls.push('text');
      return {
        ok: true,
        value: { text: '假模型不输出自由文本', used: STUB_CHAIN, usage: { in: 0, out: 0 } },
      };
    },
  };
}
