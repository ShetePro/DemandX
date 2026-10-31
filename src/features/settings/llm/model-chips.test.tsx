import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModelRow, ProviderRow } from '@/lib/llm/types';

import { ModelChips } from './model-chips';

const mocks = vi.hoisted(() => ({
  addModelAction: vi.fn(),
  appendModelToChainAction: vi.fn(),
  refreshModelsAction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  addModelAction: mocks.addModelAction,
  appendModelToChainAction: mocks.appendModelToChainAction,
  refreshModelsAction: mocks.refreshModelsAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const PROVIDER: ProviderRow = {
  id: 3,
  name: '本地 Ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  keyMask: null,
  headers: {},
  enabled: true,
  monthlyAllowanceUsd: null,
};

const MODELS: ProviderModelRow[] = [
  {
    providerId: PROVIDER.id,
    modelId: 'qwen3:8b',
    displayName: null,
    availableExternally: true,
    source: 'manual',
  },
  {
    providerId: PROVIDER.id,
    modelId: 'console-only',
    displayName: null,
    availableExternally: false,
    source: 'manual',
  },
];

const EMPTY_CHAINS = { bulk: [], quality: [] };

beforeEach(() => {
  mocks.addModelAction.mockReset();
  mocks.appendModelToChainAction.mockReset();
  mocks.refreshModelsAction.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe('ModelChips', () => {
  it('adds a model manually with the chosen external-call flag', async () => {
    const user = userEvent.setup();
    mocks.addModelAction.mockResolvedValue({
      ok: true,
      value: {
        providerId: PROVIDER.id,
        modelId: 'qwen3:8b',
        displayName: null,
        availableExternally: false,
        source: 'manual',
      },
    });

    render(<ModelChips provider={PROVIDER} models={[]} chains={EMPTY_CHAINS} />);

    await user.click(screen.getByRole('button', { name: '手动添加' }));
    await user.type(await screen.findByLabelText('模型 ID'), 'qwen3:8b');
    await user.click(screen.getByLabelText('可被外部客户端调用（可加入链路）'));
    await user.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(mocks.addModelAction).toHaveBeenCalledTimes(1));
    expect(mocks.addModelAction).toHaveBeenCalledWith(PROVIDER.id, {
      modelId: 'qwen3:8b',
      availableExternally: false,
    });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it('opens the chain menu from the + button', async () => {
    const user = userEvent.setup();
    render(<ModelChips provider={PROVIDER} models={MODELS} chains={EMPTY_CHAINS} />);

    // Only externally callable models get the shortcut.
    expect(
      screen.queryByRole('button', { name: '把 console-only 加入链' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '把 qwen3:8b 加入链' }));

    const menu = screen.getByRole('menu', { name: '把 qwen3:8b 加入链' });
    expect(menu).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '把 qwen3:8b 加入 bulk 链' })).toHaveTextContent(
      '加入 bulk',
    );
    expect(screen.getByRole('menuitem', { name: '把 qwen3:8b 加入 quality 链' })).toHaveTextContent(
      '加入 quality',
    );
  });

  it('appends to the chosen chain and reports the position', async () => {
    const user = userEvent.setup();
    mocks.appendModelToChainAction.mockResolvedValue({
      ok: true,
      value: { added: true, position: 1 },
    });

    render(<ModelChips provider={PROVIDER} models={MODELS} chains={EMPTY_CHAINS} />);

    await user.click(screen.getByRole('button', { name: '把 qwen3:8b 加入链' }));
    await user.click(screen.getByRole('menuitem', { name: '把 qwen3:8b 加入 quality 链' }));

    await waitFor(() => expect(mocks.appendModelToChainAction).toHaveBeenCalledTimes(1));
    expect(mocks.appendModelToChainAction).toHaveBeenCalledWith({
      profile: 'quality',
      providerId: PROVIDER.id,
      modelId: 'qwen3:8b',
    });
    expect(mocks.success).toHaveBeenCalledWith('已加入 quality 链 #2');
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('disables the profile a model already belongs to', async () => {
    const user = userEvent.setup();
    render(
      <ModelChips
        provider={PROVIDER}
        models={MODELS}
        chains={{ bulk: [], quality: [{ providerId: PROVIDER.id, modelId: 'qwen3:8b' }] }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '把 qwen3:8b 加入链' }));

    const quality = screen.getByRole('menuitem', { name: '把 qwen3:8b 加入 quality 链' });
    expect(quality).toBeDisabled();
    expect(quality).toHaveTextContent('已在 quality 链');
    expect(screen.getByRole('menuitem', { name: '把 qwen3:8b 加入 bulk 链' })).toBeEnabled();
  });
});
