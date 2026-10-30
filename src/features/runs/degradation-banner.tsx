import { TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { SourceEventSummary } from '@/lib/runs/sources-repository';

import { sourceReasonLabel } from './labels';

export interface DegradationBannerProps {
  /** Run status from the live fold; `failed` alone is enough to degrade. */
  status: string;
  summary: Pick<SourceEventSummary, 'skipped' | 'capped' | 'cappedMaxPages' | 'reasons'>;
  /** Failure code from `run.failed`, when the run ended badly. */
  error: string | null;
}

/**
 * The honest header for a partial collection. It appears when the run failed
 * or when S1 hit its page cap / skipped a page, and lists the reasons with
 * their counts so "部分完成" never reads as a complete result.
 */
export function DegradationBanner({ status, summary, error }: DegradationBannerProps) {
  const degraded = status === 'failed' || summary.capped || summary.skipped > 0;
  if (!degraded) return null;

  return (
    <section
      role="status"
      aria-labelledby="degradation-heading"
      className="rounded-xl border border-warning/40 bg-warning-soft p-4"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <h2 id="degradation-heading" className="text-sm font-semibold text-fg">
            部分采集未完成
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {status === 'failed'
              ? '本轮运行失败，已采集到的证据仍然保留；以下原因导致部分页面没有进入结论。'
              : '以下原因导致部分页面没有进入结论；报告中的相关判断按证据不足处理。'}
          </p>

          <ul className="mt-2 flex flex-wrap items-center gap-1.5">
            {summary.reasons.map((item) => (
              <li key={item.reason}>
                <Badge tone="warning">
                  {sourceReasonLabel(item.reason)} · {item.count}
                </Badge>
              </li>
            ))}
            {summary.reasons.length === 0 && summary.skipped > 0 ? (
              <li>
                <Badge tone="warning">未记录原因 · {summary.skipped}</Badge>
              </li>
            ) : null}
            {summary.capped ? (
              <li>
                <Badge tone="warning">
                  达到采集上限
                  {summary.cappedMaxPages === null ? '' : `（最多 ${summary.cappedMaxPages} 页）`}
                </Badge>
              </li>
            ) : null}
          </ul>

          {status === 'failed' && error !== null ? (
            <p className="mt-2 text-xs text-danger">错误代码：{error}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
