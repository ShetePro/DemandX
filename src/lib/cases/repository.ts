import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { caseIdeas, caseStudies } from '@/lib/db/schema/cases';
import { fail, ok, type Result } from '@/lib/quota/types';

/** One case page as the deterministic import read it; `extraction` comes later. */
export interface CaseStudyInput {
  url: string;
  slug: string;
  title: string;
  sourceKind: 'story' | 'business';
  revenueMonth: number | null;
  revenueNote: string | null;
  foundedYear: number | null;
  summary: string | null;
  snapshotHash: string;
  fetchedAt: Date;
}

/**
 * Write or refresh the deterministic columns of a case. A refresh keeps
 * `category`, `business_model` and `extraction`: those come from the slower
 * LLM pass and must not be erased by a re-crawl that only added a new
 * snapshot.
 */
export async function upsertCaseStudies(
  rows: readonly CaseStudyInput[],
): Promise<Result<{ written: number }>> {
  if (rows.length === 0) return ok({ written: 0 });

  try {
    await db
      .insert(caseStudies)
      .values(
        rows.map((row) => ({
          url: row.url,
          slug: row.slug,
          title: row.title,
          sourceKind: row.sourceKind,
          revenueMonth: row.revenueMonth === null ? null : row.revenueMonth.toFixed(2),
          revenueNote: row.revenueNote,
          foundedYear: row.foundedYear,
          summary: row.summary,
          snapshotHash: row.snapshotHash,
          fetchedAt: row.fetchedAt,
        })),
      )
      .onConflictDoUpdate({
        target: caseStudies.url,
        set: {
          slug: sql`excluded.slug`,
          title: sql`excluded.title`,
          sourceKind: sql`excluded.source_kind`,
          snapshotHash: sql`excluded.snapshot_hash`,
          revenueMonth: sql`excluded.revenue_month`,
          revenueNote: sql`excluded.revenue_note`,
          foundedYear: sql`excluded.founded_year`,
          summary: sql`excluded.summary`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    return ok({ written: rows.length });
  } catch (error) {
    const state = (error as { code?: unknown } | null)?.code;
    const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
    return fail('STORAGE_FAILED', `写入案例库失败${detail}`);
  }
}

/** One listing row as `/data` showed it. */
export interface CaseIdeaInput {
  slug: string;
  title: string;
  summary: string | null;
  domain: string | null;
  revenueMonth: number | null;
  revenueSource: 'reported' | 'estimated' | null;
  soloScore: number | null;
  models: string[];
  growth: string[];
  customers: string[];
  tools: string[];
  facts: string[];
  sourceUrl: string;
  fetchedAt: Date;
}

/**
 * Refresh the listing columns of an idea. `enrichment` is left untouched: it is
 * written by the slower business-profile pass and a listing re-crawl must not
 * erase what that pass already learned.
 */
export async function upsertCaseIdeas(
  rows: readonly CaseIdeaInput[],
): Promise<Result<{ written: number }>> {
  if (rows.length === 0) return ok({ written: 0 });

  try {
    await db
      .insert(caseIdeas)
      .values(
        rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          domain: row.domain,
          revenueMonth: row.revenueMonth === null ? null : row.revenueMonth.toFixed(2),
          revenueSource: row.revenueSource,
          soloScore: row.soloScore,
          models: row.models,
          growth: row.growth,
          customers: row.customers,
          tools: row.tools,
          facts: row.facts,
          sourceUrl: row.sourceUrl,
          fetchedAt: row.fetchedAt,
        })),
      )
      .onConflictDoUpdate({
        target: caseIdeas.slug,
        set: {
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          domain: sql`excluded.domain`,
          revenueMonth: sql`excluded.revenue_month`,
          revenueSource: sql`excluded.revenue_source`,
          soloScore: sql`excluded.solo_score`,
          models: sql`excluded.models`,
          growth: sql`excluded.growth`,
          customers: sql`excluded.customers`,
          tools: sql`excluded.tools`,
          facts: sql`excluded.facts`,
          sourceUrl: sql`excluded.source_url`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    return ok({ written: rows.length });
  } catch (error) {
    const state = (error as { code?: unknown } | null)?.code;
    const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
    return fail('STORAGE_FAILED', `写入 idea 列表失败${detail}`);
  }
}
