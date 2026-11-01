import { Progress } from '@/components/ui/progress';
import type { ProviderRow, ProviderUsageSummary } from '@/lib/llm/types';

export type UsagePanelProps = {
  provider: ProviderRow;
  usage: ProviderUsageSummary;
};

/**
 * Rolling counters for one provider. Only the month has a real quota — the
 * operator-declared USD allowance — so only the month gets a bar. 5h/week are
 * plain counts, and without an allowance every row is just a count: a progress
 * bar against an invented total would be a lie.
 */
/** 1234 → 1.2k; exact below a thousand so small counts stay readable. */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
}

export function UsagePanel({ provider, usage }: UsagePanelProps) {
  const allowance = provider.monthlyAllowanceUsd;
  const hasAllowance = allowance !== null && allowance > 0;
  const monthlyPercent = hasAllowance
    ? Math.min(100, Math.round((usage.monthlySpendUsd / allowance) * 100))
    : 0;

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
          {provider.name} 最近窗口的调用与 token 用量，由本机记录（对话、研究、测试连接）
        </p>
        {hasAllowance ? (
          <p className="mt-0.5 text-[11px] text-faint">5 小时 / 本周为计数，相对最忙窗口，非配额</p>
        ) : null}
      </div>

      <dl className="flex flex-col gap-2.5">
        <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
          <dt className="text-[11px] text-muted">5 小时</dt>
          <dd className="text-[11px] text-fg">{usage.fiveHourRequests} 次</dd>
        </div>
        <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
          <dt className="text-[11px] text-muted">本周</dt>
          <dd className="text-[11px] text-fg">{usage.weeklyRequests} 次</dd>
        </div>
        <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
          <dt className="text-[11px] text-muted">本月</dt>
          {hasAllowance ? (
            <dd className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-2">
              <Progress
                value={monthlyPercent}
                tone={monthlyPercent >= 90 ? 'warning' : 'success'}
                aria-label={`${provider.name} 本月额度用量`}
              />
              <span className="text-right text-[11px] font-semibold text-fg">
                ${usage.monthlySpendUsd.toFixed(2)} / ${allowance.toFixed(2)}
              </span>
            </dd>
          ) : (
            <dd className="text-[11px] text-fg">{usage.monthlyRequests} 次</dd>
          )}
        </div>
        <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2 border-t border-border pt-2">
          <dt className="text-[11px] text-muted">本月 tokens</dt>
          <dd className="text-[11px] text-fg tabular-nums">
            入 {formatTokens(usage.monthlyPromptTokens)} · 出{' '}
            {formatTokens(usage.monthlyCompletionTokens)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
