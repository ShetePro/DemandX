import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { PlanBoard } from '@/features/validation/plan-board';
import { getRun } from '@/lib/runs/repository';
import { ensurePlan } from '@/lib/validation/repository';

// Tasks are written on first visit; a build-time snapshot would freeze an empty plan.
export const dynamic = 'force-dynamic';

type PlanPageProps = {
  params: Promise<{ runId: string }>;
};

export default async function PlanPage({ params }: PlanPageProps) {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();

  const run = await getRun(runId);
  if (!run.ok) throw new Error(run.message);
  if (run.value === null) notFound();

  const plan = await ensurePlan(runId);
  if (!plan.ok) throw new Error(plan.message);

  const stage = run.value.stage === null ? '' : ` · 阶段 ${run.value.stage}`;

  return (
    <div className="mx-auto max-w-[1000px] p-6">
      <PageHeader
        title="14 天验证计划"
        description={`run #${runId} · 状态 ${run.value.status}${stage} · 先验证真实付费，再决定是否开发。`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/runs/${runId}/evidence`}>查看证据库</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/runs/${runId}`}>运行监控</Link>
            </Button>
          </>
        }
      />

      <PlanBoard runId={runId} tasks={plan.value} />
    </div>
  );
}
