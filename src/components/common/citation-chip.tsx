'use client';

import { cn } from '@/lib/utils/cn';

export type CitationChipProps = {
  /** Citation anchor without brackets, e.g. `e12`. */
  id: string;
  onOpen?: ((id: string) => void) | undefined;
  className?: string | undefined;
};

/**
 * Inline reference marker. It is a real button so keyboard users can open the
 * evidence drawer; the label spells the anchor out for screen readers, which
 * the visual `[e12]` alone would not.
 */
export function CitationChip({ id, onOpen, className }: CitationChipProps) {
  return (
    <button
      type="button"
      aria-label={`证据 ${id}`}
      onClick={() => onOpen?.(id)}
      className={cn(
        'mx-0.5 inline-flex items-center rounded-full border border-accent/30 bg-accent-soft px-1.5 py-0 align-baseline text-[11px] font-medium text-accent',
        'hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      )}
    >
      {id}
    </button>
  );
}
