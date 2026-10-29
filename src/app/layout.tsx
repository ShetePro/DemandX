import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';

import './globals.css';

export const metadata: Metadata = { title: 'DemandX' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes' bootstrap script sets `data-theme` on <html> before paint.
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
