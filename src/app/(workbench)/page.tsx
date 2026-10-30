import Link from 'next/link';

import { GradeBadge, type Grade } from '@/components/common/grade-badge';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RunStatusBadge } from '@/features/runs/status-badge';
import { listRuns, type RunSummaryRecord } from '@/lib/runs/repository';
import { cn } from '@/lib/utils/cn';
import { formatRelativeTime, formatScore } from '@/lib/utils/format';

// Relative labels are computed per request; a static prerender would freeze them at build time.
export const dynamic = 'force-dynamic';

/** The workbench is a preview of the four newest runs; `/runs` holds the rest. */
const WORKBENCH_LIMIT = 4;

function isGrade(value: string | null): value is Grade {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D';
}

/** A rubric total is 0–100; anything else renders as missing rather than throwing. */
function scoreLabel(score: number | null): string | null {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 100) return null;
  return formatScore(score);
}

function RunTable({ runs }: { runs: readonly RunSummaryRecord[] }) {
  if (runs.length === 0) return <EmptyState />;

  return (
    <Card className="overflow-hidden">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">最近的研究方向</caption>
        <thead>
          <tr className="border-b border-border text-[11px] font-medium text-muted">
            <th scope="col" className="px-4 py-2.5">
              研究方向
            </th>
            <th scope="col" className="px-4 py-2.5">
              状态
            </th>
            <th scope="col" className="hidden px-4 py-2.5 md:table-cell">
              结论
            </th>
            <th scope="col" className="px-4 py-2.5">
              总分与可信度
            </th>
            <th scope="col" className="hidden px-4 py-2.5 md:table-cell">
              更新
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            // Without a report the report page only says "尚未生成", so the
            // title goes to the monitor instead.
            const href = run.hasReport ? `/runs/${run.id}/report` : `/runs/${run.id}`;
            const score = scoreLabel(run.rubricTotal);

            return (
              <tr
                key={run.id}
                className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-2"
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={href}
                    className="rounded-sm font-medium text-fg underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {run.ideaTitle}
                  </Link>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <RunStatusBadge status={run.status} />
                </td>
                <td
                  className={cn(
                    'hidden px-4 py-2.5 md:table-cell',
                    run.decision ? 'text-fg' : 'text-muted',
                  )}
                >
                  {run.decision ?? '—'}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  {score === null && !isGrade(run.credibilityGrade) ? (
                    <span className="text-muted">— / —</span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-semibold text-fg tabular-nums">{score ?? '—'}</span>
                      {isGrade(run.credibilityGrade) ? (
                        <GradeBadge grade={run.credibilityGrade} />
                      ) : (
                        <span className="text-xs text-muted">可信度未知</span>
                      )}
                    </span>
                  )}
                </td>
                <td className="hidden px-4 py-2.5 whitespace-nowrap text-muted md:table-cell">
                  {formatRelativeTime(run.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-fg">还没有研究记录</p>
      <p className="mt-1 text-xs text-muted">发起第一次研究后，这里会显示状态、结论与报告入口。</p>
      <Button asChild size="sm" className="mt-4">
        <Link href="/threads/new">发起第一次研究</Link>
      </Button>
    </Card>
  );
}

export default async function WorkbenchPage() {
  const runs = await listRuns(WORKBENCH_LIMIT);
  if (!runs.ok) throw new Error(runs.message);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6.5">
      <PageHeader
        title="工作台"
        description="所有研究都在本机运行，数据不出机器"
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/runs">查看全部研究</Link>
          </Button>
        }
      />

      <RunTable runs={runs.value} />

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-xs text-muted">
        <p>报告只展示通过引文校验的结论；仍在采集或已失败的 run 可以进入监控与证据库核对进度。</p>
      </div>
    </div>
  );
}
