import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModelRow, ProviderRow } from '@/lib/llm/types';

import { ChainEditor } from './chain-editor';

const mocks = vi.hoisted(() => ({
  saveChainsAction: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  saveChainsAction: mocks.saveChainsAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const PROVIDERS: ProviderRow[] = [
  {
    id: 1,
    name: '本地 Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    keyMask: null,
    headers: {},
    enabled: true,
    monthlyAllowanceUsd: null,
  },
];

const MODELS: ProviderModelRow[] = [
  {
    providerId: 1,
    modelId: 'qwen3:8b',
    displayName: null,
    availableExternally: true,
    source: 'ollama',
  },
  {
    providerId: 1,
    modelId: 'qwen3:14b',
    displayName: null,
    availableExternally: true,
    source: 'ollama',
  },
  {
    providerId: 1,
    modelId: 'glm-5.3',
    displayName: null,
    availableExternally: true,
    source: 'ollama',
  },
];

const LABEL = {
  small: '本地 Ollama / qwen3:8b',
  medium: '本地 Ollama / qwen3:14b',
  large: '本地 Ollama / glm-5.3',
};

const INITIAL = {
  bulk: [
    { providerId: 1, modelId: 'qwen3:8b' },
    { providerId: 1, modelId: 'qwen3:14b' },
    { providerId: 1, modelId: 'glm-5.3' },
  ],
  quality: [{ providerId: 1, modelId: 'qwen3:14b' }],
};

function bulkList(): HTMLElement {
  return screen.getByRole('list', { name: 'bulk 链' });
}

beforeEach(() => {
  mocks.saveChainsAction.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe('ChainEditor', () => {
  it('removes one entry from a chain', async () => {
    const user = userEvent.setup();
    render(<ChainEditor initialChains={INITIAL} providers={PROVIDERS} models={MODELS} />);

    await user.click(screen.getByRole('button', { name: `从 bulk 链移除 ${LABEL.medium}` }));

    expect(within(bulkList()).queryByText(LABEL.medium)).not.toBeInTheDocument();
    expect(within(bulkList()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('moves an entry up with the keyboard-accessible button', async () => {
    const user = userEvent.setup();
    render(<ChainEditor initialChains={INITIAL} providers={PROVIDERS} models={MODELS} />);

    await user.click(within(bulkList()).getByRole('button', { name: `将 ${LABEL.medium} 上移` }));

    const items = within(bulkList()).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('qwen3:14b');
    expect(items[1]).toHaveTextContent('qwen3:8b');
    expect(items[2]).toHaveTextContent('glm-5.3');

    mocks.saveChainsAction.mockResolvedValue({ ok: true, value: undefined });
    await user.click(screen.getByRole('button', { name: '保存链' }));

    await waitFor(() => expect(mocks.saveChainsAction).toHaveBeenCalledTimes(1));
    expect(mocks.saveChainsAction).toHaveBeenCalledWith({
      bulk: [
        { providerId: 1, modelId: 'qwen3:14b' },
        { providerId: 1, modelId: 'qwen3:8b' },
        { providerId: 1, modelId: 'glm-5.3' },
      ],
      quality: [{ providerId: 1, modelId: 'qwen3:14b' }],
    });
  });

  it('disables saving while either chain is empty', () => {
    render(
      <ChainEditor
        initialChains={{ bulk: INITIAL.bulk, quality: [] }}
        providers={PROVIDERS}
        models={MODELS}
      />,
    );

    expect(screen.getByRole('button', { name: '保存链' })).toBeDisabled();
    expect(screen.getByText('两条链都需要至少一个模型，才能保存。')).toBeInTheDocument();
  });

  it('adds a model from the available list', async () => {
    const user = userEvent.setup();
    render(<ChainEditor initialChains={INITIAL} providers={PROVIDERS} models={MODELS} />);

    const choice = screen.getByLabelText('从可用模型添加到 quality 链');
    await user.selectOptions(choice, within(choice).getByRole('option', { name: LABEL.large }));
    await user.click(
      within(choice.parentElement as HTMLElement).getByRole('button', { name: '添加' }),
    );

    const quality = screen.getByRole('list', { name: 'quality 链' });
    expect(within(quality).getByText(LABEL.large)).toBeInTheDocument();
  });
});
