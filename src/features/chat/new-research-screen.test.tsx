import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewResearchScreen } from './new-research-screen';

const mocks = vi.hoisted(() => ({
  startResearchAction: vi.fn(),
  push: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({ startResearchAction: mocks.startResearchAction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: vi.fn() } }));

function suggestionChips(): HTMLElement[] {
  return within(screen.getByRole('list', { name: '推荐方向' })).getAllByRole('button');
}

function textbox(): HTMLElement {
  return screen.getByRole('textbox', { name: '输入消息' });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NewResearchScreen', () => {
  it('centres the composer and shows six recommendation chips initially', () => {
    render(<NewResearchScreen recentIdeas={[]} />);

    expect(screen.getByRole('heading', { name: '先描述一个问题' })).toBeVisible();
    expect(screen.getByText('推荐方向')).toBeVisible();
    expect(screen.getByRole('region', { name: '新建研究' })).toHaveClass('justify-center');
    expect(screen.getByRole('group', { name: '研究输入' })).toHaveAttribute(
      'data-docking',
      'false',
    );

    const chips = suggestionChips();
    expect(chips).toHaveLength(6);
    expect(chips.map((chip) => chip.textContent)).toContain('跨境库存同步');
  });

  it('keeps only matching suggestions once the debounce has elapsed', () => {
    render(<NewResearchScreen recentIdeas={[]} />);

    fireEvent.change(textbox(), { target: { value: '发票' } });
    // Still inside the 150ms debounce: the previous page is shown.
    expect(suggestionChips()).toHaveLength(6);

    act(() => {
      vi.advanceTimersByTime(150);
    });

    const chips = suggestionChips();
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('发票');
  });

  it('fills the composer with the full idea when a chip is picked', () => {
    render(<NewResearchScreen recentIdeas={[]} />);

    fireEvent.click(
      within(screen.getByRole('list', { name: '推荐方向' })).getByRole('button', {
        name: '小团队发票与报销',
      }),
    );

    expect(textbox()).toHaveValue('小团队用表格管理发票和报销，月底对账总要熬夜');
  });

  it('cycles to the next batch when 换一批 is pressed', () => {
    render(<NewResearchScreen recentIdeas={[]} />);

    const first = suggestionChips().map((chip) => chip.textContent);
    fireEvent.click(screen.getByRole('button', { name: '换一批' }));
    const second = suggestionChips().map((chip) => chip.textContent);

    expect(second).not.toEqual(first);
    expect(second).toHaveLength(6);
  });

  it('creates the research, docks, then navigates after the animation delay', async () => {
    mocks.startResearchAction.mockResolvedValue({
      ok: true,
      value: { ideaId: 3, threadId: 7, runId: 9 },
    });

    render(<NewResearchScreen recentIdeas={[]} />);
    fireEvent.change(textbox(), { target: { value: '跨境卖家库存同步太麻烦' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await Promise.resolve();
    });

    expect(mocks.startResearchAction).toHaveBeenCalledWith({ idea: '跨境卖家库存同步太麻烦' });
    expect(screen.getByRole('group', { name: '研究输入' })).toHaveAttribute('data-docking', 'true');

    act(() => {
      vi.advanceTimersByTime(419);
    });
    expect(mocks.push).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.push).toHaveBeenCalledWith('/threads/7');
  });

  it('stays idle and reports the failure without navigating', async () => {
    mocks.startResearchAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '创建研究失败 (SQLSTATE 08006)',
    });

    render(<NewResearchScreen recentIdeas={[]} />);
    fireEvent.change(textbox(), { target: { value: '跨境卖家库存同步太麻烦' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await Promise.resolve();
    });

    expect(mocks.error).toHaveBeenCalledWith('创建研究失败 (SQLSTATE 08006)');
    expect(screen.getByRole('group', { name: '研究输入' })).toHaveAttribute(
      'data-docking',
      'false',
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('adds recent pitches after the built-in directions without duplicating them', () => {
    render(
      <NewResearchScreen
        recentIdeas={['跨境卖家在多个平台之间手工同步库存，旺季经常超卖', '帮社区小店做进销存']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '换一批' }));

    const chips = suggestionChips().map((chip) => chip.textContent);
    expect(chips).toContain('帮社区小店做进销存');
    expect(chips.filter((chip) => chip === '跨境库存同步')).toHaveLength(1);
  });
});
