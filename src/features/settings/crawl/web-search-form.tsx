'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WEB_SEARCH_PROVIDERS } from '@/lib/search/port';
import type { WebSearchSettings } from '@/lib/settings/web-search-settings';

import {
  clearWebSearchKeyAction,
  saveWebSearchSettingsAction,
  testWebSearchAction,
  type WebSearchStatus,
} from './web-search-actions';

const PROVIDER_LABELS: Readonly<Record<(typeof WEB_SEARCH_PROVIDERS)[number], string>> = {
  tavily: 'Tavily',
  brave: 'Brave Search API',
  serper: 'Serper (Google)',
};

export interface WebSearchFormProps {
  status: WebSearchStatus;
}

/**
 * Fallback search for runs where no social-platform session exists. The key
 * never round-trips to the browser: the field starts empty and leaving it empty
 * keeps the stored value.
 */
export function WebSearchForm({ status }: WebSearchFormProps) {
  const router = useRouter();
  const id = useId();
  const [enabled, setEnabled] = useState(status.settings.enabled);
  const [provider, setProvider] = useState(status.settings.provider);
  const [maxResults, setMaxResults] = useState(String(status.settings.maxResults));
  const [apiKey, setApiKey] = useState('');
  const [keyHint, setKeyHint] = useState(status.keyHint);
  const [pending, setPending] = useState<'save' | 'test' | 'clear' | null>(null);

  async function save(): Promise<void> {
    setPending('save');
    try {
      const result = await saveWebSearchSettingsAction({
        enabled,
        provider,
        maxResults: Number(maxResults),
        ...(apiKey.trim() === '' ? {} : { apiKey }),
      });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setKeyHint(result.value.keyHint);
      setApiKey('');
      toast.success('兜底搜索已保存');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function test(): Promise<void> {
    setPending('test');
    try {
      const result = await testWebSearchAction();
      if (!result.ok) toast.error(result.message);
      else toast.success(`${result.value.provider} 可用，返回 ${result.value.hits} 条结果`);
    } finally {
      setPending(null);
    }
  }

  async function clear(): Promise<void> {
    setPending('clear');
    try {
      const result = await clearWebSearchKeyAction();
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setEnabled(false);
      setKeyHint(null);
      setApiKey('');
      toast.success('已清除搜索密钥并关闭兜底');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-heading`} className="text-sm font-semibold text-fg">
          兜底搜索
        </h2>
        <p className="text-xs leading-relaxed text-muted">
          国内外社交平台的会话不可用时，用网页搜索接口补齐证据。仅在平台适配器没有返回结果时调用。
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="size-4 rounded border-border accent-accent"
        />
        启用兜底搜索
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${id}-provider`} className="flex flex-col gap-1 text-xs text-muted">
          服务商
          <select
            id={`${id}-provider`}
            value={provider}
            onChange={(event) => {
              const next = event.target.value;
              if (WEB_SEARCH_PROVIDERS.includes(next as never)) {
                setProvider(next as WebSearchSettings['provider']);
              }
            }}
            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-fg"
          >
            {WEB_SEARCH_PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {PROVIDER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor={`${id}-results`} className="flex flex-col gap-1 text-xs text-muted">
          每次查询结果数
          <Input
            id={`${id}-results`}
            type="number"
            min={3}
            max={10}
            value={maxResults}
            onChange={(event) => setMaxResults(event.target.value)}
          />
        </label>
      </div>

      <label htmlFor={`${id}-key`} className="flex flex-col gap-1 text-xs text-muted">
        API Key
        <Input
          id={`${id}-key`}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            keyHint === null ? '粘贴服务商的 API Key' : `已保存：${keyHint}（留空保持不变）`
          }
          autoComplete="off"
        />
      </label>

      <p className="text-xs text-faint">
        {status.configured
          ? '当前配置可用。保存后可点「测试连接」发起一次真实查询。'
          : '当前没有可用密钥；可在此填写，或在环境变量 WEB_SEARCH_API_KEY 中配置。'}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void save()} disabled={pending !== null}>
          {pending === 'save' ? '保存中…' : '保存'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void test()}
          disabled={pending !== null}
        >
          {pending === 'test' ? '测试中…' : '测试连接'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void clear()}
          disabled={pending !== null || keyHint === null}
        >
          清除密钥
        </Button>
      </div>
    </section>
  );
}
