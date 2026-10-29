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
 * Evidence drawer for one `[eN]` anchor. The evidence store arrives in P4, so
 * the drawer states that the row is not available yet instead of inventing a
 * quote; the link to the real evidence page is the only thing it can offer.
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
          <p className="text-sm text-fg">证据 {label} 尚未入库（P4 接入）</p>
          <p className="text-xs text-muted">
            采集与抽取管线完成后，这里会显示原文、平台和抓取时间；目前不展示任何未经引用的内容。
          </p>
        </div>

        {evidenceHref === null ? (
          <SheetFooter className="items-start gap-2 sm:flex-col sm:items-start">
            <Button disabled>打开证据库</Button>
            <p className="text-xs text-muted">研究尚未开始，证据库链接不可用。</p>
          </SheetFooter>
        ) : (
          <SheetFooter>
            <Button asChild>
              <Link href={evidenceHref}>打开证据库</Link>
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
