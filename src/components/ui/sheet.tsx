'use client';

import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

const Sheet = Dialog.Root;
const SheetTrigger = Dialog.Trigger;
const SheetClose = Dialog.Close;

type SheetContentProps = ComponentProps<typeof Dialog.Content> & {
  /** Edge the drawer slides in from. */
  side?: 'right';
};

const sideClass = {
  right: 'inset-y-0 right-0 border-l',
} as const;

function SheetOverlay({ className, ...props }: ComponentProps<typeof Dialog.Overlay>) {
  return (
    <Dialog.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm motion-safe:data-[state=closed]:animate-overlay-out motion-safe:data-[state=open]:animate-overlay-in',
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({ className, children, side = 'right', ...props }: SheetContentProps) {
  return (
    <Dialog.Portal>
      <SheetOverlay />
      <Dialog.Content
        className={cn(
          'fixed z-50 flex h-full w-full max-w-md flex-col gap-4 border-border bg-surface p-6 shadow-lg motion-safe:data-[state=closed]:animate-sheet-out motion-safe:data-[state=open]:animate-sheet-in',
          sideClass[side],
          className,
        )}
        {...props}
      >
        {children}
        <Dialog.Close className="absolute top-4 right-4 grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
          <X className="size-4" />
          <span className="sr-only">关闭</span>
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

function SheetTitle({ className, ...props }: ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title className={cn('text-base font-semibold text-fg', className)} {...props} />;
}

function SheetDescription({ className, ...props }: ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description className={cn('text-sm text-muted', className)} {...props} />;
}

function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
export type { SheetContentProps };
