'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';

import { SignalBadge } from '@/components/common/signal-badge';
import { Badge } from '@/components/ui/badge';
import type { ReportEvidenceItem } from '@/lib/report/read';
import { cn } from '@/lib/utils/cn';
import { formatDate } from '@/lib/utils/format';

export interface CitationPanelProps {
  /** Evidence id of the selected `[eN]`, or `null` before anything is chosen. */
  citationId: number | null;
  /** `null` when the citation row survived but its evidence row did not. */
  evidence: ReportEvidenceItem | null;
  /** The run's evidence library, for locating the same row there. */
  evidenceHref: string;
  className?: string;
}

/**
 * One citation in full: the platform and date, the quote cut from the stored
 * snapshot, and the two claim limits. The panel only displays what the server
 * sent — a missing evidence row is stated as missing, never reconstructed from
 * the claim text.
 */
export function CitationPanel({
  citationId,
  evidence,
  evidenceHref,
  className,
}: CitationPanelProps) {
  if (citationId === null) {
    return (
      <div
        className={cn(
          'rounded-xl border border-dashed border-border-strong bg-surface-2 p-4 text-sm text-muted',
          className,
        )}
      >
        点击正文中的 [eN] 查看证据原文、快照片段与它的证明边界。
      </div>
    );
  }

  if (evidence === null) {
    return (
      <div
        className={cn('rounded-xl border border-border bg-surface p-4 shadow-sm', className)}
        aria-live="polite"
      >
        <h2 className="text-sm font-semibold text-fg">引用 e{citationId}</h2>
        <p className="mt-2 text-sm text-muted">
          这条引用已不可用：引文记录还在，但对应的证据行已被删除。报告不会为此补写原文。
        </p>
      </div>
    );
  }

  const published = evidence.publishedAt;

  return (
    <div
      className={cn('rounded-xl border border-border bg-surface p-4 shadow-sm', className)}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">引用 e{evidence.id}</h2>
        {evidence.rejectedReason === null ? (
          <Badge tone="success">有效</Badge>
        ) : (
          <Badge tone="danger">已驳回</Badge>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="font-medium text-fg">{evidence.platform}</span>
        <span aria-hidden>·</span>
        <time dateTime={published === null ? undefined : published.toISOString()}>
          {published === null ? '时间未知' : formatDate(published)}
        </time>
        <SignalBadge signal={evidence.signal} />
        <Badge tone="neutral">{evidence.firstHand ? '一手' : '非一手'}</Badge>
      </div>

      <blockquote className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-sm leading-6 text-fg">
        {evidence.highlight === null ? (
          <span className="break-words whitespace-pre-wrap">{evidence.quote}</span>
        ) : (
          <span className="break-words whitespace-pre-wrap">
            {evidence.highlight.before}
            <mark className="rounded-sm bg-warning-soft px-0.5 text-fg">
              {evidence.highlight.quote}
            </mark>
            {evidence.highlight.after}
          </span>
        )}
      </blockquote>
      {evidence.highlight === null ? (
        <p className="mt-1.5 text-[11px] text-muted">快照缺失，仅显示已存引文，无法高亮。</p>
      ) : null}

      <section className="mt-4">
        <h3 className="text-[10px] font-semibold tracking-wide text-faint uppercase">支持什么</h3>
        <p className="mt-1 text-sm text-fg">{evidence.supports ?? '提取时未填写'}</p>
      </section>

      <section className="mt-3">
        <h3 className="text-[10px] font-semibold tracking-wide text-faint uppercase">
          不能证明什么
        </h3>
        <p className="mt-1 text-sm text-muted">{evidence.doesNotProve ?? '提取时未填写'}</p>
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs">
        <a
          href={evidence.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline"
        >
          打开原文链接
          <ExternalLink className="size-3" aria-hidden />
        </a>
        <Link
          href={`${evidenceHref}?q=${encodeURIComponent(evidence.quote.slice(0, 24))}`}
          className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          在证据库定位
        </Link>
      </div>
    </div>
  );
}
