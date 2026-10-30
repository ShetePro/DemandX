'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { NeedsHumanItem } from '@/lib/runs/human-queue';
import { formatRelativeTime } from '@/lib/utils/format';

import { retryRunAction } from './actions';

const REASON_LABEL: Readonly<Record<string, string>> = {
  login: '需要登录',
  captcha: '验证码',
  blocked: '被拦截',
};

export interface HumanQueueProps {
  items: readonly NeedsHumanItem[];
}

/**
 * Pages S1 refused to fetch because a person is required. "Retry" re-enqueues
 * the whole run: S1 skips URLs it already stored, so the retry only fetches
 * what was blocked (and anything new).
 */
export function HumanQueue({ items }: HumanQueueProps) {
  const router = useRouter();
  const [pendingRun, setPendingRun] = useState<number | null>(null);

  async function retry(runId: number) {
    setPendingRun(runId);
    const result = await retryRunAction(runId);
    if (!result.ok) {
      toast.error(result.message);
    } else {
      toast.success(`已重新入队 run ${runId}`);
      router.refresh();
    }
    setPendingRun(null);
  }

  return (
    <section aria-labelledby="human-queue-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="human-queue-heading" className="text-sm font-semibold text-fg">
          需要人工处理
        </h2>
        <p className="mt-0.5 text-[11px] text-muted">
          最近 {items.length} 条登录墙 / 验证码 / 拦截记录。不会自动重试，确认会话后再手动重试。
        </p>
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
          暂无待处理页面。
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface shadow-sm">
          {items.map((item) => (
            <li
              key={item.eventId}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg" title={item.url ?? undefined}>
                  {item.url ?? '（无 URL）'}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {item.platform ?? '未知平台'} · {formatRelativeTime(new Date(item.createdAt))} ·
                  run {item.runId}（{item.runStatus}）
                </p>
              </div>

              <Badge tone="warning">
                {REASON_LABEL[item.reason ?? ''] ?? item.reason ?? '未知原因'}
              </Badge>

              <Button
                size="sm"
                variant="ghost"
                onClick={() => void retry(item.runId)}
                disabled={pendingRun === item.runId}
              >
                {pendingRun === item.runId ? '入队中…' : '重试'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
