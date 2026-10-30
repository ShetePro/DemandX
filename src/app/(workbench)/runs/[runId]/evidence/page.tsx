import { notFound } from 'next/navigation';

import { EvidencePanel } from '@/features/evidence/evidence-panel';

// Counters and rows must reflect the database, not a build-time snapshot.
export const dynamic = 'force-dynamic';

type EvidencePageProps = {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function EvidencePage({ params, searchParams }: EvidencePageProps) {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();

  return <EvidencePanel runId={runId} searchParams={await searchParams} />;
}
