'use client';

import { useState, type ReactNode } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ProviderRow } from '@/lib/llm/types';

import { ProviderForm } from './provider-form';

export type ProviderDialogProps = {
  /** Absent when creating a new provider. */
  provider?: ProviderRow;
  trigger: ReactNode;
};

/** Add/edit form in a dialog; the form itself owns validation and the action call. */
export function ProviderDialog({ provider, trigger }: ProviderDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{provider ? `编辑 ${provider.name}` : '添加 provider'}</DialogTitle>
          <DialogDescription>
            Key 加密存储，页面上只会显示掩码。保存后下一次运行生效。
          </DialogDescription>
        </DialogHeader>
        <ProviderForm provider={provider} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
