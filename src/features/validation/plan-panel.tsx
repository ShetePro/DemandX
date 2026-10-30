import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { getRun } from '@/lib/runs/repository';
import { ensurePlan } from '@/lib/validation/repository';

import { PlanBoard } from './plan-board';

export interface PlanPanelProps {
  runId: number;
  /**
   * The conversation page already frames the view (tabs + title), so the
   * standalone header and its links to other routes are dropped there.
   */
  embedded?: boolean;
}

/**
 * The 14-day plan of one run. Tasks are materialised on first read, which is
 * why this lives in the RSC: `/runs/[runId]/plan` and the conversation's 计划
 * tab share the same call instead of each owning a copy.
 */
export async function PlanPanel({ runId, embedded = false }: PlanPanelProps) {
  const run = await getRun(runId);
  if (!run.ok) throw new Error(run.message);
  if (run.value === null) notFound();

  const plan = await ensurePlan(runId);
  if (!plan.ok) throw new Error(plan.message);

  const stage = run.value.stage === null ? '' : ` · 阶段 ${run.value.stage}`;

  return (
    <div className="mx-auto w-full max-w-[1000px] p-4 md:p-6">
      <PageHeader
        title="14 天验证计划"
        description={`run #${runId} · 状态 ${run.value.status}${stage} · 先验证真实付费，再决定是否开发。`}
        actions={
          embedded ? undefined : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/runs/${runId}/evidence`}>查看证据库</Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/runs/${runId}`}>运行监控</Link>
              </Button>
            </>
          )
        }
      />

      <PlanBoard runId={runId} tasks={plan.value} />
    </div>
  );
}
