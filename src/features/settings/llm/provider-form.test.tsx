import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderRow } from '@/lib/llm/types';

import { ProviderForm } from './provider-form';

const mocks = vi.hoisted(() => ({
  createProviderAction: vi.fn(),
  updateProviderAction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  createProviderAction: mocks.createProviderAction,
  updateProviderAction: mocks.updateProviderAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const PROVIDER: ProviderRow = {
  id: 7,
  name: 'OpenCode',
  kind: 'openai-compatible',
  baseUrl: 'https://opencode.ai/inference/go',
  keyMask: 'sk-…9f2c',
  headers: {},
  enabled: true,
  monthlyAllowanceUsd: 80,
};

const PAYG_URL = 'https://opencode.ai/inference';

beforeEach(() => {
  mocks.createProviderAction.mockReset();
  mocks.updateProviderAction.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe('ProviderForm', () => {
  it('reports a field error when the name is empty', async () => {
    const user = userEvent.setup();
    render(<ProviderForm />);

    await user.type(screen.getByLabelText('Base URL'), 'https://example.com/v1');
    await user.click(screen.getByRole('button', { name: '添加 provider' }));

    // The zod message lands on the field and at the top of the form.
    expect((await screen.findAllByText('名称不能为空')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('名称')).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.createProviderAction).not.toHaveBeenCalled();
  });

  it('refuses a metered endpoint until the acknowledgement is ticked', async () => {
    const user = userEvent.setup();
    render(<ProviderForm />);

    await user.type(screen.getByLabelText('名称'), 'Metered');
    await user.type(screen.getByLabelText('Base URL'), PAYG_URL);
    await user.click(screen.getByRole('button', { name: '添加 provider' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('按量计费');
    expect(screen.getByLabelText('我知道这是按量计费')).toBeInTheDocument();
    expect(mocks.createProviderAction).not.toHaveBeenCalled();
  });

  it('submits once the metered endpoint is acknowledged', async () => {
    const user = userEvent.setup();
    mocks.createProviderAction.mockResolvedValue({ ok: true, value: PROVIDER });

    render(<ProviderForm />);

    await user.type(screen.getByLabelText('名称'), 'Metered');
    await user.type(screen.getByLabelText('Base URL'), PAYG_URL);
    await user.click(screen.getByLabelText('我知道这是按量计费'));
    await user.click(screen.getByRole('button', { name: '添加 provider' }));

    await waitFor(() => expect(mocks.createProviderAction).toHaveBeenCalledTimes(1));
    expect(mocks.createProviderAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Metered',
        baseUrl: PAYG_URL,
        acknowledgePayg: true,
      }),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(`/settings/llm?provider=${PROVIDER.id}`),
    );
    expect(mocks.success).toHaveBeenCalled();
  });

  it('rejects headers that are not a JSON object of strings', async () => {
    const user = userEvent.setup();
    render(<ProviderForm />);

    await user.type(screen.getByLabelText('名称'), 'Local');
    await user.type(screen.getByLabelText('Base URL'), 'http://127.0.0.1:11434');
    await user.type(screen.getByLabelText(/Headers/), '{{oops');
    await user.click(screen.getByRole('button', { name: '添加 provider' }));

    expect((await screen.findAllByText('headers 必须是合法的 JSON 对象')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByLabelText(/Headers/)).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.createProviderAction).not.toHaveBeenCalled();
  });

  it('keeps an empty key as "unchanged" when editing', async () => {
    const user = userEvent.setup();
    mocks.updateProviderAction.mockResolvedValue({ ok: true, value: PROVIDER });

    render(<ProviderForm provider={PROVIDER} />);

    await user.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(mocks.updateProviderAction).toHaveBeenCalledTimes(1));
    expect(mocks.updateProviderAction).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ apiKey: '', acknowledgePayg: false }),
    );
  });
});
