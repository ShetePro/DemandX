'use client';

import { useTheme as useNextTheme } from 'next-themes';
import { useCallback } from 'react';

/** Theme the user picked; `system` follows the OS preference. */
export type Theme = 'light' | 'dark' | 'system';

/** Theme actually applied to the document. */
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeControls {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Flip to the opposite of the currently applied theme. */
  toggle: () => void;
}

/**
 * Typed wrapper around next-themes' `useTheme`. Components must use this hook
 * instead of importing `next-themes` directly, so the storage strategy and
 * attribute name stay in one place.
 *
 * `resolved` is only known after hydration; render theme-dependent markup
 * behind a mounted flag to keep server and client output identical.
 */
export function useTheme(): ThemeControls {
  const { theme, resolvedTheme, setTheme } = useNextTheme();

  const activeTheme: Theme = theme === 'light' || theme === 'dark' ? theme : 'system';
  const resolved: ResolvedTheme = resolvedTheme === 'dark' ? 'dark' : 'light';

  const toggle = useCallback(
    () => setTheme(resolved === 'dark' ? 'light' : 'dark'),
    [resolved, setTheme],
  );

  return { theme: activeTheme, resolved, setTheme, toggle };
}
