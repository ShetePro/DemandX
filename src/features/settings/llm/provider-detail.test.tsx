import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModelRow, ProviderRow, ProviderUsageSummary } from '@/lib/llm/types';

import { ProviderDetail } from './provider-detail';

const mocks = vi.hoisted(() => ({
  addModelAction: vi.fn(),
  refreshModelsAction: vi.fn(),
  saveChainsAction: vi.fn(),
  testProviderAction: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  addModelAction: mocks.addModelAction,
  refreshModelsAction: mocks.refreshModelsAction,
  saveChainsAction: mocks.saveChainsAction,
  testProviderAction: mocks.testProviderAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const PROVIDER: ProviderRow = {
  id: 1,
  name: '本地 Ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  keyMask: null,
  headers: {},
  enabled: true,
  monthlyAllowanceUsd: null,
};

const MODEL: ProviderModelRow = {
  providerId: PROVIDER.id,
  modelId: 'qwen3:8b',
  displayName: null,
  availableExternally: true,
  source: 'ollama',
};

const OTHER_MODEL: ProviderModelRow = {
  providerId: PROVIDER.id,
  modelId: 'glm-5.3',
  displayName: null,
  availableExternally: true,
  source: 'ollama',
};

const MODELS = [MODEL, OTHER_MODEL];

const USAGE: ProviderUsageSummary = {
  providerId: PROVIDER.id,
  fiveHourRequests: 0,
  weeklyRequests: 0,
  monthlyRequests: 0,
  monthlySpendUsd: 0,
};

const INITIAL_CHAINS = {
  bulk: [{ providerId: PROVIDER.id, modelId: MODEL.modelId }],
  quality: [{ providerId: PROVIDER.id, modelId: MODEL.modelId }],
};

function renderDetail() {
  return render(
    <ProviderDetail
      provider={PROVIDER}
      models={MODELS}
      usage={USAGE}
      initialChains={INITIAL_CHAINS}
      providers={[PROVIDER]}
      allModels={MODELS}
    />,
  );
}

function qualityList(): HTMLElement {
  return screen.getByRole('list', { name: 'quality 链' });
}

beforeEach(() => {
  mocks.addModelAction.mockReset();
  mocks.refreshModelsAction.mockReset();
  mocks.saveChainsAction.mockReset();
  mocks.testProviderAction.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe('ProviderDetail', () => {
  it('shows no chain-assignment toolbar before a model is selected', () => {
    renderDetail();

    expect(screen.queryByRole('group', { name: '已选中的模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加入 quality' })).not.toBeInTheDocument();
  });

  it('assigns the selected model to quality and updates the chip badge', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'glm-5.3' }));

    expect(screen.getByRole('group', { name: '已选中的模型' })).toBeInTheDocument();
    expect(screen.getByText('已选中 本地 Ollama / glm-5.3')).toBeInTheDocument();

    const chip = screen.getByRole('button', { name: 'glm-5.3' });
    expect(chip).not.toHaveTextContent('Q');

    await user.click(screen.getByRole('button', { name: '加入 quality' }));

    expect(within(qualityList()).getByText('本地 Ollama / glm-5.3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已在 quality' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '加入 quality' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'glm-5.3' })).toHaveTextContent('Q');

    // bulk is untouched: adding nicer models to quality must not spend bulk calls.
    expect(screen.getByRole('button', { name: '加入 bulk' })).toBeEnabled();
  });

  it('adds the pending model from the toolbar to bulk as well', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'glm-5.3' }));
    await user.click(screen.getByRole('button', { name: '加入 bulk' }));

    expect(
      within(screen.getByRole('list', { name: 'bulk 链' })).getByText('本地 Ollama / glm-5.3'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已在 bulk' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'glm-5.3' })).toHaveTextContent('B');
  });
});
