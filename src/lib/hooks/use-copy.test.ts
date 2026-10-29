import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { useCopy } from './use-copy';

type WriteText = (text: string) => Promise<void>;

let writeText: Mock<WriteText>;

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn<WriteText>(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('useCopy', () => {
  it('writes to the clipboard and resets `copied` after 2000ms', async () => {
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(1999));
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.copied).toBe(false);
  });

  it('keeps a single timer across consecutive copies and restarts it', async () => {
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      await result.current.copy('first');
    });
    act(() => vi.advanceTimersByTime(1500));

    await act(async () => {
      await result.current.copy('second');
    });
    expect(vi.getTimerCount()).toBe(1);

    // 1500ms more: past the first deadline, not the second.
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.copied).toBe(false);
  });

  it('stays not-copied and swallows clipboard errors', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const { result } = renderHook(() => useCopy());

    await act(async () => {
      await result.current.copy('blocked');
    });

    expect(result.current.copied).toBe(false);
  });

  it('clears the reset timer on unmount', async () => {
    const { result, unmount } = renderHook(() => useCopy(500));

    await act(async () => {
      await result.current.copy('bye');
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
