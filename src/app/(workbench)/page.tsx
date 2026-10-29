import { Sparkles, TriangleAlert } from 'lucide-react';
import Link from 'next/link';

import { GradeBadge } from '@/components/common/grade-badge';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  WORKBENCH_FIXTURES,
  type RunDecision,
  type RunStatus,
  type WorkbenchRun,
} from '@/features/workbench/fixtures';
import { cn } from '@/lib/utils/cn';
import { formatRelativeTime, formatScore } from '@/lib/utils/format';

// Relative labels are computed per request; a static prerender would freeze them at build time.
export const dynamic = 'force-dynamic';

/** Status wording and tone; running is the only state with a live dot. */
const STATUS_META: Record<
  RunStatus,
  { label: string; tone: 'accent' | 'success' | 'warning' | 'danger'; live?: boolean }
> = {
  running: { label: '进行中', tone: 'accent', live: true },
  completed: { label: '已完成', tone: 'success' },
  abandoned: { label: '已放弃', tone: 'danger' },
  partial: { label: '部分完成', tone: 'warning' },
};

const DECISION_LABELS: Record<RunDecision, string> = {
  'validate-first': '建议先验证',
  abandon: '建议放弃',
  insufficient: '证据不足',
};

const SUGGESTED_TOPICS = ['跨境库存同步', '小团队发票管理', '小红书选题工具'] as const;

function StatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status];

  return (
    <Badge tone={meta.tone}>
      {meta.live ? (
        <span aria-hidden="true" className="mr-1.5 inline-block size-1.5 rounded-full bg-current" />
      ) : null}
      {meta.label}
    </Badge>
  );
}

function RunTable({ runs }: { runs: readonly WorkbenchRun[] }) {
  if (runs.length === 0) return <EmptyState />;

  return (
    <Card className="overflow-hidden">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">研究方向列表</caption>
        <thead>
          <tr className="border-b border-border text-[11px] font-medium text-muted">
            <th scope="col" className="px-4 py-2.5">
              研究方向
            </th>
            <th scope="col" className="px-4 py-2.5">
              状态
            </th>
            <th scope="col" className="px-4 py-2.5">
              结论
            </th>
            <th scope="col" className="px-4 py-2.5">
              总分与可信度
            </th>
            <th scope="col" className="px-4 py-2.5">
              更新
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.title}
              className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-2"
            >
              <td className="px-4 py-2.5">
                <Link
                  href="/runs/latest/report"
                  className="rounded-sm font-medium text-fg underline-offset-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {run.title}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge status={run.status} />
              </td>
              <td className={cn('px-4 py-2.5', run.decision ? 'text-fg' : 'text-muted')}>
                {run.decision ? DECISION_LABELS[run.decision] : '—'}
              </td>
              <td className="px-4 py-2.5">
                {run.score === null || run.grade === null ? (
                  <span className="text-muted">— / —</span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <span className="font-semibold text-fg tabular-nums">
                      {formatScore(run.score)}
                    </span>
                    <GradeBadge grade={run.grade} />
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                {formatRelativeTime(run.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Inline until the shared empty state lands in a later task. */
function EmptyState() {
  return (
    <Card className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-fg">还没有研究记录</p>
      <p className="mt-1 text-xs text-muted">发起第一次研究后，结果会显示在这里。</p>
    </Card>
  );
}

export default function WorkbenchPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6.5">
      <PageHeader title="工作台" description="所有研究都在本机运行，数据不出机器" />

      <div
        role="group"
        aria-labelledby="suggested-topics"
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        <span id="suggested-topics" className="inline-flex items-center gap-1.5 text-xs text-muted">
          <Sparkles aria-hidden="true" className="size-3.5 text-accent" />
          试试这些方向
        </span>
        {SUGGESTED_TOPICS.map((topic) => (
          <Button
            key={topic}
            variant="ghost"
            size="sm"
            disabled
            title="研究流程接入后可直接发起"
            className="rounded-full"
          >
            {topic}
          </Button>
        ))}
      </div>

      <RunTable runs={WORKBENCH_FIXTURES} />

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3.5 py-2.5 text-xs text-muted">
        <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
        <p>部分完成表示采集被配额或登录墙中断，结论标记为待验证。</p>
      </div>
    </div>
  );
}
