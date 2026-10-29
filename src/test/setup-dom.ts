import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Per-test presets for `window.matchMedia`, keyed by media query string.
 * Set them with {@link mockMediaQuery}; they are cleared after every test.
 */
const mediaQueryPresets = new Map<string, boolean>();

/** Make `window.matchMedia(query).matches` return `matches` in the current test. */
export function mockMediaQuery(query: string, matches = true): void {
  mediaQueryPresets.set(query, matches);
}

function createMediaQueryList(query: string): MediaQueryList {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mql = {
    media: query,
    get matches() {
      return mediaQueryPresets.get(query) ?? false;
    },
    onchange: null as ((event: MediaQueryListEvent) => void) | null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (typeof listener === 'function') listeners.add(listener as (e: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (typeof listener === 'function') listeners.delete(listener as (e: MediaQueryListEvent) => void);
    },
    // Legacy Safari/`addListener` API still used by a few libraries.
    addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
      if (listener) listeners.add(listener);
    },
    removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
      if (listener) listeners.delete(listener);
    },
    dispatchEvent: () => true,
  };

  return mql as unknown as MediaQueryList;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => createMediaQueryList(query)),
  });
}

/** jsdom has no ResizeObserver; components observing size need a no-op stand-in. */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub;
}

/** jsdom does not implement scrolling; Radix/cmdk call this on mount. */
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  mediaQueryPresets.clear();
});
