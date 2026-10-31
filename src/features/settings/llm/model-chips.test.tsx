import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderModelRow, ProviderRow } from '@/lib/llm/types';

import { ModelChips } from './model-chips';

const mocks = vi.hoisted(() => ({
  addModelAction: vi.fn(),
  refreshModelsAction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  addModelAction: mocks.addModelAction,
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

const MEMBERSHIP = {
  bulk: new Set([`${PROVIDER.id}:qwen3:8b`]),
  quality: new Set<string>(),
};

/** Mirrors how ProviderDetail owns the selection. */
function Harness({ onSelect }: { onSelect?: (model: ProviderModelRow) => void }) {
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  return (
    <ModelChips
      provider={PROVIDER}
      models={MODELS}
      membership={MEMBERSHIP}
      selectedModelId={selectedModelId}
      onSelect={(model) => {
        onSelect?.(model);
        setSelectedModelId((previous) => (previous === model.modelId ? null : model.modelId));
      }}
    />
  );
}

beforeEach(() => {
  mocks.addModelAction.mockReset();
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

    render(<Harness />);

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

  it('selects a model and deselects it when clicked again', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSelect={onSelect} />);

    const chip = screen.getByRole('button', { name: 'qwen3:8b' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip);

    expect(onSelect).toHaveBeenCalledWith(MODELS[0]);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveClass('border-accent', 'bg-accent-soft', 'text-accent');

    await user.click(chip);

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the bulk/quality membership badges', () => {
    render(<Harness />);

    expect(screen.getByRole('button', { name: 'qwen3:8b' })).toHaveTextContent('B');
    expect(screen.getByRole('button', { name: 'qwen3:8b' })).not.toHaveTextContent('Q');
  });

  it('cannot select a model that only the vendor client can call', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSelect={onSelect} />);

    const chip = screen.getByRole('button', { name: /console-only/ });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveClass('border-dashed');
    expect(chip).toHaveTextContent('仅官方客户端');

    await user.click(chip);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('has no shortcut button that adds a model to a chain', () => {
    render(<Harness />);

    expect(screen.queryByRole('button', { name: /加入链/ })).not.toBeInTheDocument();
  });
});
