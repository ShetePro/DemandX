'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Fallback line box when the browser reports `normal` (jsdom, exotic fonts). */
const FALLBACK_LINE_HEIGHT = 20;

export type AutoResizeOptions = {
  /** Re-measure whenever the textarea's value changes. */
  value: string;
  minRows?: number;
  maxRows?: number;
};

export type AutoResizeResult = {
  ref: React.RefObject<HTMLTextAreaElement | null>;
  /** Measure now — used by `onInput` handlers that need the new height at once. */
  resize: () => void;
};

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Keep a textarea between `minRows` and `maxRows` tall.
 *
 * Height comes from `scrollHeight` plus the element's own padding, not from
 * counting newlines: wrapped Chinese text needs more rows than its newline
 * count, and the browser already knows how many. Past `maxRows` the element
 * scrolls instead of growing, so the composer never eats the message list.
 */
export function useAutoResize({
  value,
  minRows = 1,
  maxRows = 6,
}: AutoResizeOptions): AutoResizeResult {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const element = ref.current;
    if (element === null) return;

    const style = window.getComputedStyle(element);
    const lineHeight = px(style.lineHeight) || FALLBACK_LINE_HEIGHT;
    const padding = px(style.paddingTop) + px(style.paddingBottom);
    const min = lineHeight * minRows + padding;
    const max = lineHeight * Math.max(minRows, maxRows) + padding;

    // `auto` first: with a fixed height the browser reports the clamped
    // scrollHeight, so the box could never shrink back after a deletion.
    element.style.height = 'auto';
    const height = Math.min(Math.max(element.scrollHeight, min), max);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
  }, [maxRows, minRows]);

  useEffect(() => {
    resize();
  }, [resize, value]);

  return { ref, resize };
}
