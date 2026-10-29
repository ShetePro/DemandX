import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderRow } from '@/lib/llm/types';

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

    render(<ModelChips provider={PROVIDER} models={[]} />);

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
});
