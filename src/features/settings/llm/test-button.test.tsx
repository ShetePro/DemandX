import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionTestResult } from '@/lib/llm/connection';

import { TestButton } from './test-button';

const mocks = vi.hoisted(() => ({
  testProviderAction: vi.fn(),
}));

vi.mock('./actions', () => ({
  testProviderAction: mocks.testProviderAction,
}));

beforeEach(() => {
  mocks.testProviderAction.mockReset();
});

describe('TestButton', () => {
  it('shows the probe result after a successful test', async () => {
    const user = userEvent.setup();
    let resolveProbe!: (result: ConnectionTestResult) => void;
    mocks.testProviderAction.mockImplementation(
      () =>
        new Promise<ConnectionTestResult>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    render(<TestButton providerId={1} providerName="本地 Ollama" />);

    await user.click(screen.getByRole('button', { name: '测试 本地 Ollama' }));

    expect(screen.getByRole('button', { name: '测试中…' })).toBeDisabled();
    expect(mocks.testProviderAction).toHaveBeenCalledWith(1);

    await act(async () => {
      resolveProbe({ ok: true, value: { latencyMs: 812, model: 'qwen3:8b', status: 200 } });
    });

    expect(await screen.findByRole('status')).toHaveTextContent('200 · 812 ms · qwen3:8b');
  });

  it('renders a failure verbatim, including the HTTP status', async () => {
    const user = userEvent.setup();
    mocks.testProviderAction.mockResolvedValue({
      ok: false,
      code: 'LLM_UNAVAILABLE',
      message: '连接失败：HTTP 401',
      status: 401,
    });

    render(<TestButton providerId={2} providerName="OpenCode" />);

    await user.click(screen.getByRole('button', { name: '测试 OpenCode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/^连接失败：HTTP 401$/);
  });

  it('reports a deleted provider with a refresh hint', async () => {
    const user = userEvent.setup();
    mocks.testProviderAction.mockResolvedValue({
      ok: false,
      code: 'PROVIDER_NOT_FOUND',
      message: 'provider 100 不存在',
      status: 0,
    });

    render(<TestButton providerId={100} providerName="OpenCode" />);

    await user.click(screen.getByRole('button', { name: '测试 OpenCode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('provider 已不存在，请刷新页面');
  });

  it('clears a stale result when the selected provider changes', async () => {
    const user = userEvent.setup();
    mocks.testProviderAction.mockResolvedValue({
      ok: false,
      code: 'PROVIDER_NOT_FOUND',
      message: 'provider 100 不存在',
      status: 0,
    });

    const { rerender } = render(<TestButton providerId={100} providerName="OpenCode" />);

    await user.click(screen.getByRole('button', { name: '测试 OpenCode' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('provider 已不存在，请刷新页面');

    rerender(<TestButton providerId={111} providerName="OpenCode Go" />);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mocks.testProviderAction).toHaveBeenCalledTimes(1);
  });
});
