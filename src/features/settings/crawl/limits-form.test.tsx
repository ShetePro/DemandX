import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CRAWL_SETTINGS } from '@/lib/settings/crawl-settings';

import { LimitsForm } from './limits-form';

const mocks = vi.hoisted(() => ({
  saveCrawlSettingsAction: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  saveCrawlSettingsAction: mocks.saveCrawlSettingsAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

function numberField(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

beforeEach(() => {
  mocks.saveCrawlSettingsAction.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe('LimitsForm', () => {
  it('shows a field error when the maximum delay is below the minimum', async () => {
    const user = userEvent.setup();
    render(<LimitsForm defaults={DEFAULT_CRAWL_SETTINGS} />);

    const min = numberField('最小间隔（ms）');
    await user.clear(min);
    await user.type(min, '9000');

    const max = numberField('最大间隔（ms）');
    await user.clear(max);
    await user.type(max, '5000');

    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText('最大间隔不能小于最小间隔')).toBeInTheDocument();
    expect(max).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.saveCrawlSettingsAction).not.toHaveBeenCalled();
  });

  it('saves the edited values and toasts on success', async () => {
    mocks.saveCrawlSettingsAction.mockResolvedValue({ ok: true, value: DEFAULT_CRAWL_SETTINGS });
    const user = userEvent.setup();
    render(<LimitsForm defaults={DEFAULT_CRAWL_SETTINGS} />);

    const pages = numberField('单次最多页数');
    await user.clear(pages);
    await user.type(pages, '50');

    await user.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(mocks.saveCrawlSettingsAction).toHaveBeenCalledTimes(1));
    expect(mocks.saveCrawlSettingsAction).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        respectRobots: true,
        perHostConcurrency: 1,
        minDelayMs: 3000,
        maxDelayMs: 8000,
        maxPagesPerRun: 50,
        deadlineMinutes: 90,
      }),
    );
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('已保存采集设置'));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('shows the server error and keeps the form editable', async () => {
    mocks.saveCrawlSettingsAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '写入设置失败',
    });
    const user = userEvent.setup();
    render(<LimitsForm defaults={DEFAULT_CRAWL_SETTINGS} />);

    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('写入设置失败');
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();
  });
});
