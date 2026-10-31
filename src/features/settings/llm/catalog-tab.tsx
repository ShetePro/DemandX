'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CATALOG_GROUPS,
  type CatalogGroup,
  type CatalogGroupFilter,
  type CatalogProvider,
  type CatalogSnapshot,
} from '@/lib/llm/catalog';
import type { ProviderKind } from '@/lib/llm/types';
import { cn } from '@/lib/utils/cn';

import { createFromCatalogAction, getCatalogAction } from './actions';
import type { ProviderFormDefaults } from './provider-form';

/** Typing pauses this long before the server action runs. */
const SEARCH_DEBOUNCE_MS = 200;

const GROUP_LABELS: Readonly<Record<CatalogGroup, string>> = {
  domestic: '国内',
  overseas: '海外',
  local: '本地',
};

const KIND_LABELS: Readonly<Record<ProviderKind, string>> = {
  'openai-compatible': 'OpenAI 兼容',
  'anthropic-compatible': 'Anthropic 兼容',
  google: 'Google',
  ollama: 'Ollama',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export type CatalogTabProps = {
  /** Keeps the manual form's defaults in sync with the current selection. */
  onPrefillChange?: (prefill: ProviderFormDefaults) => void;
  /** Jump to the manual tab, e.g. to edit fields this tab does not expose. */
  onRequestManual?: () => void;
  /** Called after a provider and its models were written. */
  onCreated?: () => void;
};

/**
 * Directory tab of the "add provider" dialog. Names, endpoints, env hints and
 * model ids come from models.dev; when that service is unreachable the built-in
 * presets are shown together with an explicit notice, never an error page.
 */
export function CatalogTab({ onPrefillChange, onRequestManual, onCreated }: CatalogTabProps) {
  const router = useRouter();
  const formId = useId();

  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<CatalogGroupFilter>('all');
  const [reloadToken, setReloadToken] = useState(0);
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<CatalogProvider | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadError(null);

      getCatalogAction(query, group)
        .then((result) => {
          if (cancelled) return;
          if (!result.ok) {
            setLoadError(result.message);
            return;
          }
          setSnapshot(result.value);
          setSelected((current) =>
            current !== null &&
            !result.value.providers.some((provider) => provider.id === current.id)
              ? null
              : current,
          );
        })
        .catch(() => {
          if (!cancelled) setLoadError('加载目录失败：网络错误');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, group, reloadToken]);

  function select(provider: CatalogProvider) {
    setSelected(provider);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey('');
    setSubmitError(null);
    onPrefillChange?.({ name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl });
  }

  function changeName(value: string) {
    setName(value);
    if (selected !== null) {
      onPrefillChange?.({ name: value, kind: selected.kind, baseUrl });
    }
  }

  function changeBaseUrl(value: string) {
    setBaseUrl(value);
    if (selected !== null) {
      onPrefillChange?.({ name, kind: selected.kind, baseUrl: value });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === null) return;

    const trimmedName = name.trim();
    const trimmedBaseUrl = baseUrl.trim();
    if (trimmedName === '') {
      setSubmitError('名称不能为空');
      return;
    }
    if (trimmedBaseUrl === '') {
      setSubmitError('Base URL 不能为空');
      return;
    }

    setSubmitError(null);
    setSubmitting(true);
    try {
      const trimmedKey = apiKey.trim();
      const result = await createFromCatalogAction({
        catalogId: selected.id,
        name: trimmedName,
        baseUrl: trimmedBaseUrl,
        ...(trimmedKey === '' ? {} : { apiKey: trimmedKey }),
      });

      if (!result.ok) {
        setSubmitError(result.message);
        toast.error(result.message);
        return;
      }

      toast.success(`已添加 ${result.value.provider.name}，带入 ${result.value.modelCount} 个模型`);
      router.push(`/settings/llm?provider=${result.value.provider.id}`);
      router.refresh();
      onCreated?.();
    } catch {
      setSubmitError('添加 provider 失败：网络错误');
    } finally {
      setSubmitting(false);
    }
  }

  const providers = snapshot?.providers ?? [];
  const modelCount = selected?.models.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor={`${formId}-search`} className="text-xs font-medium text-muted">
          搜索目录
        </label>
        <Input
          id={`${formId}-search`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="名称、baseURL 或环境变量，例如 deepseek"
          autoComplete="off"
        />
        <div role="group" aria-label="目录分组" className="flex flex-wrap gap-1">
          {CATALOG_GROUPS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={group === option.value ? 'primary' : 'ghost'}
              aria-pressed={group === option.value}
              onClick={() => setGroup(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {snapshot?.source === 'fallback' ? (
        <p
          role="status"
          className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning"
        >
          目录不可用，使用内置列表
        </p>
      ) : null}

      {loadError !== null ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger"
        >
          <span>加载目录失败：{loadError}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      ) : null}

      {loading ? (
        <p role="status" className="text-xs text-muted">
          加载目录中…
        </p>
      ) : providers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
          没有匹配的 provider。换个关键词，或切到“手动”自己填写。
        </p>
      ) : (
        <ul
          aria-label="目录 provider"
          className="flex max-h-64 flex-col gap-1.5 overflow-y-auto pr-1"
        >
          {providers.map((provider) => {
            const active = selected?.id === provider.id;
            return (
              <li key={provider.id}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => select(provider)}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
                    active
                      ? 'border-accent/60 bg-surface-2 ring-2 ring-accent-soft'
                      : 'border-border bg-surface hover:border-accent/40 hover:bg-surface-2',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge tone={provider.group === 'local' ? 'success' : 'accent'}>
                      {GROUP_LABELS[provider.group]}
                    </Badge>
                    <span className="truncate text-sm font-medium text-fg">{provider.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">
                      {provider.models.length} 个模型
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted" title={provider.baseUrl}>
                    {hostOf(provider.baseUrl)}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span>{provider.env === null ? '无需 key' : `Key：${provider.env}`}</span>
                    <Badge tone="success">已支持</Badge>
                    <span className="text-faint">{KIND_LABELS[provider.kind]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected !== null ? (
        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-surface-2 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-fg">添加 {selected.name}</p>
            {onRequestManual === undefined ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={onRequestManual}>
                在手动模式中编辑
              </Button>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-name`} className="text-xs font-medium text-muted">
              名称
            </label>
            <Input
              id={`${formId}-name`}
              value={name}
              onChange={(event) => changeName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-key`} className="text-xs font-medium text-muted">
              API Key（可选）
            </label>
            <Input
              id={`${formId}-key`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="本地 provider 可留空"
            />
            <p className="text-[11px] text-muted">
              {selected.env === null
                ? '该 provider 不需要 key。'
                : `环境变量：${selected.env}（可留空）`}
            </p>
            <p className="text-[11px] text-faint">Key 加密存储，页面上只显示掩码。</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${formId}-base-url`} className="text-xs font-medium text-muted">
              Base URL
            </label>
            <Input
              id={`${formId}-base-url`}
              value={baseUrl}
              onChange={(event) => changeBaseUrl(event.target.value)}
            />
          </div>

          {submitError !== null ? (
            <p role="alert" className="text-xs text-danger">
              {submitError}
            </p>
          ) : null}

          <div className="flex flex-col items-stretch gap-1">
            <Button type="submit" disabled={submitting}>
              {submitting
                ? '添加中…'
                : modelCount > 0
                  ? `添加并带入 ${modelCount} 个模型`
                  : '添加 provider'}
            </Button>
            {modelCount === 0 ? (
              <p className="text-[11px] text-faint">该目录项没有模型列表，可稍后拉取或手动添加。</p>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
