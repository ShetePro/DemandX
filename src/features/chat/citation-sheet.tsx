'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export type CitationSheetProps = {
  /** Anchor without brackets (`e12`), or `null` while closed. */
  citationId: string | null;
  /** Evidence page of the current run; `null` before a run exists. */
  evidenceHref: string | null;
  onClose: () => void;
};

/**
 * Evidence drawer for one `[eN]` anchor. The drawer itself only knows the
 * anchor, not which row it points at, so it links to the evidence page where
 * the quote, snapshot highlight and status are shown; it never invents a quote.
 */
export function CitationSheet({ citationId, evidenceHref, onClose }: CitationSheetProps) {
  const label = citationId ?? '';

  return (
    <Sheet
      open={citationId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>证据 {label}</SheetTitle>
          <SheetDescription>引用详情与原文链接</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg">证据 {label} 的原文、快照高亮与状态在证据库中查看</p>
          <p className="text-xs text-muted">
            对话只保留引用锚点；未经快照校验的内容不会在这里展示。
          </p>
        </div>

        {evidenceHref === null ? (
          <SheetFooter className="items-start gap-2 sm:flex-col sm:items-start">
            <Button disabled>打开证据库</Button>
            <p className="text-xs text-muted">研究尚未开始，证据库链接不可用。</p>
          </SheetFooter>
        ) : (
          <SheetFooter className="items-start gap-2 sm:flex-col sm:items-start">
            <Button asChild>
              <Link href={evidenceHref}>打开证据库</Link>
            </Button>
            <p className="text-xs text-muted">证据库可核对引文、快照与人工驳回状态。</p>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
