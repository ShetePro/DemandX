'use client';

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { Profile } from '@/lib/llm/port';
import type { ProviderModelRow, ProviderRow } from '@/lib/llm/types';

import { saveChainsAction } from './actions';

export type ChainDraft = { providerId: number; modelId: string };

export type ChainEditorProps = {
  initialChains: Record<Profile, ChainDraft[]>;
  providers: ProviderRow[];
  models: ProviderModelRow[];
};

type AvailableModel = ChainDraft & { label: string };

const PROFILE_COPY: Record<Profile, { hint: string }> = {
  bulk: { hint: '批量抽取 · 约 120 次/run' },
  quality: { hint: '合成与判断 · 4–6 次/run' },
};

function keyOf(entry: ChainDraft): string {
  return `${entry.providerId}:${entry.modelId}`;
}

function sameEntry(a: ChainDraft, b: ChainDraft): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

type SortableItemProps = {
  entry: ChainDraft;
  label: string;
  index: number;
  total: number;
  profile: Profile;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
};

function SortableItem({
  entry,
  label,
  index,
  total,
  profile,
  onMove,
  onRemove,
}: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: keyOf(entry),
  });

  const style: CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, transition }
    : { transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 py-1.5',
        isDragging && 'z-10 opacity-60 shadow-md',
      )}
    >
      <button
        type="button"
        aria-label={`拖动 ${label}`}
        className="cursor-grab touch-none text-faint focus-visible:outline-2 focus-visible:outline-accent"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" aria-hidden />
      </button>
      <span className="min-w-0 flex-1 truncate text-xs text-fg" title={label}>
        {label}
      </span>
      <button
        type="button"
        aria-label={`将 ${label} 上移`}
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
        className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-30"
      >
        <ArrowUp className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`将 ${label} 下移`}
        disabled={index === total - 1}
        onClick={() => onMove(index, index + 1)}
        className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-30"
      >
        <ArrowDown className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`从 ${profile} 链移除 ${label}`}
        onClick={() => onRemove(index)}
        className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-danger"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

type ChainColumnProps = {
  profile: Profile;
  items: ChainDraft[];
  labels: Map<string, string>;
  available: AvailableModel[];
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onAdd: (entry: ChainDraft) => void;
};

function ChainColumn({
  profile,
  items,
  labels,
  available,
  onMove,
  onRemove,
  onAdd,
}: ChainColumnProps) {
  const selectId = useId();
  const [choice, setChoice] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const remaining = available.filter((model) => !items.some((entry) => sameEntry(entry, model)));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((entry) => keyOf(entry) === active.id);
    const to = items.findIndex((entry) => keyOf(entry) === over.id);
    if (from < 0 || to < 0) return;
    onMove(from, to);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-xs font-semibold text-fg">{profile}</h3>
        <span className="text-[10.5px] text-muted">{PROFILE_COPY[profile].hint}</span>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-faint">
          还没有模型，从下方选择一个加入。
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map(keyOf)} strategy={verticalListSortingStrategy}>
            <ol aria-label={`${profile} 链`} className="flex flex-col gap-1.5">
              {items.map((entry, index) => {
                const key = keyOf(entry);
                return (
                  <SortableItem
                    key={key}
                    entry={entry}
                    label={labels.get(key) ?? `${entry.providerId} / ${entry.modelId}`}
                    index={index}
                    total={items.length}
                    profile={profile}
                    onMove={onMove}
                    onRemove={onRemove}
                  />
                );
              })}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          从可用模型添加到 {profile} 链
        </label>
        <select
          id={selectId}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          disabled={remaining.length === 0}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-xs text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        >
          <option value="">
            {remaining.length === 0 ? '没有可加入的模型' : '从可用模型添加…'}
          </option>
          {remaining.map((model) => (
            <option key={keyOf(model)} value={keyOf(model)}>
              {model.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="ghost"
          disabled={choice === ''}
          onClick={() => {
            const picked = remaining.find((model) => keyOf(model) === choice);
            if (!picked) return;
            onAdd({ providerId: picked.providerId, modelId: picked.modelId });
            setChoice('');
          }}
        >
          添加
        </Button>
      </div>
    </div>
  );
}

export function ChainEditor({ initialChains, providers, models }: ChainEditorProps) {
  const router = useRouter();
  const headingId = useId();
  const [chains, setChains] = useState<Record<Profile, ChainDraft[]>>(initialChains);
  // React's "adjust state when props change" pattern: a server refresh (after
  // save, or a model change) becomes the new source of truth without an effect.
  const [serverChains, setServerChains] = useState(initialChains);
  if (serverChains !== initialChains) {
    setServerChains(initialChains);
    setChains(initialChains);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerNames = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers],
  );

  const available = useMemo<AvailableModel[]>(() => {
    const enabled = new Set(providers.filter((provider) => provider.enabled).map((p) => p.id));
    return models
      .filter((model) => model.availableExternally && enabled.has(model.providerId))
      .map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        label: `${providerNames.get(model.providerId) ?? `#${model.providerId}`} / ${model.modelId}`,
      }));
  }, [models, providerNames, providers]);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of available) map.set(keyOf(model), model.label);
    // Items loaded from the database may name a provider that is now disabled;
    // keep a readable label for them instead of showing a bare id.
    for (const profile of ['bulk', 'quality'] as const) {
      for (const entry of initialChains[profile]) {
        const key = keyOf(entry);
        if (!map.has(key)) {
          map.set(
            key,
            `${providerNames.get(entry.providerId) ?? `#${entry.providerId}`} / ${entry.modelId}`,
          );
        }
      }
    }
    return map;
  }, [available, initialChains, providerNames]);

  const empty = chains.bulk.length === 0 || chains.quality.length === 0;

  function move(profile: Profile, from: number, to: number) {
    setChains((previous) => ({
      ...previous,
      [profile]: arrayMove(previous[profile], from, to),
    }));
  }

  function remove(profile: Profile, index: number) {
    setChains((previous) => ({
      ...previous,
      [profile]: previous[profile].filter((_, position) => position !== index),
    }));
  }

  function add(profile: Profile, entry: ChainDraft) {
    setChains((previous) => {
      if (previous[profile].some((existing) => sameEntry(existing, entry))) return previous;
      return { ...previous, [profile]: [...previous[profile], entry] };
    });
  }

  async function save() {
    if (empty) return;
    setError(null);
    setSaving(true);
    try {
      const result = await saveChainsAction({ bulk: chains.bulk, quality: chains.quality });
      if (!result.ok) {
        setError(result.message);
        toast.error(result.message);
        return;
      }
      toast.success('链路已保存，下一次 run 生效');
      router.refresh();
    } catch {
      setError('保存链路失败：网络错误');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-sm font-semibold text-fg">
            链
          </h2>
          <p className="mt-0.5 text-[11px] text-faint">
            拖动排序，或用上移/下移按钮；保存后下一次 run 生效
          </p>
        </div>
        <Button onClick={save} disabled={empty || saving}>
          {saving ? '保存中…' : '保存链'}
        </Button>
      </div>

      {empty ? (
        <p className="mb-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
          两条链都需要至少一个模型，才能保存。
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {(['bulk', 'quality'] as const).map((profile) => (
          <ChainColumn
            key={profile}
            profile={profile}
            items={chains[profile]}
            labels={labels}
            available={available}
            onMove={(from, to) => move(profile, from, to)}
            onRemove={(index) => remove(profile, index)}
            onAdd={(entry) => add(profile, entry)}
          />
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
