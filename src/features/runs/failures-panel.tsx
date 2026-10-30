import { Badge } from '@/components/ui/badge';
import type { SourceEventSummary } from '@/lib/runs/sources-repository';
import { formatRelativeTime } from '@/lib/utils/format';

import { sourceEventTypeLabel, sourceReasonLabel } from './labels';

export interface FailureItem {
  key: string;
  type: string;
  url: string | null;
  platform: string | null;
  reason: string | null;
  createdAt: Date | null;
}

export interface FailuresPanelProps {
  summary: SourceEventSummary;
  /** Newest first, at most 10. */
  items: readonly FailureItem[];
}

/**
 * What S1 could not collect. Counts come from the whole event log; the list is
 * the newest ten, because the panel is a work queue, not an archive.
 */
export function FailuresPanel({ summary, items }: FailuresPanelProps) {
  const empty = summary.needsHuman + summary.failed + summary.skipped === 0;

  return (
    <section
      aria-labelledby="failures-heading"
      className="flex flex-col rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="failures-heading" className="text-sm font-semibold text-fg">
          失败与人工队列
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={summary.needsHuman > 0 ? 'warning' : 'neutral'}>
            待人工 {summary.needsHuman}
          </Badge>
          <Badge tone={summary.failed > 0 ? 'danger' : 'neutral'}>失败 {summary.failed}</Badge>
          <Badge tone="neutral">跳过 {summary.skipped}</Badge>
        </div>
      </div>

      {empty ? (
        <p className="mt-3 text-sm text-muted">没有失败或跳过的页面。</p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">计数来自更早的事件，最近 10 条为空。</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {items.map((item) => (
            <li key={item.key} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted">
                  {sourceEventTypeLabel(item.type)}
                </span>
                <span className="text-[11px] text-faint">{sourceReasonLabel(item.reason)}</span>
                {item.createdAt === null ? null : (
                  <span className="ml-auto text-[11px] text-faint">
                    {formatRelativeTime(item.createdAt)}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-fg" title={item.url ?? undefined}>
                {item.url ?? '（无 URL）'}
              </p>
              {item.platform === null ? null : (
                <p className="text-[11px] text-faint">{item.platform}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
