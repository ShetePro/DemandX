import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useAutoResize } from './use-auto-resize';

/** A textarea whose `scrollHeight` we control; jsdom always reports 0. */
function measure(scrollHeight: number): HTMLTextAreaElement {
  const { result } = renderHook(() => useAutoResize({ value: '内容' }));
  const textarea = document.createElement('textarea');
  textarea.style.lineHeight = '20px';
  textarea.style.padding = '0';
  document.body.append(textarea);
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: scrollHeight });

  result.current.ref.current = textarea;
  act(() => result.current.resize());

  return textarea;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('useAutoResize', () => {
  it('keeps short content at one line', () => {
    const textarea = measure(8);

    expect(textarea.style.height).toBe('20px');
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('grows with the measured height between one and six lines', () => {
    const textarea = measure(60);

    expect(textarea.style.height).toBe('60px');
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('stops at six lines and scrolls beyond that', () => {
    const textarea = measure(400);

    expect(textarea.style.height).toBe('120px');
    expect(textarea.style.overflowY).toBe('auto');
  });
});
