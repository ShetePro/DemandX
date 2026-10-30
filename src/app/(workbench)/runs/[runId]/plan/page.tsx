import { notFound } from 'next/navigation';

import { PlanPanel } from '@/features/validation/plan-panel';

// Tasks are written on first visit; a build-time snapshot would freeze an empty plan.
export const dynamic = 'force-dynamic';

type PlanPageProps = {
  params: Promise<{ runId: string }>;
};

export default async function PlanPage({ params }: PlanPageProps) {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();

  return <PlanPanel runId={runId} />;
}
