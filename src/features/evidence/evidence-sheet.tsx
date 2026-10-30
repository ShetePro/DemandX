'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatCurrency, formatRelativeTime } from '@/lib/utils/format';

import { rejectEvidenceAction, restoreEvidenceAction } from './actions';
import { rejectedReasonLabel, type EvidenceViewItem } from './types';

export interface EvidenceSheetProps {
  /** `null` keeps the drawer closed. */
  item: EvidenceViewItem | null;
  onClose: () => void;
  /** Called after a successful action so the RSC can refresh the table. */
  onChanged: () => void;
}

type Pending = 'reject' | 'restore' | null;

/**
 * One evidence row in full: the quote with its real snapshot context, the two
 * claim limits, and the operator's accept/reject control. Highlighting is done
 * on the server — `highlight` already holds the only three fragments the
 * browser is allowed to see.
 */
export function EvidenceSheet({ item, onClose, onChanged }: EvidenceSheetProps) {
  const [pending, setPending] = useState<Pending>(null);
  const open = item !== null;

  async function reject() {
    if (!item || pending) return;
    setPending('reject');
    try {
      const result = await rejectEvidenceAction(item.id);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success('已驳回该证据');
      onChanged();
    } catch {
      toast.error('驳回失败：网络错误');
    } finally {
      setPending(null);
    }
  }

  async function restore() {
    if (!item || pending) return;
    setPending('restore');
    try {
      const result = await restoreEvidenceAction(item.id);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(result.value.changed ? '已恢复为有效证据' : '该证据已是有效状态');
      onChanged();
    } catch {
      toast.error('恢复失败：网络错误');
    } finally {
      setPending(null);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        {item === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>证据 #{item.id}</SheetTitle>
              <SheetDescription>
                {item.platform} · {formatRelativeTime(item.publishedAt ?? item.createdAt)}
              </SheetDescription>
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-muted">平台</dt>
                <dd className="mt-0.5 text-fg">{item.platform}</dd>
              </div>
              <div>
                <dt className="text-muted">时间</dt>
                <dd className="mt-0.5 text-fg">
                  {(item.publishedAt ?? item.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </dd>
              </div>
              <div>
                <dt className="text-muted">一手</dt>
                <dd className="mt-0.5 text-fg">{item.firstHand ? '一手' : '非一手'}</dd>
              </div>
              <div>
                <dt className="text-muted">价格</dt>
                <dd className="mt-0.5 text-fg">
                  {item.priceMentioned === null
                    ? '未提及'
                    : formatCurrency(item.priceMentioned.amount, item.priceMentioned.currency)}
                </dd>
              </div>
            </dl>

            <section aria-label="引文高亮" className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold text-fg">原文引文</h3>
              <blockquote className="rounded-lg border border-border bg-surface-2 p-3 text-sm leading-6 text-fg">
                {item.highlight === null ? (
                  <span className="break-words whitespace-pre-wrap">{item.quote}</span>
                ) : (
                  <span className="break-words whitespace-pre-wrap">
                    {item.highlight.before}
                    <mark className="rounded-sm bg-warning-soft px-0.5 text-fg">
                      {item.highlight.quote}
                    </mark>
                    {item.highlight.after}
                  </span>
                )}
              </blockquote>
              {item.highlight === null ? (
                <p className="text-[11px] text-muted">
                  {item.rejectedReason === null
                    ? '快照缺失，无法高亮，仅显示已存引文。'
                    : '已驳回的证据不做快照高亮。'}
                </p>
              ) : null}
            </section>

            <section aria-label="支持与限制" className="flex flex-col gap-2 text-sm">
              <div>
                <h3 className="text-xs font-semibold text-fg">支持什么</h3>
                <p className="mt-0.5 text-muted">{item.supports ?? '提取时未填写'}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-fg">不能证明什么</h3>
                <p className="mt-0.5 text-muted">{item.doesNotProve ?? '提取时未填写'}</p>
              </div>
            </section>

            <div className="flex flex-col gap-1.5 text-xs">
              <p className="text-muted">
                快照 hash{' '}
                <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-fg">
                  {item.contentHash.slice(0, 12)}…
                </code>
              </p>
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline"
              >
                打开原文链接
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {item.rejectedReason === null ? (
                <Badge tone="success">有效</Badge>
              ) : (
                <>
                  <Badge tone="danger">已驳回</Badge>
                  <span className="text-xs text-muted">
                    {rejectedReasonLabel(item.rejectedReason)}（{item.rejectedReason}）
                  </span>
                </>
              )}
            </div>

            <SheetFooter className="items-start gap-2 sm:flex-col sm:items-start">
              {item.rejectedReason === null ? (
                <Button variant="danger" onClick={() => void reject()} disabled={pending !== null}>
                  {pending === 'reject' ? '驳回中…' : '驳回'}
                </Button>
              ) : (
                <Button onClick={() => void restore()} disabled={pending !== null}>
                  {pending === 'restore' ? '恢复中…' : '恢复为有效'}
                </Button>
              )}
              <p className="text-[11px] text-muted">
                驳回只标记 `rejected_reason=manual`，不改动已抽取的引文；评分在 P5 读取该标记。
              </p>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
