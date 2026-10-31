import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderRow } from '@/lib/llm/types';

import LlmSettingsPage from './page';

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  listProvidersAction: vi.fn(),
  getChainsForPage: vi.fn(),
  getModelsForPage: vi.fn(),
  getUsageAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

vi.mock('@/features/settings/llm/actions', () => ({
  listProvidersAction: mocks.listProvidersAction,
  getChainsForPage: mocks.getChainsForPage,
  getModelsForPage: mocks.getModelsForPage,
  getUsageAction: mocks.getUsageAction,
}));

// The page under test is the redirect/notice logic; the panels have their own
// suites and would only add their hooks here.
vi.mock('@/components/shell/settings-tabs', () => ({ SettingsTabs: () => null }));
vi.mock('@/features/settings/llm/provider-list', () => ({ ProviderList: () => null }));
vi.mock('@/features/settings/llm/provider-dialog', () => ({ ProviderDialog: () => null }));
vi.mock('@/features/settings/llm/provider-delete', () => ({ ProviderDelete: () => null }));
vi.mock('@/features/settings/llm/provider-form', () => ({ ProviderForm: () => null }));
vi.mock('@/features/settings/llm/usage-panel', () => ({ UsagePanel: () => null }));
vi.mock('@/features/settings/llm/test-button', () => ({ TestButton: () => null }));
vi.mock('@/features/settings/llm/model-chips', () => ({ ModelChips: () => null }));
vi.mock('@/features/settings/llm/chain-editor', () => ({ ChainEditor: () => null }));

const PROVIDER: ProviderRow = {
  id: 111,
  name: 'OpenCode Go',
  kind: 'openai-compatible',
  baseUrl: 'https://opencode.ai/inference/go',
  keyMask: 'sk-…abcd',
  headers: {},
  enabled: true,
  monthlyAllowanceUsd: null,
};

beforeEach(() => {
  mocks.redirect.mockClear();
  mocks.listProvidersAction.mockResolvedValue({ ok: true, value: [PROVIDER] });
  mocks.getChainsForPage.mockResolvedValue({
    ok: true,
    value: { bulk: [], quality: [] },
  });
  mocks.getModelsForPage.mockResolvedValue({ ok: true, value: [] });
  mocks.getUsageAction.mockResolvedValue({ ok: true, value: [] });
});

describe('LlmSettingsPage', () => {
  it('rewrites a stale provider id to the provider actually selected', async () => {
    await expect(
      LlmSettingsPage({ searchParams: Promise.resolve({ provider: '100' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/settings/llm?provider=111');
  });

  it('drops the query entirely when no provider exists to select', async () => {
    mocks.listProvidersAction.mockResolvedValue({ ok: true, value: [] });

    await expect(
      LlmSettingsPage({ searchParams: Promise.resolve({ provider: '100' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/settings/llm');
  });

  it('keeps a valid provider id and shows the empty-chain notice', async () => {
    render(await LlmSettingsPage({ searchParams: Promise.resolve({ provider: '111' }) }));

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      '还没有可用的模型链，聊天与研究无法调用模型',
    );
    expect(screen.getByRole('link', { name: '直接编辑链路' })).toHaveAttribute('href', '#chains');
  });

  it('hides the notice once either chain has an entry', async () => {
    mocks.getChainsForPage.mockResolvedValue({
      ok: true,
      value: {
        bulk: [
          {
            providerId: 111,
            providerName: 'OpenCode Go',
            kind: 'openai-compatible',
            baseUrl: 'https://opencode.ai/inference/go',
            headers: {},
            modelId: 'glm-5',
          },
        ],
        quality: [],
      },
    });

    render(await LlmSettingsPage({ searchParams: Promise.resolve({ provider: '111' }) }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
