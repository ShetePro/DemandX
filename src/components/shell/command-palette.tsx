'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

import { useHotkeys } from '@/lib/hooks/use-hotkeys';

import { NAV_ITEMS, SETTINGS_ITEM } from './nav-items';

/** Every destination reachable from the palette; nothing hard-coded per entry. */
const COMMAND_ITEMS = [...NAV_ITEMS, SETTINGS_ITEM];

/**
 * ⌘K / Ctrl-K palette over the same destinations as the sidebar. Rendering it
 * once in the workbench layout covers every page; cmdk (Radix Dialog) handles
 * focus trapping and Escape.
 *
 * cmdk's dialog has no `Dialog.Trigger`, so Radix drops focus to `<body>` on
 * close; the element that was focused before opening is restored here instead.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useHotkeys('mod+k', () => {
    const active = document.activeElement;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setOpen(true);
  });

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) return;

    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    // After Radix unmounts the dialog and parks focus on <body>.
    if (target) requestAnimationFrame(() => target.focus());
  }, []);

  const handleSelect = useCallback(
    (href: string) => {
      // Navigation decides where focus belongs next.
      restoreFocusRef.current = null;
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={handleOpenChange}
      label="命令面板"
      overlayClassName="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm"
      contentClassName="fixed top-24 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
    >
      <Command.Input
        placeholder="搜索页面…"
        className="h-11 w-full border-b border-border bg-transparent px-4 text-sm text-fg outline-none placeholder:text-faint"
      />
      <Command.List className="max-h-72 overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          没有匹配的页面
        </Command.Empty>
        {COMMAND_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <Command.Item
              key={item.href}
              value={item.label}
              keywords={item.keywords}
              onSelect={() => handleSelect(item.href)}
              className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent"
            >
              <Icon className="size-4" />
              {item.label}
            </Command.Item>
          );
        })}
      </Command.List>
    </Command.Dialog>
  );
}
