import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeProvider } from '@/components/theme-provider';

import { useTheme } from './use-theme';

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty('color-scheme');
});

describe('useTheme', () => {
  it('resolves the system theme to light when the OS prefers light', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe('system');
    expect(result.current.resolved).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('toggles to dark and back to light, updating the document attribute', () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    act(() => result.current.toggle());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(result.current.resolved).toBe('dark');

    act(() => result.current.toggle());
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(result.current.resolved).toBe('light');
  });
});
