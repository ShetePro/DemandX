import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EvidenceTable } from '@/features/evidence/evidence-table';
import { parseEvidenceFilters } from '@/features/evidence/filters';
import type { EvidenceViewItem } from '@/features/evidence/types';
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

// Counters and rows must reflect the database, not a build-time snapshot.
export const dynamic = 'force-dynamic';

type EvidencePageProps = {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

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

export default async function EvidencePage({ params, searchParams }: EvidencePageProps) {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();

  const run = await getRun(runId);
  if (!run.ok) throw new Error(run.message);
  if (run.value === null) notFound();

  const filters = parseEvidenceFilters(await searchParams);
  const [rows, counts, platforms] = await Promise.all([
    listEvidence({ runId, filters, limit: EVIDENCE_PAGE_LIMIT }),
    evidenceCounts(runId),
    evidencePlatforms(runId),
  ]);

  if (!rows.ok) throw new Error(rows.message);
  if (!counts.ok) throw new Error(counts.message);
  if (!platforms.ok) throw new Error(platforms.message);

  const items = await withHighlights(rows.value);

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <PageHeader
        title="证据库"
        description={`run ${runId} · 逐条核对引文与快照；筛选条件保存在地址栏，刷新后保持。`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/runs/${runId}`}>运行监控</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/runs/${runId}/report`}>查看报告</Link>
            </Button>
          </>
        }
      />
      <EvidenceTable
        items={items}
        counts={counts.value}
        filters={filters}
        platforms={platforms.value}
      />
    </div>
  );
}
