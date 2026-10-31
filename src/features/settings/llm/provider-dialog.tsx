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
import { cn } from '@/lib/utils/cn';
import type { ProviderRow } from '@/lib/llm/types';

import { CatalogTab } from './catalog-tab';
import { ProviderForm, type ProviderFormDefaults } from './provider-form';

export type ProviderDialogProps = {
  /** Absent when creating a new provider. */
  provider?: ProviderRow;
  trigger: ReactNode;
};

type Tab = 'catalog' | 'manual';

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'catalog', label: '目录' },
  { value: 'manual', label: '手动' },
];

/**
 * Add/edit form in a dialog. Creating starts on the models.dev directory; the
 * manual tab keeps the full form and receives whatever the directory selection
 * pre-filled, so switching tabs never loses the endpoint.
 */
export function ProviderDialog({ provider, trigger }: ProviderDialogProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('catalog');
  const [prefill, setPrefill] = useState<ProviderFormDefaults | undefined>(undefined);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setTab('catalog');
      setPrefill(undefined);
    }
  }

  const creating = provider === undefined;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{provider ? `编辑 ${provider.name}` : '添加 provider'}</DialogTitle>
          <DialogDescription>
            {creating
              ? '从 models.dev 目录选择，自动带入模型清单；目录不可用时使用内置列表，也可以手动填写。'
              : 'Key 加密存储，页面上只会显示掩码。保存后下一次运行生效。'}
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <div className="flex flex-col gap-4">
            <div
              role="tablist"
              aria-label="添加方式"
              className="flex gap-1 border-b border-border pb-2"
            >
              {TABS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={tab === option.value}
                  onClick={() => setTab(option.value)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    tab === option.value
                      ? 'bg-accent-soft text-accent'
                      : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" aria-label={tab === 'catalog' ? '目录' : '手动'}>
              {tab === 'catalog' ? (
                <CatalogTab
                  onPrefillChange={setPrefill}
                  onRequestManual={() => setTab('manual')}
                  onCreated={() => setOpen(false)}
                />
              ) : (
                <ProviderForm initialValues={prefill} onSaved={() => setOpen(false)} />
              )}
            </div>
          </div>
        ) : (
          <ProviderForm provider={provider} onSaved={() => setOpen(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
