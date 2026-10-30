import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';

import { sliceQuoteHighlight } from '@/lib/evidence/highlight';
import {
  EVIDENCE_PAGE_LIMIT,
  evidenceCounts,
  evidencePlatforms,
  listEvidence,
  type EvidenceListItem,
} from '@/lib/evidence/queries';
import { readSnapshotText, SnapshotError } from '@/lib/evidence/snapshot';
import { getRun } from '@/lib/runs/repository';

import { EvidenceTable } from './evidence-table';
import { parseEvidenceFilters } from './filters';
import type { EvidenceCounts, EvidenceFilterState, EvidenceViewItem } from './types';

/** URL params as Next hands them to an RSC. */
export type EvidenceSearchParams = Record<string, string | string[] | undefined>;

export interface EvidenceViewData {
  items: EvidenceViewItem[];
  counts: EvidenceCounts;
  filters: EvidenceFilterState;
  platforms: string[];
}

/**
 * Read each distinct snapshot once and cut the quote context on the server.
 * The browser receives `before`/`quote`/`after` only. A missing snapshot is a
 * degraded row, not an error: the quote is still shown, just without a mark.
 */
async function withHighlights(rows: EvidenceListItem[]): Promise<EvidenceViewItem[]> {
  const snapshots = new Map<string, string | null>();
  const items: EvidenceViewItem[] = [];

  for (const row of rows) {
    if (row.rejectedReason !== null || row.quoteOffset === null) {
      items.push({ ...row, highlight: null });
      continue;
    }

    let text = snapshots.get(row.contentHash);
    if (text === undefined) {
      try {
        text = await readSnapshotText(row.contentHash);
      } catch (error) {
        if (!(error instanceof SnapshotError)) throw error;
        text = null;
      }
      snapshots.set(row.contentHash, text);
    }

    items.push({
      ...row,
      highlight: text === null ? null : sliceQuoteHighlight(text, row.quoteOffset, row.quote),
    });
  }

  return items;
}

/**
 * Everything the evidence view renders, for one run. Shared by
 * `/runs/[runId]/evidence` and the conversation's 证据 tab, so the two can
 * never disagree about filters, counters or highlights.
 */
export async function loadEvidenceView(
  runId: number,
  searchParams: EvidenceSearchParams,
): Promise<EvidenceViewData> {
  const run = await getRun(runId);
  if (!run.ok) throw new Error(run.message);
  if (run.value === null) notFound();

  const filters = parseEvidenceFilters(searchParams);
  const [rows, counts, platforms] = await Promise.all([
    listEvidence({ runId, filters, limit: EVIDENCE_PAGE_LIMIT }),
    evidenceCounts(runId),
    evidencePlatforms(runId),
  ]);

  if (!rows.ok) throw new Error(rows.message);
  if (!counts.ok) throw new Error(counts.message);
  if (!platforms.ok) throw new Error(platforms.message);

  return {
    items: await withHighlights(rows.value),
    counts: counts.value,
    filters,
    platforms: platforms.value,
  };
}

export interface EvidencePanelProps {
  runId: number;
  searchParams: EvidenceSearchParams;
  /**
   * The conversation page already frames the view (tabs + title), so the
   * standalone header and its links to other routes are dropped there.
   */
  embedded?: boolean;
}

/** Evidence table for one run; the only difference between the two routes. */
export async function EvidencePanel({ runId, searchParams, embedded = false }: EvidencePanelProps) {
  const { items, counts, filters, platforms } = await loadEvidenceView(runId, searchParams);

  return (
    <div className="mx-auto w-full max-w-[1200px] p-4 md:p-6">
      <PageHeader
        title="证据库"
        description={`run ${runId} · 逐条核对引文与快照；筛选条件保存在地址栏，刷新后保持。`}
        actions={
          embedded ? undefined : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/runs/${runId}`}>运行监控</Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/runs/${runId}/report`}>查看报告</Link>
              </Button>
            </>
          )
        }
      />
      <EvidenceTable items={items} counts={counts} filters={filters} platforms={platforms} />
    </div>
  );
}
