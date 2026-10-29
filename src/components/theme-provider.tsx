'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

/**
 * App-wide theme provider. Only this file (and `use-theme.ts`) may import
 * `next-themes`; everything else goes through {@link useTheme}.
 *
 * The inline bootstrap script next-themes injects sets `data-theme` on
 * `<html>` before first paint, which is why the root layout carries
 * `suppressHydrationWarning`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
