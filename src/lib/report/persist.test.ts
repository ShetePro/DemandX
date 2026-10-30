import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/quota/types';

// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as PersistModule from './persist';
import { REPORT_SECTIONS, type ReportSectionBody } from './validate';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

/** Database name from a postgres URL, or '' when it cannot be parsed. */
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// Integration tests TRUNCATE tables. Refuse to run against anything that is not
// an explicitly named `*_test` database, even if a bad URL is passed in.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

let repo!: typeof PersistModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

function body(text: string, evidenceIds: number[] = [1]): ReportSectionBody {
  return { claims: [{ text, evidenceIds }], unknowns: [] };
}

/** A complete report; each test replaces the one section it cares about. */
function sections(
  overrides: Record<string, ReportSectionBody> = {},
): Record<string, ReportSectionBody> {
  const base: Record<string, ReportSectionBody> = {};
  for (const key of REPORT_SECTIONS) base[key] = body(`${key} 的论断`);
  return { ...base, ...overrides };
}

suite('report persistence', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    repo = await import('./persist');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE citations, reports, opportunities, scores, evidence, sources, queries, run_events, runs, threads, ideas RESTART IDENTITY CASCADE',
    );
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  async function seedRun(): Promise<number> {
    const ideas = await client.sql<{ id: number }[]>`
      insert into ideas (title, raw_input) values ('想法', '想法') returning id
    `;
    const idea = ideas[0];
    if (!idea) throw new Error('idea insert returned no row');

    const runs = await client.sql<{ id: number }[]>`
      insert into runs (idea_id) values (${idea.id}) returning id
    `;
    const run = runs[0];
    if (!run) throw new Error('run insert returned no row');

    return run.id;
  }

  it('stores one report per run and expands claims into citation rows', async () => {
    const runId = await seedRun();

    const saved = unwrap(
      await repo.saveReport({
        runId,
        sections: sections({
          summary: body('执行摘要', [1, 2]),
          evidence: body('证据', [2]),
        }),
        total: 68,
        grade: 'B',
        decision: '建议先验证，再开发',
      }),
    );

    expect(saved.reportId).toBeGreaterThan(0);

    const reports = await client.sql<
      { id: number; rubric_total: number; credibility_grade: string; decision: string }[]
    >`select id, rubric_total, credibility_grade, decision from reports where run_id = ${runId}`;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      id: saved.reportId,
      rubric_total: 68,
      credibility_grade: 'B',
      decision: '建议先验证，再开发',
    });

    const citations = await client.sql<{ report_path: string; evidence_id: number }[]>`
      select report_path, evidence_id from citations where report_id = ${saved.reportId}
      order by report_path
    `;
    // summary cites two rows, evidence one, the other six sections one each.
    expect(citations).toHaveLength(9);
    expect(citations.map((row) => row.report_path)).toContain('summary.claims[0]');
    expect(citations.map((row) => row.report_path)).toContain('summary.claims[0].evidenceIds[1]');
    expect(citations.find((row) => row.report_path === 'summary.claims[0]')?.evidence_id).toBe(1);
  });

  it('replaces the previous report and its citations on a re-run', async () => {
    const runId = await seedRun();
    const first = unwrap(
      await repo.saveReport({
        runId,
        sections: sections({ summary: body('第一版摘要', [1, 2]) }),
        total: 40,
        grade: 'C',
        decision: '建议调整定位',
      }),
    );

    const secondBody: Record<string, ReportSectionBody> = {};
    for (const key of REPORT_SECTIONS) secondBody[key] = body('第二版论断', [3]);

    const second = unwrap(
      await repo.saveReport({
        runId,
        sections: secondBody,
        total: 72,
        grade: 'A',
        decision: '建议开发',
      }),
    );

    expect(second.reportId).toBe(first.reportId);

    const rows = await client.sql<{ rubric_total: number; decision: string }[]>`
      select rubric_total, decision from reports where run_id = ${runId}
    `;
    expect(rows).toEqual([{ rubric_total: 72, decision: '建议开发' }]);

    const citations = await client.sql<{ report_path: string; evidence_id: number }[]>`
      select report_path, evidence_id from citations where report_id = ${second.reportId}
    `;
    expect(citations).toHaveLength(8);
    expect(citations.every((row) => row.evidence_id === 3)).toBe(true);
  });

  it('writes no citations for an empty report and dedupes its unknowns', async () => {
    const runId = await seedRun();
    const empty: Record<string, ReportSectionBody> = {};
    for (const key of REPORT_SECTIONS) {
      empty[key] = { claims: [], unknowns: ['缺少竞品定价', '缺少竞品定价'] };
    }

    const saved = unwrap(
      await repo.saveReport({
        runId,
        sections: empty,
        total: 0,
        grade: 'D',
        decision: '建议放弃',
      }),
    );

    const citations = await client.sql<{ count: string }[]>`
      select count(*)::text as count from citations where report_id = ${saved.reportId}
    `;
    expect(citations[0]?.count).toBe('0');

    const reports = await client.sql<{ unknowns: string[] }[]>`
      select unknowns from reports where id = ${saved.reportId}
    `;
    expect(reports[0]?.unknowns).toEqual(['缺少竞品定价']);
  });
});
