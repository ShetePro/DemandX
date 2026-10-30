import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PLAN } from '@/lib/validation/template';

import { PlanBoard } from './plan-board';

const mocks = vi.hoisted(() => ({
  toggleTaskAction: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  toggleTaskAction: mocks.toggleTaskAction,
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.error },
}));

const TASKS = DEFAULT_PLAN.map((item, index) => ({
  id: index + 1,
  day: item.day,
  title: item.title,
  done: false,
}));

const FIRST_TASK = TASKS[0];
if (!FIRST_TASK) throw new Error('DEFAULT_PLAN must not be empty');

beforeEach(() => {
  mocks.toggleTaskAction.mockReset();
  mocks.error.mockReset();
});

describe('PlanBoard', () => {
  it('renders 14 day groups and starts at zero progress', () => {
    render(<PlanBoard runId={7} tasks={TASKS} />);

    expect(screen.getByText('Day 1')).toBeVisible();
    expect(screen.getByText('Day 14')).toBeVisible();
    expect(screen.getAllByRole('checkbox')).toHaveLength(14);
    expect(screen.getByRole('progressbar', { name: '验证计划完成度' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
    expect(screen.getByText(/已完成/)).toHaveTextContent('已完成 0 / 14');
  });

  it('calls the action, checks the box and advances the progress bar', async () => {
    mocks.toggleTaskAction.mockResolvedValue({ ok: true, value: { id: 1, runId: 7, done: true } });
    const user = userEvent.setup();
    render(<PlanBoard runId={7} tasks={TASKS} />);

    const first = screen.getByRole('checkbox', { name: FIRST_TASK.title });
    await user.click(first);

    await waitFor(() => expect(mocks.toggleTaskAction).toHaveBeenCalledWith(1, true));
    expect(first).toBeChecked();
    expect(screen.getByText(/已完成/)).toHaveTextContent('已完成 1 / 14');
    expect(screen.getByRole('progressbar', { name: '验证计划完成度' })).toHaveAttribute(
      'aria-valuenow',
      '7',
    );
  });

  it('rolls the checkbox back when the action fails', async () => {
    mocks.toggleTaskAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '更新验证任务失败',
    });
    const user = userEvent.setup();
    render(<PlanBoard runId={7} tasks={TASKS} />);

    const first = screen.getByRole('checkbox', { name: FIRST_TASK.title });
    await user.click(first);

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('更新验证任务失败'));
    expect(first).not.toBeChecked();
    expect(screen.getByText(/已完成/)).toHaveTextContent('已完成 0 / 14');
    expect(screen.getByRole('progressbar', { name: '验证计划完成度' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });

  it('unchecks a completed task and rolls back a rejected uncheck', async () => {
    mocks.toggleTaskAction.mockResolvedValueOnce({
      ok: true,
      value: { id: 1, runId: 7, done: false },
    });
    const user = userEvent.setup();
    const done = [{ ...FIRST_TASK, done: true }, ...TASKS.slice(1)];
    render(<PlanBoard runId={7} tasks={done} />);

    const first = screen.getByRole('checkbox', { name: FIRST_TASK.title });
    expect(first).toBeChecked();
    await user.click(first);

    await waitFor(() => expect(mocks.toggleTaskAction).toHaveBeenCalledWith(1, false));
    expect(first).not.toBeChecked();
    expect(screen.getByText(/已完成/)).toHaveTextContent('已完成 0 / 14');
  });
});
