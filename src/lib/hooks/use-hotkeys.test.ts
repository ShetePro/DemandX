import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHotkeys } from './use-hotkeys';

function stubPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** An element inside an editable region, attached so the event bubbles to `window`. */
function editable(tagName: 'input' | 'textarea' | 'select' | 'div'): HTMLElement {
  const element = document.createElement(tagName);
  if (tagName === 'div') element.setAttribute('contenteditable', 'true');
  document.body.append(element);
  return element;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'platform');
  document.body.replaceChildren();
});

describe('useHotkeys', () => {
  it('fires on mod+k with meta on macOS and prevents the default', () => {
    stubPlatform('MacIntel');
    const handler = vi.fn();
    renderHook(() => useHotkeys('mod+k', handler));

    const event = press({ key: 'k', metaKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    press({ key: 'k', metaKey: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fires on mod+k with ctrl elsewhere and ignores meta', () => {
    stubPlatform('Linux x86_64');
    const handler = vi.fn();
    renderHook(() => useHotkeys('mod+k', handler));

    press({ key: 'k', metaKey: true });
    expect(handler).not.toHaveBeenCalled();

    const event = press({ key: 'k', ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('matches a single key case-insensitively', () => {
    const handler = vi.fn();
    renderHook(() => useHotkeys('escape', handler));

    press({ key: 'Escape' });
    expect(handler).toHaveBeenCalledTimes(1);

    press({ key: 'Enter' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores keystrokes inside editable elements', () => {
    stubPlatform('MacIntel');
    const handler = vi.fn();
    renderHook(() => useHotkeys('mod+k', handler));

    for (const tagName of ['input', 'textarea', 'select', 'div'] as const) {
      press({ key: 'k', metaKey: true }, editable(tagName));
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fire when disabled', () => {
    stubPlatform('MacIntel');
    const handler = vi.fn();
    renderHook(() => useHotkeys('mod+k', handler, { enabled: false }));

    press({ key: 'k', metaKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls the latest handler after a re-render', () => {
    stubPlatform('MacIntel');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onKey }: { onKey: () => void }) => useHotkeys('mod+k', onKey),
      { initialProps: { onKey: first } },
    );

    press({ key: 'k', metaKey: true });
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ onKey: second });
    press({ key: 'k', metaKey: true });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    stubPlatform('MacIntel');
    const handler = vi.fn();
    const { unmount } = renderHook(() => useHotkeys('mod+k', handler));

    unmount();
    press({ key: 'k', metaKey: true });

    expect(handler).not.toHaveBeenCalled();
  });
});
