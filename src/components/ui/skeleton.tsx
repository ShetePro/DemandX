import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-lg bg-surface-2', className)} {...props} />;
}
