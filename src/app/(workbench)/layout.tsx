import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/shell/app-sidebar';
import { CommandPalette } from '@/components/shell/command-palette';
import { MobileNav } from '@/components/shell/mobile-nav';

/**
 * Workbench shell: fixed sidebar on desktop, top bar + drawer below `md`, and a
 * single scroll container for page content. Both navigation entry points are
 * rendered here so page routes stay pure content.
 */
export default function WorkbenchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-dvh grid-cols-[244px_minmax(0,1fr)] overflow-hidden max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]">
      <AppSidebar />
      <MobileNav />
      <main className="h-dvh overflow-y-auto max-md:h-full">{children}</main>
      <CommandPalette />
    </div>
  );
}
