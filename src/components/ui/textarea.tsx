import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-9 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
