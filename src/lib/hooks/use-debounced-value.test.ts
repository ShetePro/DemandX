import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedValue } from './use-debounced-value';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedValue', () => {
  it('keeps the previous value at 249ms and updates at 250ms', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value),
      {
        initialProps: { value: 'before' },
      },
    );

    rerender({ value: 'after' });

    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe('before');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('after');
  });

  it('applies only the last of several rapid changes', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useDebouncedValue(value, 300),
      { initialProps: { value: 0 } },
    );

    rerender({ value: 1 });
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: 2 });
    act(() => vi.advanceTimersByTime(100));
    rerender({ value: 3 });

    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe(0);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(3);
  });

  it('clears the pending timer on unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ value }: { value: string }) => useDebouncedValue(value),
      { initialProps: { value: 'before' } },
    );

    rerender({ value: 'after' });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
