import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/shell/app-sidebar';
import { CommandPalette } from '@/components/shell/command-palette';
import { MobileNav } from '@/components/shell/mobile-nav';
import { deleteThreadAction } from '@/features/threads/actions';
import { listThreadSummaries } from '@/lib/runs/repository';

// The conversation list is live data; every page in this shell is per-request.
export const dynamic = 'force-dynamic';

/**
 * Workbench shell: fixed sidebar on desktop, top bar + drawer below `md`, and a
 * single scroll container for page content. Both navigation entry points are
 * rendered here so page routes stay pure content.
 *
 * The conversations are read once here and handed to the sidebar, the mobile
 * drawer and the command palette, so the three never disagree or re-query.
 */
export default async function WorkbenchLayout({ children }: { children: ReactNode }) {
  const threads = await listThreadSummaries();
  if (!threads.ok) throw new Error(threads.message);

  return (
    <div className="grid h-dvh grid-cols-[244px_minmax(0,1fr)] overflow-hidden max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)] print:block print:h-auto print:overflow-visible">
      <AppSidebar threads={threads.value} onDelete={deleteThreadAction} />
      <MobileNav threads={threads.value} onDelete={deleteThreadAction} />
      <main className="h-dvh overflow-y-auto max-md:h-full print:h-auto print:overflow-visible">
        {children}
      </main>
      <CommandPalette threads={threads.value} />
    </div>
  );
}
