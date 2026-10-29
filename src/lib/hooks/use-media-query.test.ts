import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockMediaQuery } from '@/test/setup-dom';

import { useMediaQuery } from './use-media-query';

const QUERY = '(min-width: 768px)';
const NARROW = '(max-width: 600px)';
const WIDE = '(min-width: 1200px)';

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MatchMediaHarness {
  /** Flip `matches` for a query and notify its listeners. */
  emit: (query: string, matches: boolean) => void;
  listenerCount: (query: string) => number;
  subscribedQueries: () => string[];
}

/**
 * Instrumented `window.matchMedia`. The suite's default stand-in cannot emit
 * `change` events or report subscriptions, both of which the cleanup
 * assertions need.
 */
function installMatchMediaHarness(): MatchMediaHarness {
  const matchesByQuery = new Map<string, boolean>();
  const listenersByQuery = new Map<string, Set<ChangeListener>>();
  const subscribedQueries: string[] = [];

  const listenersFor = (query: string): Set<ChangeListener> => {
    const existing = listenersByQuery.get(query);
    if (existing) return existing;
    const created = new Set<ChangeListener>();
    listenersByQuery.set(query, created);
    return created;
  };

  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    subscribedQueries.push(query);

    const list = {
      media: query,
      get matches() {
        return matchesByQuery.get(query) ?? false;
      },
      onchange: null,
      addEventListener: (type: string, listener: ChangeListener | null) => {
        if (type === 'change' && listener) listenersFor(query).add(listener);
      },
      removeEventListener: (type: string, listener: ChangeListener | null) => {
        if (type === 'change' && listener) listenersFor(query).delete(listener);
      },
      addListener: (listener: ChangeListener | null) => {
        if (listener) listenersFor(query).add(listener);
      },
      removeListener: (listener: ChangeListener | null) => {
        if (listener) listenersFor(query).delete(listener);
      },
      dispatchEvent: () => true,
    };

    return list as unknown as MediaQueryList;
  });

  return {
    emit: (query, matches) => {
      matchesByQuery.set(query, matches);
      const event = { matches, media: query } as MediaQueryListEvent;
      for (const listener of [...listenersFor(query)]) listener(event);
    },
    listenerCount: (query) => listenersFor(query).size,
    subscribedQueries: () => [...subscribedQueries],
  };
}

describe('useMediaQuery', () => {
  it('returns false on the first render and the match result after mount', () => {
    mockMediaQuery(QUERY);
    const seen: boolean[] = [];

    const { result } = renderHook(() => {
      const matches = useMediaQuery(QUERY);
      seen.push(matches);
      return matches;
    });

    expect(seen[0]).toBe(false);
    expect(result.current).toBe(true);
  });

  it('stays false when the media query does not match', () => {
    mockMediaQuery(QUERY, false);

    const { result } = renderHook(() => useMediaQuery(QUERY));

    expect(result.current).toBe(false);
  });

  it('re-subscribes when the query changes and drops the previous listener', () => {
    const harness = installMatchMediaHarness();
    harness.emit(NARROW, true);

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useMediaQuery(query),
      { initialProps: { query: NARROW } },
    );
    expect(result.current).toBe(true);
    expect(harness.listenerCount(NARROW)).toBe(1);
    expect(harness.listenerCount(WIDE)).toBe(0);

    rerender({ query: WIDE });
    expect(result.current).toBe(false);
    expect(harness.listenerCount(NARROW)).toBe(0);
    expect(harness.listenerCount(WIDE)).toBe(1);
    expect(harness.subscribedQueries()).toEqual([NARROW, WIDE]);

    act(() => harness.emit(WIDE, true));
    expect(result.current).toBe(true);

    // The old query no longer has a listener, so flipping it changes nothing.
    act(() => harness.emit(NARROW, false));
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount so later changes cannot update state', () => {
    const harness = installMatchMediaHarness();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useMediaQuery(QUERY));
    expect(harness.listenerCount(QUERY)).toBe(1);

    unmount();
    expect(harness.listenerCount(QUERY)).toBe(0);

    harness.emit(QUERY, true);
    expect(result.current).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
