import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
