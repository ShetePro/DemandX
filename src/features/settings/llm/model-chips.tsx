'use client';

import { Plus, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import type { Profile } from '@/lib/llm/port';
import type { ProviderModelRow, ProviderRow } from '@/lib/llm/types';

import { addModelAction, appendModelToChainAction, refreshModelsAction } from './actions';

export type ModelChipsProps = {
  provider: ProviderRow;
  models: ProviderModelRow[];
  /** Current membership, so a model already in a chain can be disabled there. */
  chains: Record<Profile, ReadonlyArray<{ providerId: number; modelId: string }>>;
};

/**
 * Cached model list for one provider. Refreshing asks the provider itself
 * (`/api/tags` or `/models`); the manual dialog covers vendors without a
 * discovery endpoint and models the listing omits.
 */
export function ModelChips({ provider, models, chains }: ModelChipsProps) {
  const router = useRouter();
  const formId = useId();

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [availableExternally, setAvailableExternally] = useState(true);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [appending, setAppending] = useState<string | null>(null);

  function inChain(profile: Profile, candidate: string): boolean {
    return chains[profile].some(
      (entry) => entry.providerId === provider.id && entry.modelId === candidate,
    );
  }

  async function addToChain(profile: Profile, candidate: string) {
    const key = `${profile}:${candidate}`;
    setAppending(key);
    try {
      const result = await appendModelToChainAction({
        profile,
        providerId: provider.id,
        modelId: candidate,
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setMenuFor(null);
      const position = `#${result.value.position + 1}`;
      toast.success(
        result.value.added ? `已加入 ${profile} 链 ${position}` : `已在 ${profile} 链 ${position}`,
      );
      router.refresh();
    } catch {
      toast.error('加入链路失败：网络错误');
    } finally {
      setAppending(null);
    }
  }

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      const result = await refreshModelsAction(provider.id);
      if (!result.ok) {
        setError(result.message);
        toast.error(result.message);
        return;
      }
      toast.success(`已拉取 ${result.value.length} 个模型`);
      router.refresh();
    } catch {
      setError('拉取模型失败：网络错误');
    } finally {
      setRefreshing(false);
    }
  }

  async function addModel() {
    const trimmed = modelId.trim();
    if (trimmed === '') {
      setAddError('modelId 不能为空');
      return;
    }

    setAddError(null);
    setAdding(true);
    try {
      const result = await addModelAction(provider.id, {
        modelId: trimmed,
        availableExternally,
      });
      if (!result.ok) {
        setAddError(result.message);
        toast.error(result.message);
        return;
      }
      toast.success(`已添加模型 ${trimmed}`);
      setModelId('');
      setAvailableExternally(true);
      setOpen(false);
      router.refresh();
    } catch {
      setAddError('添加模型失败：网络错误');
    } finally {
      setAdding(false);
    }
  }

  return (
    <section
      aria-labelledby={`${formId}-heading`}
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id={`${formId}-heading`} className="text-sm font-semibold text-fg">
            模型
          </h2>
          <p className="mt-0.5 text-[11px] text-faint">点 + 加入链路，或在下方批量编辑</p>
          <p className="mt-0.5 text-[11px] text-faint">虚线 = 仅官方客户端可用，不能加入链路</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
            {refreshing ? '拉取中…' : '拉取模型'}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Plus className="size-3.5" aria-hidden />
                手动添加
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>手动添加模型</DialogTitle>
                <DialogDescription>
                  适用于不提供模型列表的 provider，或列表里没有的模型。
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <label
                  htmlFor={`${formId}-model-id`}
                  className="flex flex-col gap-1.5 text-xs font-medium text-muted"
                >
                  模型 ID
                  <Input
                    id={`${formId}-model-id`}
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    placeholder="例如 qwen3:8b"
                    aria-invalid={addError ? true : undefined}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={availableExternally}
                    onChange={(event) => setAvailableExternally(event.target.checked)}
                  />
                  可被外部客户端调用（可加入链路）
                </label>
                {addError ? (
                  <p role="alert" className="text-xs text-danger">
                    {addError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button onClick={addModel} disabled={adding}>
                  {adding ? '添加中…' : '添加'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {models.length === 0 ? (
        <p className="text-xs text-muted">还没有模型。点“拉取模型”或“手动添加”。</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${provider.name} 的模型`}>
          {models.map((model) => {
            const external = model.availableExternally;
            const menuOpen = menuFor === model.modelId;
            return (
              <li key={model.modelId} className="relative flex items-center">
                <span
                  title={
                    external
                      ? (model.displayName ?? model.modelId)
                      : `仅官方客户端可用：${model.displayName ?? model.modelId}`
                  }
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                    external
                      ? 'border-border bg-surface-2 text-fg'
                      : 'border-dashed border-border-strong bg-transparent text-faint',
                    external && menuOpen && 'border-accent/60',
                  )}
                >
                  {model.modelId}
                  {external ? null : <span className="text-[10px] text-faint">仅官方客户端</span>}
                </span>
                {external ? (
                  <button
                    type="button"
                    aria-label={`把 ${model.modelId} 加入链`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={appending !== null}
                    onClick={() => setMenuFor(menuOpen ? null : model.modelId)}
                    className="ml-0.5 inline-flex size-5 items-center justify-center rounded-full border border-border bg-surface text-muted transition-colors hover:border-accent/60 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
                  >
                    <Plus className="size-3" aria-hidden />
                  </button>
                ) : null}
                {menuOpen ? (
                  <div
                    role="menu"
                    aria-label={`把 ${model.modelId} 加入链`}
                    tabIndex={-1}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setMenuFor(null);
                    }}
                    className="absolute top-full left-0 z-20 mt-1 flex min-w-[150px] flex-col gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-md"
                  >
                    {(['bulk', 'quality'] as const).map((profile) => {
                      const member = inChain(profile, model.modelId);
                      const busy = appending === `${profile}:${model.modelId}`;
                      return (
                        <button
                          key={profile}
                          type="button"
                          role="menuitem"
                          aria-label={`把 ${model.modelId} 加入 ${profile} 链`}
                          disabled={member || appending !== null}
                          onClick={() => addToChain(profile, model.modelId)}
                          className="rounded px-2 py-1 text-left text-[11px] text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
                        >
                          {member ? `已在 ${profile} 链` : busy ? '加入中…' : `加入 ${profile}`}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
