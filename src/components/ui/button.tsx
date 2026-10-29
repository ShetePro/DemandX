'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent/90',
        ghost: 'border border-border text-muted hover:bg-surface-2 hover:text-fg',
        danger: 'border border-danger/40 bg-danger-soft text-danger',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>`, merging styles and props. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';

  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
