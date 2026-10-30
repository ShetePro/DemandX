import { notFound } from 'next/navigation';

import { ReportPanel } from '@/features/report/report-panel';

// A report appears only after the pipeline writes it; a build-time snapshot
// would freeze the page at "尚未生成".
export const dynamic = 'force-dynamic';

type ReportPageProps = {
  params: Promise<{ runId: string }>;
};

export default async function ReportPage({ params }: ReportPageProps) {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();

  return <ReportPanel runId={runId} />;
}
