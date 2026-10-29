import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-2 text-muted',
        accent: 'border-accent/30 bg-accent-soft text-accent',
        success: 'border-success/30 bg-success-soft text-success',
        warning: 'border-warning/30 bg-warning-soft text-warning',
        danger: 'border-danger/30 bg-danger-soft text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
