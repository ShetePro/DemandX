import '@/lib/db/load-env';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { z } from 'zod';
import type { ZodType } from 'zod';

import type { closeDb } from '@/lib/db/client';
import { buildExtractionPrompt } from '@/lib/evidence/prompt';
import { gateQuote } from '@/lib/evidence/quote-gate';
import { MAX_ITEMS_PER_PAGE, evidenceExtractionSchema } from '@/lib/evidence/schema';
import {
  checkLabels,
  computeMetrics,
  matchQuote,
  type LabeledPage,
  type Metrics,
  type PageOutcome,
} from '@/lib/eval/extract-metrics';
import { createLlmPort } from '@/lib/llm';
import type { ChainItem, LlmPort, Prompt, Usage } from '@/lib/llm/port';
import type { getChain } from '@/lib/llm/chain-repository';
import type { resolveApiKey } from '@/lib/llm/repository';
import type { AppErrorCode, Result } from '@/lib/llm/types';

/**
 * Extraction recall harness. Runs the real S2 path (same prompt, same schema,
 * same quote gate) against a human-labeled fixture and reports recall and
 * precision.
 *
 * Exit codes are part of the contract, so CI can tell "the prompt got worse"
 * (1) from "there was nothing to measure with" (2) and "the labels are broken"
 * (3).
 */
export const EXIT_OK = 0;
export const EXIT_THRESHOLD = 1;
export const EXIT_UNAVAILABLE = 2;
export const EXIT_LABELS = 3;
export const EXIT_USAGE = 64;

/** Below this an extraction prompt is not fit to ship. */
export const RECALL_FLOOR = 0.6;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

export const FIXTURE_PATH = path.join(REPO_ROOT, 'tests/fixtures/extract/labeled.json');

export const USAGE = [
  '用法：pnpm exec tsx scripts/eval-extract.ts [--dry]',
  '',
  '  --dry  用标注集的 expectedQuotes 冒充模型输出，只验证指标与匹配逻辑（无需数据库与模型）',
  '',
  '退出码：',
  `  ${EXIT_OK}  通过（recall >= ${RECALL_FLOOR}）`,
  `  ${EXIT_THRESHOLD}  recall 低于阈值，输出 FAIL_THRESHOLD`,
  `  ${EXIT_UNAVAILABLE}  没有可用模型（bulk 链为空、模型不可达、数据库不可用）`,
  `  ${EXIT_LABELS}  标注集自检失败（引用不在正文里、超出长度、重复、缺字段）`,
  `  ${EXIT_USAGE}  参数错误`,
].join('\n');

/** One page whose extraction call failed; it still counts as a page and lowers recall. */
export interface PageFailure {
  pageId: string;
  code: AppErrorCode;
  message: string;
}

/** `Metrics` plus what the table needs to explain them. */
export type Evaluation = Metrics & {
  outcomes: PageOutcome[];
  failures: PageFailure[];
};

const rawPageSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().min(1).optional(),
  textPath: z.string().trim().min(1).optional(),
  expectedQuotes: z.array(z.string()).min(1),
});

const fixtureSchema = z.object({ pages: z.array(rawPageSchema).min(1) });

function fail<T>(message: string): Result<T> {
  return { ok: false, code: 'VALIDATION_FAILED', message };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * For a dry run the model is the labels themselves. Matching then reduces to
 * "does the harness compare quotes correctly", which is what CI can afford to
 * run on every commit. The fake port finds its page by the prompt body, so it
 * stays tied to the page evaluate() is actually asking about.
 */
export function createDryLlm(pages: readonly LabeledPage[]): LlmPort {
  const used: ChainItem = {
    providerId: 0,
    providerName: 'dry-run',
    kind: 'ollama',
    baseUrl: 'dry://labels',
    modelId: 'fixture-label',
    headers: {},
  };

  return {
    async structured<T>(
      schema: ZodType<T>,
      prompt: Prompt,
    ): Promise<Result<{ data: T; used: ChainItem; usage: Usage }>> {
      const page = pages.find((candidate) => prompt.user.includes(candidate.text));
      const items =
        page === undefined
          ? []
          : page.expectedQuotes.map((quote) => ({
              quote,
              signal: 'problem' as const,
              firstHand: true,
              publishedAt: null,
              priceMentioned: null,
              supports: '标注集给定的预期引用',
              doesNotProve: '仅用于评估指标逻辑，不构成市场证据',
            }));

      const parsed = schema.safeParse({ items });
      if (!parsed.success) {
        return {
          ok: false,
          code: 'VALIDATION_FAILED',
          message: `dry 输出与 schema 不符（${parsed.error.issues.length} 处）`,
        };
      }
      return { ok: true, value: { data: parsed.data, used, usage: { in: 0, out: 0 } } };
    },

    async text() {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'dry 模式不调用 text' };
    },
  };
}

/**
 * One page costs one call; every candidate quote is judged by `gateQuote`
 * exactly as S2 stores it, so recall is measured on evidence that would
 * actually reach the evidence store. A failed call leaves the page's expected
 * quotes unrecalled rather than silently skipping the page.
 */
export async function evaluate({
  llm,
  pages,
}: {
  llm: LlmPort;
  pages: readonly LabeledPage[];
}): Promise<Evaluation> {
  const outcomes: PageOutcome[] = [];
  const failures: PageFailure[] = [];

  for (const page of pages) {
    const prompt = buildExtractionPrompt({
      url: `fixture://${page.id}`,
      platform: 'fixture',
      text: page.text,
    });
    const extracted = await llm.structured(evidenceExtractionSchema, prompt, { profile: 'bulk' });

    if (!extracted.ok) {
      failures.push({ pageId: page.id, code: extracted.code, message: extracted.message });
      outcomes.push({
        id: page.id,
        text: page.text,
        expectedQuotes: page.expectedQuotes,
        acceptedQuotes: [],
        rejected: 0,
      });
      continue;
    }

    const acceptedQuotes: string[] = [];
    let rejected = 0;
    for (const item of extracted.value.data.items.slice(0, MAX_ITEMS_PER_PAGE)) {
      const gate = gateQuote(page.text, item.quote);
      if (gate.ok) acceptedQuotes.push(item.quote);
      else rejected += 1;
    }

    outcomes.push({
      id: page.id,
      text: page.text,
      expectedQuotes: page.expectedQuotes,
      acceptedQuotes,
      rejected,
    });
  }

  return { ...computeMetrics(outcomes), outcomes, failures };
}

async function readTextSnapshot(textPath: string): Promise<string> {
  const absolute = path.isAbsolute(textPath) ? textPath : path.resolve(REPO_ROOT, textPath);
  const buffer = await readFile(absolute);
  return absolute.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
}

async function loadFixture(): Promise<Result<LabeledPage[]>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  } catch (error) {
    return fail(`无法读取标注集 ${FIXTURE_PATH}：${describe(error)}`);
  }

  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('；');
    return fail(`标注集格式不符：${detail}`);
  }

  const pages: LabeledPage[] = [];
  for (const page of parsed.data.pages) {
    let text = page.text;
    if (text === undefined) {
      if (page.textPath === undefined) return fail(`页面 ${page.id} 缺少 text 与 textPath`);
      try {
        text = await readTextSnapshot(page.textPath);
      } catch (error) {
        return fail(`页面 ${page.id} 无法读取 ${page.textPath}：${describe(error)}`);
      }
    }
    pages.push({ id: page.id, text, expectedQuotes: page.expectedQuotes });
  }

  return { ok: true, value: pages };
}

/**
 * A module and its CJS-interop shadow: tsx loads these files as CJS, so a
 * dynamic import can expose the exports only under `default`.
 */
type Interop<T> = T & { default?: T };

type ChainModule = { getChain: typeof getChain };
type ProviderModule = { resolveApiKey: typeof resolveApiKey };
type DbModule = { closeDb: typeof closeDb };

type WiredChain = { llm: LlmPort; close: () => Promise<void> };

/**
 * The real chain, bulk first: extraction actually runs there, so an eval on the
 * quality chain would measure a prompt that S2 never sends. Both the bulk chain
 * being empty and the database being unreachable are reported as "no model",
 * because neither can produce a number.
 */
async function createChainLlm(): Promise<Result<WiredChain>> {
  if ((process.env.DATABASE_URL?.trim() ?? '') === '') {
    return fail(
      '没有可用的模型：DATABASE_URL 未设置（复制 .env.example 为 .env，并运行 docker compose up -d）',
    );
  }

  // Static imports are impossible here: `db/client` throws while being
  // evaluated when DATABASE_URL is unset, and the contract says that case must
  // end as exit code 2 with a reason, not as an uncaught import failure.
  let chains: ChainModule;
  let providers: ProviderModule;
  let client: DbModule;
  try {
    const chainModule: Interop<ChainModule> = await import('@/lib/llm/chain-repository');
    const providerModule: Interop<ProviderModule> = await import('@/lib/llm/repository');
    const clientModule: Interop<DbModule> = await import('@/lib/db/client');
    chains = chainModule.default ?? chainModule;
    providers = providerModule.default ?? providerModule;
    client = clientModule.default ?? clientModule;
  } catch (error) {
    return fail(`没有可用的模型：数据库连接失败（${describe(error)}）`);
  }

  // Importing the client opened the pool; a failure path must drain it or the
  // process would hang after printing its reason.
  const close = () => client.closeDb();
  const withoutChain = async (message: string): Promise<Result<WiredChain>> => {
    await close().catch(() => undefined);
    return fail(message);
  };

  const chain = await chains.getChain('bulk');
  if (!chain.ok) {
    return withoutChain(`没有可用的模型：读取 bulk 链失败（${chain.code} ${chain.message}）`);
  }
  if (chain.value.length === 0) {
    return withoutChain(
      '没有可用的模型：bulk 链为空。请在设置页配置 provider 与模型，或使用 --dry 只验证指标逻辑。',
    );
  }

  const llm = createLlmPort({ loadChain: chains.getChain, resolveApiKey: providers.resolveApiKey });
  return { ok: true, value: { llm, close } };
}

function printReport(evaluation: Evaluation, dry: boolean): void {
  const failed = new Map(evaluation.failures.map((failure) => [failure.pageId, failure.code]));
  const acceptedTotal = evaluation.outcomes.reduce(
    (total, page) => total + page.acceptedQuotes.length,
    0,
  );

  const lines = [
    `## 抽取质量评估${dry ? '（--dry：标签冒充模型输出）' : ''}`,
    '',
    '| 页面 | 期望 | 接受 | 命中 | 拒绝 | 模型失败 |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const page of evaluation.outcomes) {
    const hits = page.expectedQuotes.filter((expected) =>
      page.acceptedQuotes.some((accepted) => matchQuote(expected, accepted, page.text)),
    ).length;
    lines.push(
      `| ${page.id} | ${page.expectedQuotes.length} | ${page.acceptedQuotes.length} | ${hits} | ${page.rejected} | ${failed.get(page.id) ?? '—'} |`,
    );
  }

  lines.push(
    `| 合计 | ${evaluation.expected} | ${acceptedTotal} | ${evaluation.recalled} | ${evaluation.rejected} | ${evaluation.failures.length} |`,
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    `| 页数 | ${evaluation.pages} |`,
    `| 期望引用 | ${evaluation.expected} |`,
    `| 命中引用 | ${evaluation.recalled} |`,
    `| recall | ${evaluation.recall.toFixed(2)} |`,
    `| precision | ${evaluation.precision.toFixed(2)} |`,
    `| 被 gate 拒绝 | ${evaluation.rejected} |`,
  );

  console.log(lines.join('\n'));

  for (const failure of evaluation.failures) {
    console.error(`模型调用失败 ${failure.pageId}: ${failure.code} ${failure.message}`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const unknown = argv.filter((arg) => arg !== '--dry');
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  const dry = argv.includes('--dry');

  const loaded = await loadFixture();
  if (!loaded.ok) {
    console.error(loaded.message);
    return EXIT_LABELS;
  }
  const pages = loaded.value;

  const issues = checkLabels(pages);
  if (issues.length > 0) {
    console.error(`标注集自检失败（${issues.length} 处）：`);
    for (const issue of issues) {
      console.error(
        `- ${issue.pageId} ${issue.reason}${issue.quote === null ? '' : `：${issue.quote}`}`,
      );
    }
    return EXIT_LABELS;
  }

  let llm: LlmPort;
  let close: (() => Promise<void>) | null = null;
  if (dry) {
    llm = createDryLlm(pages);
  } else {
    const wired = await createChainLlm();
    if (!wired.ok) {
      console.error(wired.message);
      return EXIT_UNAVAILABLE;
    }
    llm = wired.value.llm;
    close = wired.value.close;
  }

  try {
    const evaluation = await evaluate({ llm, pages });
    printReport(evaluation, dry);

    if (!dry && evaluation.failures.length === pages.length) {
      const first = evaluation.failures[0];
      console.error(
        `没有可用的模型：${pages.length} 页全部调用失败${
          first === undefined ? '' : `（首个：${first.code} ${first.message}）`
        }`,
      );
      return EXIT_UNAVAILABLE;
    }

    if (evaluation.recall < RECALL_FLOOR) {
      console.error(
        `FAIL_THRESHOLD: recall ${evaluation.recall.toFixed(2)} < ${RECALL_FLOOR.toFixed(2)}`,
      );
      return EXIT_THRESHOLD;
    }

    return EXIT_OK;
  } finally {
    if (close !== null) await close().catch(() => undefined);
  }
}

// Only run when executed directly: importing this module in tests must not
// touch the fixture or the database. No top-level await — tsx loads this as CJS.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(describe(error));
      process.exitCode = EXIT_UNAVAILABLE;
    });
}
