import fs from 'node:fs/promises';
import path from 'node:path';

import { writeSnapshot } from '../../../src/lib/evidence/snapshot';
import { db } from './db';

/**
 * Seed for the report suite. The pipeline stages that normally write a report
 * (S3 clusters, S4 scores, S5 prose, S6 citations) do not exist yet, so the
 * suite inserts exactly what they would have stored: one accepted evidence row
 * per platform, a seven-dimension rubric, eight sections and the citation rows
 * that point claims at evidence.
 *
 * The quotes live in real snapshots on disk, because the citation panel cuts
 * its `<mark>` out of the stored page text at `evidence.quote_offset`; a row
 * without a snapshot would silently render without a highlight and the test
 * would prove nothing.
 *
 * Everything is scoped to the ids returned here, so `deleteReportFixture` can
 * never remove a row another suite owns.
 */

export const IDEA_TITLE = '跨境卖家库存同步工具';
const IDEA_INPUT = '帮我验证跨境库存同步工具是否值得做';

export const DECISION = '建议先验证，再开发';
export const RUBRIC_TOTAL = 78;
export const CREDIBILITY = 'B';

/** The claim the report stores without a citation, to prove the grey badge. */
export const UNCITED_CLAIM = '第三个月即可覆盖服务器与代理成本';

/** The eight headings, in order, as the page and the export spell them. */
export const SECTION_HEADINGS = [
  '一、执行摘要',
  '二、需求证据',
  '三、竞品调查',
  '四、机会排名',
  '五、最佳方向',
  '六、财务模型',
  '七、14 天验证计划',
  '八、最终决策',
] as const;

export const PLATFORM_A = '小红书';
export const PLATFORM_B = 'Reddit';
export const QUOTE_A = '每天手工对账三小时';
export const QUOTE_B = '399 一个月太贵';

const PAGE_A = [
  '先说背景：我在做跨境独立站，旺季每天出 200 单。',
  '每天手工对账三小时，旺季更久，经常漏单。',
  '现在用 Excel 加一个脚本，还是每周对不上库存。',
].join('\n');

const PAGE_B = [
  'We tried an inventory sync tool for our Shopify store.',
  '399 一个月太贵，而且只支持 Shopify，TikTok Shop 完全没覆盖。',
  'We cancelled after two months and went back to spreadsheets.',
].join('\n');

/**
 * Mirrors `.env` (`SNAPSHOT_DIR=./data/snapshots`), which `next dev` loads but
 * the Playwright process does not. Both run with the repo root as cwd.
 */
const SNAPSHOT_DIR = path.resolve(process.env.SNAPSHOT_DIR ?? './data/snapshots');

export interface ReportEvidenceIds {
  first: number;
  second: number;
}

interface FixtureSection {
  claims: { text: string; evidenceIds: number[] }[];
  unknowns: string[];
}

export type ReportSections = Record<string, FixtureSection>;

/**
 * Eight sections with real citation ids. `finance` also carries one claim with
 * no `evidenceIds`: S6 refuses that shape, so the page must mark it as uncited
 * instead of silently making it print-worthy.
 */
export function reportSections(ids: ReportEvidenceIds): ReportSections {
  return {
    summary: {
      claims: [
        { text: '跨境卖家在旺季每天手工对账，库存同步是高频痛点', evidenceIds: [ids.first] },
        { text: '已有卖家为轻量同步工具按月付费', evidenceIds: [ids.second] },
      ],
      unknowns: ['未收集竞品差评'],
    },
    evidence: {
      claims: [{ text: '同一个卖家在三个平台重复描述漏单', evidenceIds: [ids.first] }],
      unknowns: [],
    },
    competitors: {
      claims: [{ text: '现有工具集中在 399 元/月，且只覆盖 Shopify', evidenceIds: [ids.second] }],
      unknowns: [],
    },
    ranking: {
      claims: [{ text: '库存同步方向的独立来源最多', evidenceIds: [ids.first, ids.second] }],
      unknowns: [],
    },
    bestDirection: {
      claims: [{ text: '做轻量库存同步，先接 Shopify 与 TikTok Shop', evidenceIds: [ids.first] }],
      unknowns: [],
    },
    finance: {
      claims: [
        { text: '按 30 个付费用户、每月 199 元估算，月收入约 5970 元', evidenceIds: [ids.second] },
        { text: UNCITED_CLAIM, evidenceIds: [] },
      ],
      unknowns: ['缺少真实留存数据'],
    },
    plan: {
      claims: [{ text: '14 天内完成 10 次卖家访谈，只问付费行为', evidenceIds: [ids.first] }],
      unknowns: [],
    },
    decision: {
      claims: [{ text: '结论：建议先验证，再开发。', evidenceIds: [ids.first, ids.second] }],
      unknowns: [],
    },
  };
}

/** The seven rubric rows; they sum to `RUBRIC_TOTAL`. */
const DIMENSION_POINTS: readonly [string, number, string][] = [
  ['needs', 18, '三位卖家独立描述同一漏单问题'],
  ['payment', 16, '两位卖家已经在为同步工具付费，但抵触涨价'],
  ['gap', 12, '现有工具不覆盖 TikTok Shop'],
  ['acquisition', 11, '卖家集中在少数几个社群'],
  ['profit', 10, '客单价 199 元，边际成本低'],
  ['feasibility', 7, '两家平台的开放 API 可用'],
  ['longevity', 4, '库存同步是长期需求，但替代品多'],
];

export interface ReportFixture {
  ideaId: number;
  threadId: number;
  runId: number;
  sourceIds: number[];
  evidenceIds: ReportEvidenceIds;
  opportunityId: number;
  reportId: number;
  /** Gzipped snapshot files this fixture created, removed on cleanup. */
  snapshotPaths: string[];
}

/** PostgreSQL array literal: the raw client expands JS arrays into a list. */
function intArray(ids: readonly number[]): string {
  return `{${ids.join(',')}}`;
}

/**
 * The single row an `insert ... returning id` yields. `noUncheckedIndexedAccess`
 * makes the destructured row possibly absent; an insert that returns nothing is
 * a broken fixture, not a value to keep going with.
 */
function insertedRow(rows: readonly { id: number }[], what: string): { id: number } {
  const row = rows[0];
  if (row === undefined) throw new Error(`插入 ${what} 失败：没有返回 id`);
  return row;
}

/**
 * Insert the whole report tree and return the ids. `beforeEach` calls this, so
 * every test reads a report the shared database has never held before.
 */
export async function seedReportFixture(): Promise<ReportFixture> {
  const client = db();

  // `url` is metadata only: the stored path is `<sha256(text)>`, which is what
  // the report page re-reads. The run-scoped URL is written to `sources` below.
  const snapshotA = await writeSnapshot({
    text: PAGE_A,
    url: 'https://example.test/a',
    dir: SNAPSHOT_DIR,
  });
  const snapshotB = await writeSnapshot({
    text: PAGE_B,
    url: 'https://example.test/b',
    dir: SNAPSHOT_DIR,
  });
  const snapshotPaths = [snapshotA.textPath, snapshotB.textPath];

  try {
    return await client.begin(async (tx) => {
      const idea = insertedRow(
        await tx<{ id: number }[]>`
          insert into ideas (title, raw_input)
          values (${IDEA_TITLE}, ${IDEA_INPUT})
          returning id
        `,
        'idea',
      );

      const thread = insertedRow(
        await tx<{ id: number }[]>`
          insert into threads (idea_id, title)
          values (${idea.id}, ${IDEA_TITLE})
          returning id
        `,
        'thread',
      );

      const run = insertedRow(
        await tx<{ id: number }[]>`
          insert into runs (idea_id, thread_id, status, stage, started_at, finished_at)
          values (${idea.id}, ${thread.id}, 'finished', 'S6', now(), now())
          returning id
        `,
        'run',
      );

      // `(canonical_url, content_hash)` is unique across the whole database, and
      // `beforeEach` seeds another fixture before `afterAll` cleans the previous
      // ones, so the run id has to be part of the URL.
      const sourceA = insertedRow(
        await tx<{ id: number }[]>`
          insert into sources (run_id, canonical_url, platform, content_hash, http_status, crawl_tier)
          values (
            ${run.id}, ${`https://example.test/runs/${run.id}/a`}, ${PLATFORM_A},
            ${snapshotA.hash}, 200, 'http'
          )
          returning id
        `,
        'source A',
      );

      const sourceB = insertedRow(
        await tx<{ id: number }[]>`
          insert into sources (run_id, canonical_url, platform, content_hash, http_status, crawl_tier)
          values (
            ${run.id}, ${`https://example.test/runs/${run.id}/b`}, ${PLATFORM_B},
            ${snapshotB.hash}, 200, 'http'
          )
          returning id
        `,
        'source B',
      );

      const evidenceA = insertedRow(
        await tx<{ id: number }[]>`
          insert into evidence (
            run_id, source_id, quote, quote_offset, platform, published_at, signal,
            first_hand, supports, does_not_prove
          )
          values (
            ${run.id}, ${sourceA.id}, ${QUOTE_A}, ${PAGE_A.indexOf(QUOTE_A)}, ${PLATFORM_A},
            ${new Date('2026-08-14T10:00:00Z')}, 'problem', true,
            '旺季手工对账确实存在，且每周都会漏单',
            '不能证明卖家愿意为此付费'
          )
          returning id
        `,
        'evidence A',
      );

      const evidenceB = insertedRow(
        await tx<{ id: number }[]>`
          insert into evidence (
            run_id, source_id, quote, quote_offset, platform, published_at, signal,
            first_hand, supports, does_not_prove
          )
          values (
            ${run.id}, ${sourceB.id}, ${QUOTE_B}, ${PAGE_B.indexOf(QUOTE_B)}, ${PLATFORM_B},
            ${new Date('2026-07-02T10:00:00Z')}, 'paying', true,
            '卖家已经在为同类工具付费，并对价格敏感',
            '不能证明他们会换到新产品'
          )
          returning id
        `,
        'evidence B',
      );

      const evidenceIds: ReportEvidenceIds = {
        first: evidenceA.id,
        second: evidenceB.id,
      };

      const opportunity = insertedRow(
        await tx<{ id: number }[]>`
          insert into opportunities (run_id, name, positioning, independent_sources, evidence_ids)
          values (
            ${run.id}, ${'轻量库存同步'}, ${'给中小跨境卖家的跨平台库存同步'},
            2, ${intArray([evidenceA.id, evidenceB.id])}::int[]
          )
          returning id
        `,
        'opportunity',
      );

      for (const [dimension, points, rationale] of DIMENSION_POINTS) {
        await tx`
          insert into scores (opportunity_id, dimension, points, rationale, evidence_ids)
          values (
            ${opportunity.id}, ${dimension}, ${points}, ${rationale},
            ${intArray([evidenceA.id, evidenceB.id])}::int[]
          )
        `;
      }

      const sections = reportSections(evidenceIds);

      const report = insertedRow(
        await tx<{ id: number }[]>`
          insert into reports (run_id, sections, rubric_total, credibility_grade, decision, unknowns)
          values (
            ${run.id}, ${JSON.stringify(sections)}::jsonb, ${RUBRIC_TOTAL}, ${CREDIBILITY},
            ${DECISION}, ${JSON.stringify(['未收集竞品差评', '缺少真实留存数据'])}::jsonb
          )
          returning id
        `,
        'report',
      );

      // One citation row per cited claim and evidence id, addressed by the JSON
      // path the report validator uses, so the trail survives evidence deletion.
      for (const [section, body] of Object.entries(sections)) {
        for (const [index, claim] of body.claims.entries()) {
          for (const evidenceId of claim.evidenceIds) {
            await tx`
              insert into citations (report_id, report_path, evidence_id)
              values (${report.id}, ${`${section}.claims[${index}].evidence[${evidenceId}]`}, ${evidenceId})
            `;
          }
        }
      }

      return {
        ideaId: idea.id,
        threadId: thread.id,
        runId: run.id,
        sourceIds: [sourceA.id, sourceB.id],
        evidenceIds,
        opportunityId: opportunity.id,
        reportId: report.id,
        snapshotPaths,
      };
    });
  } catch (error) {
    // A half-written tree must not leave snapshot files behind either.
    await Promise.all(snapshotPaths.map((target) => fs.rm(target, { force: true })));
    throw error;
  }
}

/**
 * Delete the fixture in dependency order: citations before the report they
 * point at, scores before the opportunity, evidence before its source, and the
 * run/thread/idea last. Only the recorded ids are touched.
 */
export async function deleteReportFixture(fixture: ReportFixture): Promise<void> {
  const client = db();

  await client`delete from citations where report_id = ${fixture.reportId}`;
  await client`delete from reports where id = ${fixture.reportId}`;
  await client`delete from scores where opportunity_id = ${fixture.opportunityId}`;
  await client`delete from opportunities where id = ${fixture.opportunityId}`;
  await client`delete from evidence where id in ${client([
    fixture.evidenceIds.first,
    fixture.evidenceIds.second,
  ])}`;
  await client`delete from sources where id in ${client(fixture.sourceIds)}`;
  await client`delete from runs where id = ${fixture.runId}`;
  await client`delete from threads where id = ${fixture.threadId}`;
  await client`delete from ideas where id = ${fixture.ideaId}`;

  await Promise.all(fixture.snapshotPaths.map((target) => fs.rm(target, { force: true })));
}

/** Row counts for every table the fixture wrote; all must be zero afterwards. */
export async function countReportRows(fixture: ReportFixture): Promise<{
  reports: number;
  citations: number;
  scores: number;
  opportunities: number;
  evidence: number;
  sources: number;
  runs: number;
  threads: number;
  ideas: number;
}> {
  const client = db();
  const rows = await client<
    {
      reports: number;
      citations: number;
      scores: number;
      opportunities: number;
      evidence: number;
      sources: number;
      runs: number;
      threads: number;
      ideas: number;
    }[]
  >`
    select
      (select count(*)::int from reports where id = ${fixture.reportId}) as reports,
      (select count(*)::int from citations where report_id = ${fixture.reportId}) as citations,
      (select count(*)::int from scores where opportunity_id = ${fixture.opportunityId}) as scores,
      (select count(*)::int from opportunities where id = ${fixture.opportunityId}) as opportunities,
      (select count(*)::int from evidence where id in ${client([
        fixture.evidenceIds.first,
        fixture.evidenceIds.second,
      ])}) as evidence,
      (select count(*)::int from sources where id in ${client(fixture.sourceIds)}) as sources,
      (select count(*)::int from runs where id = ${fixture.runId}) as runs,
      (select count(*)::int from threads where id = ${fixture.threadId}) as threads,
      (select count(*)::int from ideas where id = ${fixture.ideaId}) as ideas
  `;

  const row = rows[0];
  if (row === undefined) throw new Error('统计报告数据失败：查询没有返回行');
  return row;
}
