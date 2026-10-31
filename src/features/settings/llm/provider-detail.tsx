'use client';

import { useMemo, useState } from 'react';

import type { Profile } from '@/lib/llm/port';
import type { ProviderModelRow, ProviderRow, ProviderUsageSummary } from '@/lib/llm/types';

import { ChainEditor, type ChainDraft, type PendingModel } from './chain-editor';
import { ModelChips, type ChainMembership } from './model-chips';
import { TestButton } from './test-button';
import { UsagePanel } from './usage-panel';

export type ProviderDetailProps = {
  provider: ProviderRow;
  /** Models of this provider, shown as selectable chips. */
  models: ProviderModelRow[];
  usage: ProviderUsageSummary;
  initialChains: Record<Profile, ChainDraft[]>;
  /** Every provider, for the chain editor's model labels and availability. */
  providers: ProviderRow[];
  allModels: ProviderModelRow[];
};

function membershipOf(chains: Record<Profile, ChainDraft[]>): ChainMembership {
  const keyOf = (entry: ChainDraft) => `${entry.providerId}:${entry.modelId}`;
  return {
    bulk: new Set(chains.bulk.map(keyOf)),
    quality: new Set(chains.quality.map(keyOf)),
  };
}

/**
 * The model list selects; the chain editor below assigns the selection to a
 * profile. Both live in one client component so an unsaved membership update is
 * reflected in the chip badges without a round trip.
 */
export function ProviderDetail({
  provider,
  models,
  usage,
  initialChains,
  providers,
  allModels,
}: ProviderDetailProps) {
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [chains, setChains] = useState(initialChains);
  const [serverChains, setServerChains] = useState(initialChains);

  // A server refresh (after save) replaces the draft, matching ChainEditor.
  if (serverChains !== initialChains) {
    setServerChains(initialChains);
    setChains(initialChains);
  }

  const membership = useMemo(() => membershipOf(chains), [chains]);

  const selectedModel =
    selectedModelId === null
      ? null
      : (models.find((model) => model.modelId === selectedModelId) ?? null);

  const pendingModel: PendingModel | undefined = selectedModel
    ? {
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
        label: `${provider.name} / ${selectedModel.modelId}`,
      }
    : undefined;

  function toggleSelect(model: ProviderModelRow) {
    setSelectedModelId((previous) => (previous === model.modelId ? null : model.modelId));
  }

  return (
    <>
      <ModelChips
        provider={provider}
        models={models}
        membership={membership}
        selectedModelId={selectedModelId}
        onSelect={toggleSelect}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <UsagePanel provider={provider} usage={usage} />
        <TestButton providerId={provider.id} providerName={provider.name} />
      </div>

      <ChainEditor
        initialChains={initialChains}
        providers={providers}
        models={allModels}
        pendingModel={pendingModel}
        onChainsChange={setChains}
      />
    </>
  );
}
