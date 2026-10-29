import { Progress } from '@/components/ui/progress';
import type { ProviderRow, ProviderUsageSummary } from '@/lib/llm/types';

export type UsagePanelProps = {
  provider: ProviderRow;
  usage: ProviderUsageSummary;
};

function percentOf(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((count / total) * 100));
}

/**
 * Rolling counters for one provider. The 5h/week bars compare against the
 * busiest window (there is no per-window request quota in the data model); the
 * month bar uses the declared USD allowance when there is one, which is the
 * number the operator actually budgets against.
 */
export function UsagePanel({ provider, usage }: UsagePanelProps) {
  const busiest = Math.max(usage.fiveHourRequests, usage.weeklyRequests, 1);
  const allowance = provider.monthlyAllowanceUsd;
  const monthlyPercent =
    allowance !== null && allowance > 0
      ? Math.min(100, Math.round((usage.monthlySpendUsd / allowance) * 100))
      : percentOf(usage.monthlyRequests, busiest);

  const rows = [
    {
      label: '5 小时',
      value: usage.fiveHourRequests,
      percent: percentOf(usage.fiveHourRequests, busiest),
      detail: `${usage.fiveHourRequests} 次`,
      tone: 'accent' as const,
    },
    {
      label: '本周',
      value: usage.weeklyRequests,
      percent: percentOf(usage.weeklyRequests, busiest),
      detail: `${usage.weeklyRequests} 次`,
      tone: 'accent' as const,
    },
    {
      label: '本月',
      value: usage.monthlyRequests,
      percent: monthlyPercent,
      detail:
        allowance !== null && allowance > 0
          ? `$${usage.monthlySpendUsd.toFixed(2)} / $${allowance.toFixed(2)}`
          : `${usage.monthlyRequests} 次`,
      tone: monthlyPercent >= 90 ? ('warning' as const) : ('success' as const),
    },
  ];

  return (
    <section
      aria-labelledby="usage-heading"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div>
        <h2 id="usage-heading" className="text-sm font-semibold text-fg">
          用量
        </h2>
        <p className="mt-0.5 text-[11px] text-faint">
          {provider.name} 最近窗口的计数，由 provider 上报
        </p>
      </div>

      <dl className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[48px_minmax(0,1fr)_84px] items-center gap-2"
          >
            <dt className="text-[11px] text-muted">{row.label}</dt>
            <dd className="min-w-0">
              <Progress
                value={row.percent}
                tone={row.tone}
                aria-label={`${provider.name} ${row.label}用量`}
              />
            </dd>
            <dd className="text-right text-[11px] font-semibold text-fg">{row.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
