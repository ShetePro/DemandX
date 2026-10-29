'use client';

import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

const DialogRoot = Dialog.Root;
const DialogTrigger = Dialog.Trigger;
const DialogClose = Dialog.Close;

function DialogOverlay({ className, ...props }: ComponentProps<typeof Dialog.Overlay>) {
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

function DialogContent({ className, children, ...props }: ComponentProps<typeof Dialog.Content>) {
  return (
    <Dialog.Portal>
      <DialogOverlay />
      <Dialog.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-surface p-6 shadow-lg motion-safe:data-[state=closed]:animate-dialog-out motion-safe:data-[state=open]:animate-dialog-in',
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

function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

function DialogTitle({ className, ...props }: ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title className={cn('text-base font-semibold text-fg', className)} {...props} />;
}

function DialogDescription({ className, ...props }: ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description className={cn('text-sm text-muted', className)} {...props} />;
}

function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export {
  DialogRoot as Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
