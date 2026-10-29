import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-surface shadow-sm', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-sm font-semibold text-fg', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 p-4 pt-0', className)} {...props} />;
}
