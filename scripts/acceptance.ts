import '@/lib/db/load-env';

import { unlink } from 'node:fs/promises';

import { count, eq } from 'drizzle-orm';

import { closeDb, db } from '@/lib/db/client';
import {
  citations,
  evidence as evidenceTable,
  ideas,
  opportunities,
  reports,
  runs,
  sources,
} from '@/lib/db/schema';
import { gateQuote } from '@/lib/evidence/quote-gate';
import { readSnapshotText, writeSnapshot } from '@/lib/evidence/snapshot';
import type { RunContext } from '@/lib/pipeline/context';
import { extractS2 } from '@/lib/pipeline/s2-extract';
import { clusterS3 } from '@/lib/pipeline/s3-cluster';
import { scoreS4 } from '@/lib/pipeline/s4-score';
import { reportS5 } from '@/lib/pipeline/s5-report';
import { REPORT_SECTIONS, validateReport, type ReportSectionBody } from '@/lib/report/validate';
import { saveReport } from '@/lib/report/persist';
import {
  countEvidence,
  insertEvidence,
  listEvidenceByIds,
  listSourcesForExtraction,
} from '@/lib/runs/evidence-repository';
import {
  insertOpportunity,
  listAcceptedEvidence,
  listOpportunities,
} from '@/lib/runs/opportunities-repository';
import { createRun, createThread, getRunContext } from '@/lib/runs/repository';
import { listScores, replaceScores } from '@/lib/runs/scores-repository';
import { countSources, insertSource } from '@/lib/runs/sources-repository';
import type { DimensionScore } from '@/lib/scoring/types';
import {
  renderAcceptanceSummary,
  type AcceptanceStage,
  type AcceptanceSummary,
} from '@/lib/testing/acceptance-summary';
import { createStubLlm, FINANCE_UNREFERENCED_CLAIM, type StubLlm } from '@/lib/testing/stub-llm';

/**
 * End-to-end acceptance of S2–S6 with a deterministic stub model.
 *
 * This is a **contract** check, not a quality check: the stub's quotes, cluster,
 * ordinals and prose are fixed strings. Passing proves the quote gate, the
 * independence threshold, the rubric arithmetic, the report validator and the
 * persistence path agree with each other. It says nothing about recall,
 * precision, or whether a real model would produce the same shape.
 *
 * Exit codes: 0 all assertions passed; 1 a stage or assertion failed; 2 the
 * environment or arguments are unusable (no database, bad `--run`, …).
 */

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_SETUP = 2;

const USAGE = [
  '用法：pnpm exec tsx scripts/acceptance.ts [--run <id>]',
  '',
  '  不带参数      新建一个 run，插入 3 个 fixture 来源与快照，跑完 S2–S6 后删除。',
  '  --run <id>    在一个已有 sources 的 run 上跑 S2–S6；数据全部保留。',
  '  --help        显示本帮助。',
].join('\n');

const FIXTURE_IDEA = '验收：多渠道库存同步与超卖预警工具';

/**
 * Three fabricated pages. Only the first sentence of each is ever quoted (that
 * is what the stub does), and every page is a distinct source, which is what
 * lets S3 clear the three-independent-sources gate.
 */
const FIXTURE_PAGES: readonly { platform: string; text: string }[] = [
  {
    platform: 'v2ex',
    text: '我们三个店铺的库存每天都要手工对一遍，还是经常超卖。\n每次大促之后都要花两天时间核对订单和库存。',
  },
  {
    platform: 'xiaohongshu',
    text: '有没有能同时同步淘宝、抖音和拼多多库存的工具？现在漏单太多了。\n我找了一圈也没找到合适的方案。',
  },
  {
    platform: 'reddit',
    text: '我们每个月花两百块请人兼职对库存，还是会出现缺货。\n如果能自动化，我愿意为它付费。',
  },
];

/** A snapshot this invocation wrote, remembered so cleanup can remove it. */
interface WrittenSnapshot {
  hash: string;
  textPath: string;
}

interface Session {
  stub: StubLlm;
  mode: 'new' | 'existing';
  runId: number | null;
  ideaId: number | null;
  snapshots: WrittenSnapshot[];
}

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

interface Args {
  runId: number | null;
  help: boolean;
}

type ParsedArgs = { ok: true; args: Args } | { ok: false; error: string };

/** Setup failures are environment problems, not pipeline failures. */
class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let runId: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') return { ok: true, args: { runId, help: true } };

    if (arg === '--run') {
      const raw = argv[index + 1];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
        return { ok: false, error: '--run 需要一个正整数 run id' };
      }
      runId = parsed;
      index += 1;
      continue;
    }

    return { ok: false, error: `未知参数：${arg}` };
  }

  return { ok: true, args: { runId, help: false } };
}

/**
 * Insert the three fixture sources for `runId` unless the run already has any.
 * URLs carry the run id so the global `(canonical_url, content_hash)` unique
 * index can never hand back another run's row. The snapshot is content
 * addressed, so re-running the same fixture is idempotent on disk.
 */
async function ensureSources(runId: number): Promise<WrittenSnapshot[]> {
  const counted = await countSources(runId);
  if (!counted.ok) throw new SetupError(`统计来源失败：${counted.message}`);
  if (counted.value > 0) return [];

  const written: WrittenSnapshot[] = [];

  for (const [index, page] of FIXTURE_PAGES.entries()) {
    const canonicalUrl = `https://acceptance.invalid/inventory/${runId}/${index + 1}`;
    const snapshot = await writeSnapshot({ text: page.text, url: canonicalUrl });
    written.push({ hash: snapshot.hash, textPath: snapshot.textPath });

    const inserted = await insertSource({
      runId,
      canonicalUrl,
      platform: page.platform,
      contentHash: snapshot.hash,
      snapshotPath: snapshot.textPath,
      crawlTier: 'fixture',
      fetchedAt: new Date(),
    });
    if (!inserted.ok) throw new SetupError(`写入来源失败：${inserted.message}`);
    if (!inserted.value.inserted) {
      throw new SetupError(`来源 ${canonicalUrl} 已存在却不属于 run ${runId}，请换一个 run`);
    }
  }

  return written;
}

async function timed<T>(
  timing: Partial<Record<AcceptanceStage, number>>,
  stage: AcceptanceStage,
  work: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const value = await work();
  timing[stage] = Math.round(performance.now() - start);
  return value;
}

function formatChecks(checks: readonly Check[]): string {
  const lines = ['### 断言', ''];
  for (const check of checks) {
    lines.push(
      `- ${check.ok ? '✅' : '❌'} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`,
    );
  }
  return lines.join('\n');
}

async function countsForRun(runId: number): Promise<Record<string, number>> {
  const [sourceCount] = await db
    .select({ value: count() })
    .from(sources)
    .where(eq(sources.runId, runId));
  const [evidenceCount] = await db
    .select({ value: count() })
    .from(evidenceTable)
    .where(eq(evidenceTable.runId, runId));
  const [opportunityCount] = await db
    .select({ value: count() })
    .from(opportunities)
    .where(eq(opportunities.runId, runId));
  const [reportCount] = await db
    .select({ value: count() })
    .from(reports)
    .where(eq(reports.runId, runId));
  const [citationCount] = await db
    .select({ value: count() })
    .from(citations)
    .innerJoin(reports, eq(citations.reportId, reports.id))
    .where(eq(reports.runId, runId));

  return {
    sources: sourceCount?.value ?? 0,
    evidence: evidenceCount?.value ?? 0,
    opportunities: opportunityCount?.value ?? 0,
    reports: reportCount?.value ?? 0,
    citations: citationCount?.value ?? 0,
  };
}

async function globalCounts(): Promise<Record<string, number>> {
  const [runCount] = await db.select({ value: count() }).from(runs);
  const [sourceCount] = await db.select({ value: count() }).from(sources);
  const [evidenceCount] = await db.select({ value: count() }).from(evidenceTable);
  const [opportunityCount] = await db.select({ value: count() }).from(opportunities);
  const [reportCount] = await db.select({ value: count() }).from(reports);

  return {
    runs: runCount?.value ?? 0,
    sources: sourceCount?.value ?? 0,
    evidence: evidenceCount?.value ?? 0,
    opportunities: opportunityCount?.value ?? 0,
    reports: reportCount?.value ?? 0,
  };
}

/** Delete a content-addressed snapshot only when no source row still points at it. */
async function removeOrphanSnapshots(
  written: readonly WrittenSnapshot[],
): Promise<{ removed: number; kept: number }> {
  let removed = 0;
  let kept = 0;

  for (const { hash, textPath } of written) {
    const [remaining] = await db
      .select({ value: count() })
      .from(sources)
      .where(eq(sources.contentHash, hash));

    if ((remaining?.value ?? 0) > 0) {
      kept += 1;
      continue;
    }

    try {
      await unlink(textPath);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      kept += 1;
    }
  }

  return { removed, kept };
}

/**
 * Remove everything this invocation created. Deleting the idea cascades to the
 * thread, run, sources, evidence, opportunities, scores, report, citations,
 * events and messages — the foreign keys already encode the ownership.
 */
async function cleanup(session: Session): Promise<boolean> {
  if (session.mode === 'existing') {
    console.log('');
    console.log('### 清理');
    console.log(`- --run 指定：未删除任何数据（run #${session.runId ?? '?'}）`);
    return true;
  }

  if (session.ideaId === null || session.runId === null) {
    console.log('');
    console.log('### 清理');
    console.log('- 未创建 run，无需清理');
    return true;
  }

  const runId = session.runId;
  const ideaId = session.ideaId;

  await db.delete(ideas).where(eq(ideas.id, ideaId));

  const residual = await countsForRun(runId);
  const snapshots = await removeOrphanSnapshots(session.snapshots);
  const global = await globalCounts();

  console.log('');
  console.log('### 清理（自建数据）');
  console.log(
    `- run #${runId} 已删除（级联 thread/idea、sources、evidence、opportunities、scores、reports、citations、events、messages）`,
  );
  console.log(
    `- 本 run 残留：sources ${residual.sources} · evidence ${residual.evidence} · opportunities ${residual.opportunities} · reports ${residual.reports} · citations ${residual.citations}`,
  );
  console.log(
    `- 快照：删除 ${snapshots.removed} 个（仍被其他 run 引用而保留 ${snapshots.kept} 个）`,
  );
  console.log(
    `- 全库计数（清理后）：runs ${global.runs} · sources ${global.sources} · evidence ${global.evidence} · opportunities ${global.opportunities} · reports ${global.reports}`,
  );

  return Object.values(residual).every((value) => value === 0);
}

async function execute(parsed: ParsedArgs & { ok: true }, session: Session): Promise<number> {
  const { args } = parsed;
  const checks: Check[] = [];
  const timing: Partial<Record<AcceptanceStage, number>> = {};
  const startedAt = performance.now();

  let idea: string;
  let runId: number;

  if (args.runId === null) {
    const thread = await createThread({ title: FIXTURE_IDEA, idea: FIXTURE_IDEA });
    if (!thread.ok) throw new SetupError(`创建会话失败：${thread.message}`);

    const created = await createRun({
      threadId: thread.value.threadId,
      idea: FIXTURE_IDEA,
      angles: ['验收'],
    });
    if (!created.ok) throw new SetupError(`创建 run 失败：${created.message}`);

    session.mode = 'new';
    session.runId = created.value.runId;
    session.ideaId = thread.value.ideaId;
    runId = created.value.runId;
    idea = FIXTURE_IDEA;
    session.snapshots = await ensureSources(runId);
  } else {
    session.mode = 'existing';
    session.runId = args.runId;
    runId = args.runId;

    const record = await getRunContext(runId);
    if (!record.ok) throw new SetupError(`读取 run ${runId} 失败：${record.message}`);
    if (record.value === null) throw new SetupError(`run ${runId} 不存在`);
    idea = record.value.idea;

    const accepted = await countEvidence(runId, { accepted: true });
    if (!accepted.ok) throw new SetupError(`统计证据失败：${accepted.message}`);
    if (accepted.value > 0) {
      throw new SetupError(
        `run ${runId} 已有 ${accepted.value} 条已接受证据；再跑 S2–S6 会重复写入 opportunities，验收数据不再可比。请新建一个 run。`,
      );
    }

    session.snapshots = await ensureSources(runId);
  }

  const context: RunContext = { runId, idea, angles: [], deadlineAt: null };
  const { stub } = session;

  const counted = await countSources(runId);
  if (!counted.ok) throw new SetupError(`统计来源失败：${counted.message}`);
  const sourceTotal = counted.value;

  const extracted = await timed(timing, 'S2', () =>
    extractS2(context, {
      llm: stub,
      repo: { listSources: listSourcesForExtraction, insertEvidence },
      readSnapshot: (source) => readSnapshotText(source.contentHash),
    }),
  );
  if (!extracted.ok) {
    checks.push({ label: 'S2 抽取', ok: false, detail: `${extracted.code}：${extracted.message}` });
    console.log(formatChecks(checks));
    return EXIT_FAILED;
  }

  const clustered = await timed(timing, 'S3', () =>
    clusterS3(context, {
      llm: stub,
      repo: { listAcceptedEvidence, insertOpportunity },
    }),
  );
  if (!clustered.ok) {
    checks.push({ label: 'S3 聚类', ok: false, detail: `${clustered.code}：${clustered.message}` });
    console.log(formatChecks(checks));
    return EXIT_FAILED;
  }

  const scored = await timed(timing, 'S4', () =>
    scoreS4(context, {
      llm: stub,
      repo: { listOpportunities, listEvidenceByIds, replaceScores },
    }),
  );
  if (!scored.ok) {
    checks.push({ label: 'S4 评分', ok: false, detail: `${scored.code}：${scored.message}` });
    console.log(formatChecks(checks));
    return EXIT_FAILED;
  }

  const reported = await timed(timing, 'S5', () =>
    reportS5(context, {
      llm: stub,
      repo: { listOpportunities, listScores, listEvidenceByIds, saveReport },
    }),
  );
  if (!reported.ok) {
    checks.push({
      label: 'S5/S6 报告',
      ok: false,
      detail: `${reported.code}：${reported.message}`,
    });
    console.log(formatChecks(checks));
    return EXIT_FAILED;
  }

  // ── Stored state ────────────────────────────────────────────────────────
  const acceptedRows = await listAcceptedEvidence(runId);
  if (!acceptedRows.ok) throw new SetupError(`读取已接受证据失败：${acceptedRows.message}`);
  const accepted = acceptedRows.value;

  const rejectedCount = await countEvidence(runId, { accepted: false });
  if (!rejectedCount.ok) throw new SetupError(`统计被拒绝证据失败：${rejectedCount.message}`);

  checks.push({
    label: `已接受证据 ≥1（实际 ${accepted.length}）`,
    ok: accepted.length >= 1,
    ...(accepted.length >= 1 ? {} : { detail: 'S2 没有留下任何可引用的证据' }),
  });

  const sourceRows = await db
    .select({ id: sources.id, contentHash: sources.contentHash })
    .from(sources)
    .where(eq(sources.runId, runId));
  const hashBySource = new Map(sourceRows.map((row) => [row.id, row.contentHash]));

  const snapshotCache = new Map<string, string>();
  const unlocatable: string[] = [];
  for (const row of accepted) {
    const hash = hashBySource.get(row.sourceId);
    if (hash === undefined) {
      unlocatable.push(`evidence ${row.id} 找不到 source`);
      continue;
    }

    let text = snapshotCache.get(hash);
    if (text === undefined) {
      text = await readSnapshotText(hash);
      snapshotCache.set(hash, text);
    }

    const gate = gateQuote(text, row.quote);
    if (!gate.ok) unlocatable.push(`evidence ${row.id}：${gate.reason}`);
  }
  checks.push({
    label: '每条已接受 quote 都能用 gateQuote 在快照中再次定位',
    ok: accepted.length > 0 && unlocatable.length === 0,
    ...(unlocatable.length === 0 ? {} : { detail: unlocatable.join('；') }),
  });

  const opportunities = await listOpportunities(runId);
  if (!opportunities.ok) throw new SetupError(`读取机会失败：${opportunities.message}`);
  const opportunityRows = opportunities.value;

  if (sourceTotal >= 3) {
    const minIndependent =
      opportunityRows.length === 0
        ? 0
        : Math.min(...opportunityRows.map((row) => row.independentSources));
    checks.push({
      label: `机会 ≥1（实际 ${opportunityRows.length}）`,
      ok: opportunityRows.length >= 1,
    });
    checks.push({
      label: `independentSources ≥3（最小 ${opportunityRows.length === 0 ? '—' : minIndependent}）`,
      ok: opportunityRows.length >= 1 && minIndependent >= 3,
    });
  } else {
    checks.push({ label: `来源 ${sourceTotal} < 3，跳过机会断言`, ok: false });
  }

  const reportOpportunityId = reported.value.opportunityId ?? opportunityRows[0]?.id ?? null;
  let scoreRows: DimensionScore[] = [];
  if (reportOpportunityId !== null) {
    const read = await listScores(reportOpportunityId);
    if (!read.ok) throw new SetupError(`读取评分失败：${read.message}`);
    scoreRows = read.value;
  }
  const scoreTotal = scoreRows.reduce((sum, row) => sum + row.points, 0);

  checks.push({
    label: `评分恰好 7 行（实际 ${scoreRows.length}）`,
    ok: scoreRows.length === 7,
  });
  checks.push({ label: `总分 ${scoreTotal} ≤ 100`, ok: scoreTotal <= 100 });

  const reportRows = await db
    .select({
      id: reports.id,
      sections: reports.sections,
      rubricTotal: reports.rubricTotal,
      grade: reports.credibilityGrade,
      decision: reports.decision,
      unknowns: reports.unknowns,
    })
    .from(reports)
    .where(eq(reports.runId, runId))
    .limit(1);
  const reportRow = reportRows[0];

  checks.push({ label: '报告已落库', ok: reportRow !== undefined });

  let unknowns: string[] = [];
  let citationTotal = 0;

  if (reportRow !== undefined) {
    // Written by this script one line above; the validator re-checks what it reads.
    const sections = reportRow.sections as Record<string, ReportSectionBody>;

    const incomplete = REPORT_SECTIONS.filter((section) => {
      const body = sections[section];
      return body === undefined || !Array.isArray(body.claims) || body.claims.length === 0;
    });
    checks.push({
      label: '八节齐全且每节至少 1 条 claim',
      ok: incomplete.length === 0,
      ...(incomplete.length === 0 ? {} : { detail: `缺少：${incomplete.join(', ')}` }),
    });

    const validation = validateReport({
      sections,
      rubricTotal: reportRow.rubricTotal,
      scoresTotal: scoreTotal,
    });
    checks.push({
      label: 'validateReport 通过',
      ok: validation.ok,
      ...(validation.ok
        ? {}
        : { detail: validation.issues.map((issue) => `${issue.path}(${issue.code})`).join('; ') }),
    });

    const [citationCount] = await db
      .select({ value: count() })
      .from(citations)
      .where(eq(citations.reportId, reportRow.id));
    citationTotal = citationCount?.value ?? 0;
    checks.push({ label: `citations 非空（实际 ${citationTotal}）`, ok: citationTotal > 0 });

    unknowns = Array.isArray(reportRow.unknowns)
      ? reportRow.unknowns.filter((value): value is string => typeof value === 'string')
      : [];
    const inUnknowns = unknowns.some((entry) => entry.includes(FINANCE_UNREFERENCED_CLAIM));
    checks.push({
      label: 'finance 的无引用 claim 已移入 reports.unknowns',
      ok: inUnknowns,
    });

    const financeStillInBody =
      sections.finance?.claims.some((claim) => claim.text === FINANCE_UNREFERENCED_CLAIM) ?? false;
    checks.push({ label: '该 claim 不在正文 claims 中', ok: !financeStillInBody });
  }

  const requiredCalls = ['extract', 'cluster', 'ordinals', 'sections'];
  const missingCalls = requiredCalls.filter((call) => !stub.calls.includes(call));
  checks.push({
    label: `假模型调用包含 extract/cluster/ordinals/sections`,
    ok: missingCalls.length === 0,
    ...(missingCalls.length === 0 ? {} : { detail: `缺少：${missingCalls.join(', ')}` }),
  });

  const summary: AcceptanceSummary = {
    mode: session.mode,
    runId,
    stages: {
      sources: sourceTotal,
      accepted: accepted.length,
      rejected: rejectedCount.value,
      failedSources: extracted.value.failedSources,
      opportunities: clustered.value.opportunities,
      dropped: clustered.value.dropped,
      scored: scored.value.opportunities,
      decisions: scored.value.decisions,
    },
    report:
      reportRow === undefined
        ? null
        : {
            id: reportRow.id,
            total: reportRow.rubricTotal,
            grade: reportRow.grade,
            decision: reportRow.decision,
            claims: reported.value.claims,
            citations: citationTotal,
            sections: REPORT_SECTIONS.length,
            unknowns: unknowns.length,
          },
    timing: {
      S2: timing.S2 ?? 0,
      S3: timing.S3 ?? 0,
      S4: timing.S4 ?? 0,
      S5: timing.S5 ?? 0,
      total: Math.round(performance.now() - startedAt),
    },
    calls: [...stub.calls],
  };

  console.log(renderAcceptanceSummary(summary));
  console.log(formatChecks(checks));

  return checks.every((check) => check.ok) ? EXIT_OK : EXIT_FAILED;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    return EXIT_SETUP;
  }
  if (parsed.args.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const session: Session = {
    stub: createStubLlm(),
    mode: 'new',
    runId: null,
    ideaId: null,
    snapshots: [],
  };

  let code = EXIT_FAILED;

  try {
    code = await execute(parsed, session);
  } catch (error) {
    if (error instanceof SetupError) {
      console.error(`❌ ${error.message}`);
      code = EXIT_SETUP;
    } else {
      console.error('❌ 验收脚本异常：', error);
      code = EXIT_FAILED;
    }
  }

  try {
    const clean = await cleanup(session);
    if (!clean && code === EXIT_OK) code = EXIT_FAILED;
  } catch (error) {
    console.error('❌ 清理失败：', error);
    if (code === EXIT_OK) code = EXIT_FAILED;
  }

  await closeDb();
  return code;
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error('❌ 验收脚本异常：', error);
    process.exitCode = EXIT_FAILED;
  },
);
