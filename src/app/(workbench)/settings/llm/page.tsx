import { Pencil } from 'lucide-react';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/common/page-header';
import { SettingsTabs } from '@/components/shell/settings-tabs';
import { Button } from '@/components/ui/button';
import { ChainEditor, type ChainDraft } from '@/features/settings/llm/chain-editor';
import { ModelChips } from '@/features/settings/llm/model-chips';
import { ProviderDelete } from '@/features/settings/llm/provider-delete';
import { ProviderDialog } from '@/features/settings/llm/provider-dialog';
import { ProviderForm } from '@/features/settings/llm/provider-form';
import { ProviderList } from '@/features/settings/llm/provider-list';
import { TestButton } from '@/features/settings/llm/test-button';
import { UsagePanel } from '@/features/settings/llm/usage-panel';
import {
  getChainsForPage,
  getModelsForPage,
  getUsageAction,
  listProvidersAction,
} from '@/features/settings/llm/actions';
import type { Profile } from '@/lib/llm/port';
import type { ProviderUsageSummary, Result } from '@/lib/llm/types';

export const dynamic = 'force-dynamic';

const EMPTY_USAGE: ProviderUsageSummary = {
  providerId: 0,
  fiveHourRequests: 0,
  weeklyRequests: 0,
  monthlyRequests: 0,
  monthlySpendUsd: 0,
};

type SearchParams = Promise<{ provider?: string | string[] | undefined }>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function errorMessage(result: Result<unknown>): string | null {
  return result.ok ? null : result.message;
}

export default async function LlmSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const [providersResult, chainsResult, modelsResult, usageResult] = await Promise.all([
    listProvidersAction(),
    getChainsForPage(),
    getModelsForPage(),
    getUsageAction(),
  ]);

  // A failed read renders its message; it must never look like "no data yet".
  const errors = [
    errorMessage(providersResult),
    errorMessage(chainsResult),
    errorMessage(modelsResult),
    errorMessage(usageResult),
  ].filter((message): message is string => message !== null);

  const providers = providersResult.ok ? providersResult.value : [];
  const models = modelsResult.ok ? modelsResult.value : [];
  const usage = usageResult.ok ? usageResult.value : [];

  const requestedParam = firstParam((await searchParams).provider);
  const requestedId = requestedParam === undefined ? NaN : Number(requestedParam);
  const matchedProvider = providers.find((provider) => provider.id === requestedId) ?? null;
  const selectedProvider = matchedProvider ?? providers[0] ?? null;

  // A stale link (deleted provider, hand-edited id) must not leave a provider
  // in the address bar that the page is not actually showing.
  if (requestedParam !== undefined && matchedProvider === null) {
    redirect(
      selectedProvider === null ? '/settings/llm' : `/settings/llm?provider=${selectedProvider.id}`,
    );
  }

  const chains = chainsResult.ok ? chainsResult.value : { bulk: [], quality: [] };
  const initialChains: Record<Profile, ChainDraft[]> = {
    bulk: chains.bulk.map((item) => ({ providerId: item.providerId, modelId: item.modelId })),
    quality: chains.quality.map((item) => ({ providerId: item.providerId, modelId: item.modelId })),
  };
  const chainsEmpty = chains.bulk.length === 0 && chains.quality.length === 0;

  const modelCounts: Record<number, number> = {};
  for (const model of models) {
    modelCounts[model.providerId] = (modelCounts[model.providerId] ?? 0) + 1;
  }

  const selectedModels = selectedProvider
    ? models.filter((model) => model.providerId === selectedProvider.id)
    : [];
  const selectedUsage =
    selectedProvider === null
      ? EMPTY_USAGE
      : (usage.find((entry) => entry.providerId === selectedProvider.id) ?? {
          ...EMPTY_USAGE,
          providerId: selectedProvider.id,
        });

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <PageHeader
        title="LLM 与采集"
        description="模型链决定每次调用用哪个 provider；改动只影响下一次运行"
      />
      <SettingsTabs />

      {errors.length > 0 ? (
        <div
          role="alert"
          className="mb-4 flex flex-col gap-1 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <ProviderList
          providers={providers}
          selectedId={selectedProvider?.id ?? null}
          modelCounts={modelCounts}
        />

        <div className="flex min-w-0 flex-col gap-4">
          {selectedProvider ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-fg">
                    {selectedProvider.name}
                    {selectedProvider.enabled ? null : (
                      <span className="ml-2 text-[11px] text-muted">已停用</span>
                    )}
                  </h2>
                  <p
                    className="mt-0.5 truncate text-xs text-muted"
                    title={selectedProvider.baseUrl}
                  >
                    {selectedProvider.kind} · {selectedProvider.baseUrl}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {selectedProvider.keyMask ?? '未配置 key'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ProviderDialog
                    provider={selectedProvider}
                    trigger={
                      <Button variant="ghost" size="sm">
                        <Pencil className="size-3.5" aria-hidden />
                        编辑
                      </Button>
                    }
                  />
                  <ProviderDelete provider={selectedProvider} />
                </div>
              </div>

              {chainsEmpty ? (
                <div
                  role="status"
                  className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-xs text-warning"
                >
                  <p className="font-medium">还没有可用的模型链，聊天与研究无法调用模型</p>
                  <p className="mt-1">
                    用模型右侧的 + 加入，或
                    <a href="#chains" className="ml-1 underline underline-offset-2 hover:text-fg">
                      到下方批量编辑
                    </a>
                    。
                  </p>
                </div>
              ) : null}

              <ModelChips
                provider={selectedProvider}
                models={selectedModels}
                chains={initialChains}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <UsagePanel provider={selectedProvider} usage={selectedUsage} />
                <TestButton providerId={selectedProvider.id} providerName={selectedProvider.name} />
              </div>
            </>
          ) : (
            <section className="rounded-xl border border-border bg-surface p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-fg">新增 provider</h2>
              <p className="mt-0.5 mb-4 text-xs text-muted">
                还没有任何 endpoint。先添加 provider，再拉取模型、配置链路。
              </p>
              <ProviderForm />
            </section>
          )}

          <ChainEditor initialChains={initialChains} providers={providers} models={models} />
        </div>
      </div>
    </div>
  );
}
