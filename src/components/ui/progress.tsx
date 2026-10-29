import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, CSSProperties } from 'react';

import { cn } from '@/lib/utils/cn';

const progressVariants = cva('h-full rounded-full transition-[width] duration-300', {
  variants: {
    tone: {
      accent: 'bg-accent',
      success: 'bg-success',
      warning: 'bg-warning',
    },
  },
  defaultVariants: { tone: 'accent' },
});

export type ProgressProps = Omit<ComponentProps<'div'>, 'children'> &
  VariantProps<typeof progressVariants> & {
    /** Completion percentage; values outside 0–100 are clamped. */
    value: number;
  };

export function Progress({ value, tone, className, style, ...props }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-2', className)}
      // The fill width is carried by a CSS variable so the track stays a plain
      // token-colored element and consumers can still override `style`.
      style={{ '--w': `${clamped}%`, ...style } as CSSProperties}
      {...props}
    >
      <div className={progressVariants({ tone })} style={{ width: 'var(--w)' }} />
    </div>
  );
}
