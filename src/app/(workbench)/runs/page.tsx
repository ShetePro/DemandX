import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RunStatusBadge } from '@/features/runs/status-badge';
import { listRuns, type RunSummaryRecord } from '@/lib/runs/repository';
import { stageLabel } from '@/lib/runs/stages';
import { formatRelativeTime } from '@/lib/utils/format';

// New runs and freshly finished reports must appear without a redeploy.
export const dynamic = 'force-dynamic';

/** The index stops at the 50 newest runs; older ones stay reachable by URL. */
const RUN_LIST_LIMIT = 50;

const ACTION_LINK =
  'rounded-sm underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

function Actions({ run }: { run: RunSummaryRecord }) {
  return (
    <div className="flex items-center gap-3 text-xs whitespace-nowrap">
      <Link href={`/runs/${run.id}`} className={ACTION_LINK}>
        监控
      </Link>
      {run.hasReport ? (
        <Link href={`/runs/${run.id}/report`} className={ACTION_LINK}>
          报告
        </Link>
      ) : (
        <span
          role="link"
          aria-disabled="true"
          aria-label="报告尚未生成"
          title="报告尚未生成"
          className="cursor-not-allowed text-faint"
        >
          报告
        </span>
      )}
      <Link href={`/runs/${run.id}/evidence`} className={ACTION_LINK}>
        证据库
      </Link>
      <Link href={`/runs/${run.id}/plan`} className={ACTION_LINK}>
        验证计划
      </Link>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="px-4 py-12 text-center">
      <p className="text-sm font-medium text-fg">还没有研究记录</p>
      <p className="mt-1 text-xs text-muted">
        发起一次研究后，这里会列出它的监控、报告、证据库与 14 天验证计划。
      </p>
      <Button asChild size="sm" className="mt-4">
        <Link href="/threads/new">发起第一次研究</Link>
      </Button>
    </Card>
  );
}

function RunList({ runs }: { runs: readonly RunSummaryRecord[] }) {
  if (runs.length === 0) return <EmptyState />;

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left text-sm">
          <caption className="sr-only">最近 50 次研究</caption>
          <thead>
            <tr className="border-b border-border text-[11px] font-medium text-muted">
              <th scope="col" className="px-4 py-2.5">
                ID
              </th>
              <th scope="col" className="px-4 py-2.5">
                研究方向
              </th>
              <th scope="col" className="px-4 py-2.5">
                状态
              </th>
              <th scope="col" className="px-4 py-2.5">
                阶段
              </th>
              <th scope="col" className="px-4 py-2.5">
                报告
              </th>
              <th scope="col" className="px-4 py-2.5">
                更新时间
              </th>
              <th scope="col" className="px-4 py-2.5">
                入口
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-2"
              >
                <td className="px-4 py-2.5 font-mono text-xs text-muted tabular-nums">#{run.id}</td>
                <td className="px-4 py-2.5">
                  <Link
                    href={`/runs/${run.id}`}
                    className="rounded-sm font-medium text-fg underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {run.ideaTitle}
                  </Link>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <RunStatusBadge status={run.status} />
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                  {stageLabel(run.stage) ?? '—'}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <Badge tone={run.hasReport ? 'success' : 'neutral'}>
                    {run.hasReport ? '已生成' : '未生成'}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                  {formatRelativeTime(run.updatedAt)}
                </td>
                <td className="px-4 py-2.5">
                  <Actions run={run} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default async function RunsPage() {
  const runs = await listRuns(RUN_LIST_LIMIT);
  if (!runs.ok) throw new Error(runs.message);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6.5">
      <PageHeader
        title="报告与证据"
        description="最近 50 次研究。监控看进度，报告看结论，证据库逐条核对原文，验证计划记录下一步实验。"
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/threads/new">新建研究</Link>
          </Button>
        }
      />

      <RunList runs={runs.value} />
    </div>
  );
}
