'use client';

import { useEffect, useRef } from 'react';

/** Elements where typing must win over a global shortcut. */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]';

export interface HotkeyOptions {
  /** Attach the listener only while `true` (default). */
  enabled?: boolean;
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function isApplePlatform(): boolean {
  const platform = navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** `mod+k` → `{ key: 'k', mod: true, … }`. The last non-modifier token wins. */
function parseCombo(combo: string): ParsedCombo {
  const parsed: ParsedCombo = {
    key: '',
    mod: false,
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
  };

  for (const token of combo.toLowerCase().split('+')) {
    const name = token.trim();
    if (!name) continue;

    switch (name) {
      case 'mod':
        parsed.mod = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        parsed.meta = true;
        break;
      case 'ctrl':
      case 'control':
        parsed.ctrl = true;
        break;
      case 'shift':
        parsed.shift = true;
        break;
      case 'alt':
      case 'option':
        parsed.alt = true;
        break;
      case 'space':
        parsed.key = ' ';
        break;
      default:
        parsed.key = name;
    }
  }

  return parsed;
}

function matchesCombo(event: KeyboardEvent, combo: ParsedCombo): boolean {
  const apple = isApplePlatform();
  const wantsMeta = combo.meta || (combo.mod && apple);
  const wantsCtrl = combo.ctrl || (combo.mod && !apple);

  // Extra modifiers disqualify the match: `mod+shift+k` must not run `mod+k`.
  return (
    event.metaKey === wantsMeta &&
    event.ctrlKey === wantsCtrl &&
    event.shiftKey === combo.shift &&
    event.altKey === combo.alt &&
    event.key.toLowerCase() === combo.key
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Run `handler` on a global keyboard shortcut (`mod+k`, `escape`, …), keyed on
 * `mod` meaning ⌘ on Apple platforms and Ctrl elsewhere. Keystrokes inside
 * inputs, textareas, selects and content-editable elements are ignored.
 */
export function useHotkeys(combo: string, handler: () => void, options: HotkeyOptions = {}): void {
  const enabled = options.enabled ?? true;
  const handlerRef = useRef(handler);

  // Keep the ref current so the listener is not re-bound on every render.
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const parsed = parseCombo(combo);
    if (!parsed.key) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || !matchesCombo(event, parsed)) return;

      event.preventDefault();
      handlerRef.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo, enabled]);
}
