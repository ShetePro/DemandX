import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLocalStorage } from './use-local-storage';

const KEY = 'demandx.test.key';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useLocalStorage', () => {
  it('returns the initial value on the first render and the stored value after mount', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, data: 'stored' }));
    const seen: string[] = [];

    const { result } = renderHook(() => {
      const [value] = useLocalStorage(KEY, 'fallback');
      seen.push(value);
      return value;
    });

    expect(seen[0]).toBe('fallback');
    expect(result.current).toBe('stored');
  });

  it('persists a versioned envelope and reads it back after a remount', () => {
    const first = renderHook(() => useLocalStorage(KEY, 'initial'));

    act(() => first.result.current[1]('next'));

    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual({ v: 1, data: 'next' });
    expect(first.result.current[0]).toBe('next');

    first.unmount();
    const second = renderHook(() => useLocalStorage(KEY, 'initial'));
    expect(second.result.current[0]).toBe('next');
  });

  it('supports updater functions', () => {
    const { result } = renderHook(() => useLocalStorage(KEY, 1));

    act(() => result.current[1]((previous) => previous + 1));

    expect(result.current[0]).toBe(2);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual({ v: 1, data: 2 });
  });

  it('falls back to the initial value on malformed JSON without throwing', () => {
    window.localStorage.setItem(KEY, '{not json');

    const { result } = renderHook(() => useLocalStorage(KEY, 'fallback'));

    expect(result.current[0]).toBe('fallback');
  });

  it('falls back to the initial value when the stored version differs', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 2, data: 'from-the-future' }));

    const { result } = renderHook(() => useLocalStorage(KEY, 'fallback'));

    expect(result.current[0]).toBe('fallback');
  });

  it('removes the entry and resets to the initial value', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, data: 'stored' }));
    const { result } = renderHook(() => useLocalStorage(KEY, 'fallback'));
    expect(result.current[0]).toBe('stored');

    act(() => result.current[2]());

    expect(result.current[0]).toBe('fallback');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('syncs from the storage event of another tab', () => {
    const { result } = renderHook(() => useLocalStorage(KEY, 'fallback'));

    act(() => {
      window.localStorage.setItem(KEY, JSON.stringify({ v: 1, data: 'other tab' }));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: KEY,
          newValue: JSON.stringify({ v: 1, data: 'other tab' }),
        }),
      );
    });

    expect(result.current[0]).toBe('other tab');
  });

  it('resets when another tab clears storage (null key)', () => {
    const { result } = renderHook(() => useLocalStorage(KEY, 'fallback'));

    act(() => result.current[1]('local value'));
    expect(result.current[0]).toBe('local value');

    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(result.current[0]).toBe('fallback');
  });

  it('degrades to the in-memory value when writing throws', () => {
    const { result } = renderHook(() => useLocalStorage(KEY, 'fallback'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    act(() => result.current[1]('in-memory'));

    expect(result.current[0]).toBe('in-memory');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
