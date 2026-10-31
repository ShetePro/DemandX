import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { mockMediaQuery } from '@/test/setup-dom';

import { NewResearchScreen } from './new-research-screen';

const mocks = vi.hoisted(() => ({
  startResearchAction: vi.fn(),
  push: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({ startResearchAction: mocks.startResearchAction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: vi.fn() } }));

const CREATED = { ok: true as const, value: { ideaId: 3, threadId: 7, runId: 9 } };

function suggestionChips(): HTMLElement[] {
  return within(screen.getByRole('list', { name: '推荐方向' })).getAllByRole('button');
}

function textbox(): HTMLElement {
  return screen.getByRole('textbox', { name: '输入消息' });
}

function composer(): HTMLElement {
  return screen.getByRole('group', { name: '研究输入' });
}

function domRect(top: number): DOMRect {
  return {
    top,
    bottom: top + 120,
    left: 0,
    right: 800,
    width: 800,
    height: 120,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * jsdom lays every box out at `top: 0`, which would make the FLIP a no-op. The
 * composer reports the centred slot until the layout docks it, then the bottom
 * bar — exactly the two positions the animation interpolates between.
 */
function fakeLayout(centredTop: number, dockedTop: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return domRect(this.getAttribute('data-docking') === 'true' ? dockedTop : centredTop);
  });
}

/** The handles the FLIP keeps from the animation it started. */
type AnimateStub = { animate: Mock; cancel: Mock; reverse: Mock };

/** jsdom ships no Web Animations API; install a controllable stand-in. */
function installAnimate(finished: Promise<void>): AnimateStub {
  const cancel = vi.fn();
  const reverse = vi.fn();
  const animate = vi.fn(() => ({ finished, cancel, reverse }));
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: animate,
  });
  return { animate, cancel, reverse };
}

/** Submit the idea and let the commit, the action and the animation settle. */
async function submit(idea = '跨境卖家库存同步太麻烦'): Promise<void> {
  fireEvent.change(textbox(), { target: { value: idea } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as Partial<Element>).animate;
});

describe('NewResearchScreen', () => {
  it('centres the composer and shows six recommendation chips initially', () => {
    render(<NewResearchScreen recentIdeas={[]} />);

    expect(screen.getByRole('heading', { name: '先描述一个问题' })).toBeVisible();
    expect(screen.getByText('推荐方向')).toBeVisible();
    expect(screen.getByRole('region', { name: '新建研究' })).toHaveClass('justify-center');
    expect(composer()).toHaveAttribute('data-docking', 'false');

    // The dock animates this card into the thread page, so it must already be
    // the thread page's card: same radius, padding and placeholder.
    expect(textbox().parentElement).toHaveClass('rounded-2xl', 'p-3');
    expect(textbox()).toHaveAttribute('placeholder', '描述一个产品想法，或粘贴一段用户抱怨…');

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

  it('docks with a FLIP on the composer itself and waits for it to land', async () => {
    mocks.startResearchAction.mockResolvedValue(CREATED);
    fakeLayout(120, 640);

    // Never settles: the test proves navigation is gated on the animation.
    const { animate, cancel } = installAnimate(new Promise<void>(() => undefined));

    const { unmount } = render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(mocks.startResearchAction).toHaveBeenCalledWith({ idea: '跨境卖家库存同步太麻烦' });
    expect(composer()).toHaveAttribute('data-docking', 'true');
    expect(screen.getByRole('region', { name: '新建研究' })).toHaveClass('justify-end');

    // Inverted first frame: 120 − 640, so the animation starts where the reader
    // last saw the card instead of at the docked slot.
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(
      [
        { transform: 'translateY(-520px) scale(0.985)' },
        { transform: 'translateY(-3px) scale(1.003)', offset: 0.78 },
        { transform: 'translateY(0) scale(1)' },
      ],
      { duration: 520, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'both' },
    );

    // The thread page only takes over once the card has arrived.
    expect(mocks.push).not.toHaveBeenCalled();

    // Leaving early must abort the animation rather than let it run on.
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('navigates as soon as the dock animation resolves', async () => {
    mocks.startResearchAction.mockResolvedValue(CREATED);
    fakeLayout(120, 640);
    installAnimate(Promise.resolve());

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/threads/7');
  });

  it('waits for a slow request even after the animation has landed', async () => {
    // The dock is already over; only the create request is still in flight.
    mocks.startResearchAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(CREATED), 100);
        }),
    );
    fakeLayout(120, 640);
    installAnimate(Promise.resolve());

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith('/threads/7');
  });

  it('runs the dock immediately and the create request in parallel', async () => {
    // A request that never answers: the card still has to move on the keystroke.
    mocks.startResearchAction.mockImplementation(() => new Promise(() => undefined));
    fakeLayout(120, 640);
    const { animate } = installAnimate(new Promise<void>(() => undefined));

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(mocks.startResearchAction).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(composer()).toHaveAttribute('data-docking', 'true');
  });

  it('starts only one request when the reader submits twice', async () => {
    mocks.startResearchAction.mockImplementation(() => new Promise(() => undefined));
    fakeLayout(120, 640);
    installAnimate(new Promise<void>(() => undefined));

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit('跨境卖家库存同步太麻烦');

    // A second, fully enabled submit during the dock must be ignored.
    fireEvent.change(textbox(), { target: { value: '第二条想法也要发出去' } });
    const again = screen.getByRole('button', { name: '发送' });
    expect(again).toBeEnabled();
    fireEvent.click(again);

    expect(mocks.startResearchAction).toHaveBeenCalledTimes(1);
  });

  it('navigates immediately when the Web Animations API is missing', async () => {
    mocks.startResearchAction.mockResolvedValue(CREATED);
    fakeLayout(120, 640);
    expect('animate' in Element.prototype).toBe(false);

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(composer()).toHaveAttribute('data-docking', 'true');
    expect(mocks.push).toHaveBeenCalledWith('/threads/7');
  });

  it('skips the slide entirely when the reader prefers reduced motion', async () => {
    mockMediaQuery('(prefers-reduced-motion: reduce)', true);
    mocks.startResearchAction.mockResolvedValue(CREATED);
    fakeLayout(120, 640);
    const { animate } = installAnimate(Promise.resolve());

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(animate).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith('/threads/7');
  });

  it('rolls the dock back and reports a failed create without navigating', async () => {
    mocks.startResearchAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '创建研究失败 (SQLSTATE 08006)',
    });
    fakeLayout(120, 640);
    const { animate, reverse } = installAnimate(Promise.resolve());

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(mocks.error).toHaveBeenCalledWith('创建研究失败 (SQLSTATE 08006)');
    // The card plays the dock backwards instead of snapping to the middle.
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(composer()).toHaveAttribute('data-docking', 'false');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('rolls back to the prompt when the request throws', async () => {
    mocks.startResearchAction.mockRejectedValue(new Error('fetch failed'));
    fakeLayout(120, 640);
    const { reverse } = installAnimate(Promise.resolve());

    render(<NewResearchScreen recentIdeas={[]} />);
    await submit();

    expect(mocks.error).toHaveBeenCalledWith('创建研究失败：网络错误');
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(composer()).toHaveAttribute('data-docking', 'false');
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
