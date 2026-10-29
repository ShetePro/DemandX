'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { ProviderRow } from '@/lib/llm/types';

import { ProviderDialog } from './provider-dialog';

export type ProviderListProps = {
  providers: ProviderRow[];
  selectedId: number | null;
  /** Cached model count per provider, for the subtitle. */
  modelCounts: Record<number, number>;
};

/**
 * Left column of the settings page. Each row is a link with
 * `aria-current="page"` when selected, so keyboard users get the same state a
 * mouse user reads from the accent ring.
 */
export function ProviderList({ providers, selectedId, modelCounts }: ProviderListProps) {
  return (
    <section aria-labelledby="providers-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="providers-heading" className="text-sm font-semibold text-fg">
          Providers
        </h2>
        <ProviderDialog
          trigger={
            <Button variant="ghost" size="sm">
              <Plus className="size-3.5" aria-hidden />
              添加
            </Button>
          }
        />
      </div>

      {providers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
          还没有 provider。先添加一个 endpoint，再拉取模型并配置链路。
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {providers.map((provider) => {
            const selected = provider.id === selectedId;
            const modelCount = modelCounts[provider.id] ?? 0;

            return (
              <li key={provider.id}>
                <Link
                  href={`/settings/llm?provider=${provider.id}`}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(
                    'flex flex-col gap-1 rounded-xl border bg-surface px-3 py-2.5 shadow-sm transition-colors',
                    selected
                      ? 'border-accent/60 bg-surface-2 ring-2 ring-accent-soft'
                      : 'border-border hover:border-accent/40 hover:bg-surface-2',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{provider.name}</span>
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        provider.enabled ? 'bg-success' : 'bg-border-strong',
                      )}
                      title={provider.enabled ? '已启用' : '已停用'}
                    />
                    <span className="ml-auto shrink-0 text-[11px] text-faint">
                      {provider.enabled ? '启用' : '停用'}
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted" title={provider.baseUrl}>
                    {provider.kind} · {provider.baseUrl}
                  </span>
                  <span className="truncate text-xs text-muted">
                    {provider.keyMask ?? '未配置 key'} · {modelCount} 个模型
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
