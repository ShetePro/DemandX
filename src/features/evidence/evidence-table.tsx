'use client';

import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { SignalBadge } from '@/components/common/signal-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SIGNALS, type Signal } from '@/lib/evidence/schema';
import { formatRelativeTime } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

import { EvidenceSheet } from './evidence-sheet';
import {
  rejectedReasonLabel,
  type EvidenceCounts,
  type EvidenceFilterState,
  type EvidenceStatusFilter,
  type EvidenceViewItem,
} from './types';

export interface EvidenceTableProps {
  items: readonly EvidenceViewItem[];
  counts: EvidenceCounts;
  filters: EvidenceFilterState;
  /** Platforms present in this run, for the select. */
  platforms: readonly string[];
  /** Optional hook (tests/analytics); the drawer opens regardless. */
  onOpen?: ((item: EvidenceViewItem) => void) | undefined;
}

const SIGNAL_LABEL: Readonly<Record<Signal, string>> = {
  problem: '问题',
  seeking: '寻找',
  paying: '付费',
  switching: '切换',
  recurring: '持续',
};

const SIGNAL_TABS: ReadonlyArray<{ value: Signal | null; label: string }> = [
  { value: null, label: '全部' },
  ...SIGNALS.map((signal) => ({ value: signal, label: SIGNAL_LABEL[signal] })),
];

const STATUS_OPTIONS: ReadonlyArray<{ value: EvidenceStatusFilter | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'accepted', label: '有效' },
  { value: 'rejected', label: '已驳回' },
];

/** 80 characters keeps a row scannable; the drawer carries the full quote. */
function summary(quote: string): string {
  return quote.length > 80 ? `${quote.slice(0, 80)}…` : quote;
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, EvidenceViewItem>();

const columns = helper.columns([
  helper.accessor('signal', {
    header: '信号',
    cell: (ctx) => <SignalBadge signal={ctx.getValue()} />,
  }),
  helper.accessor('platform', {
    header: '平台',
    cell: (ctx) => <span className="text-fg">{ctx.getValue()}</span>,
  }),
  helper.accessor((row) => row.publishedAt ?? row.createdAt, {
    id: 'time',
    header: '时间',
    cell: (ctx) => (
      <span className="whitespace-nowrap text-muted">{formatRelativeTime(ctx.getValue())}</span>
    ),
  }),
  helper.accessor('quote', {
    header: '摘要',
    cell: (ctx) => (
      <span className="text-fg" title={ctx.getValue()}>
        {summary(ctx.getValue())}
      </span>
    ),
  }),
  helper.accessor('rejectedReason', {
    header: '状态',
    cell: (ctx) => {
      const reason = ctx.getValue();
      if (reason === null) return <Badge tone="success">有效</Badge>;
      return (
        <span className="flex flex-col gap-0.5">
          <Badge tone="danger">已驳回</Badge>
          <span className="text-[11px] text-muted">{rejectedReasonLabel(reason)}</span>
        </span>
      );
    },
  }),
  helper.display({
    id: 'open',
    header: '操作',
    cell: () => <span className="font-medium whitespace-nowrap text-accent">查看</span>,
  }),
]);

/** Canonical query order: signal → platform → status → q. */
function hrefFor(
  pathname: string,
  filters: EvidenceFilterState,
  patch: Partial<EvidenceFilterState>,
): string {
  const next = { ...filters, ...patch };
  const params = new URLSearchParams();
  if (next.signal) params.set('signal', next.signal);
  if (next.platform) params.set('platform', next.platform);
  if (next.status) params.set('status', next.status);
  if (next.q) params.set('q', next.q);
  const query = params.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
}

/**
 * Server-filtered evidence table. Every control writes the URL, so a filtered
 * view is shareable and survives a refresh; the RSC re-queries instead of the
 * client filtering a 200-row page it does not own.
 */
export function EvidenceTable({ items, counts, filters, platforms, onOpen }: EvidenceTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [openId, setOpenId] = useState<number | null>(null);

  const table = useTable({
    features,
    columns,
    data: items,
    getRowId: (row) => String(row.id),
  });

  const openItem = openId === null ? null : (items.find((item) => item.id === openId) ?? null);

  function navigate(patch: Partial<EvidenceFilterState>) {
    // Reads the parsed props rather than the raw URL, so an ignored invalid
    // param can never be carried into the next navigation.
    router.push(hrefFor(pathname, filters, patch));
  }

  function open(item: EvidenceViewItem) {
    setOpenId(item.id);
    onOpen?.(item);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          有效 <strong className="text-fg">{counts.accepted}</strong>
        </span>
        <span aria-hidden>·</span>
        <span>
          已驳回 <strong className="text-fg">{counts.rejected}</strong>
        </span>
        {items.length > 0 ? (
          <span className="ml-auto">
            当前显示 {items.length} 条（最多 200 条）
            {searchParams.toString() === '' ? '' : '，筛选已写入地址栏'}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-sm">
        <nav aria-label="按信号筛选" className="flex flex-wrap gap-1">
          {SIGNAL_TABS.map((tab) => {
            const active = filters.signal === tab.value;
            return (
              <button
                key={tab.value ?? 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => navigate({ signal: tab.value })}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            平台
            <select
              value={filters.platform ?? ''}
              onChange={(event) => navigate({ platform: event.target.value || null })}
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <option value="">全部平台</option>
              {platforms.map((platform) => (
                <option key={platform} value={platform}>
                  {platform}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-muted">
            状态
            <select
              value={filters.status ?? ''}
              onChange={(event) =>
                navigate({
                  status:
                    event.target.value === 'accepted' || event.target.value === 'rejected'
                      ? event.target.value
                      : null,
                })
              }
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <form
            role="search"
            aria-label="搜索证据"
            className="flex min-w-[240px] flex-1 items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
              navigate({ q: value || null });
            }}
          >
            <label
              htmlFor="evidence-search"
              className="flex flex-1 flex-col gap-1 text-[11px] text-muted"
            >
              搜索
              {/* URL is the source of truth: back/forward navigation resets the box. */}
              <Input
                id="evidence-search"
                name="q"
                key={filters.q ?? ''}
                defaultValue={filters.q ?? ''}
                placeholder="引文、支持、限制或原文 URL"
                aria-label="搜索证据"
              />
            </label>
            <Button type="submit" variant="ghost">
              搜索
            </Button>
          </form>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-sm">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="bg-surface-2 text-[11px] text-muted">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id} className="px-3 py-2 font-medium">
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-muted">
                  没有符合条件的证据。
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`查看证据 ${row.original.id}`}
                  onClick={() => open(row.original)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    open(row.original);
                  }}
                  className="cursor-pointer border-t border-border align-top transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <EvidenceSheet
        item={openItem}
        onClose={() => setOpenId(null)}
        onChanged={() => router.refresh()}
      />
    </div>
  );
}
