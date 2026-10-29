'use client';

import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { useTheme } from '@/lib/hooks/use-theme';

/**
 * Light/dark switch. The resolved theme only exists after hydration, so the
 * server render and the hydration pass show a same-size, inert placeholder;
 * otherwise icon and aria-label would mismatch.
 *
 * `useSyncExternalStore` is the mount probe here: no store to subscribe to,
 * it just reports `false` while the server/hydration snapshot is in use and
 * `true` once the client is live. (A `mounted` flag set from `useEffect` does
 * the same thing but trips `react-hooks/set-state-in-effect`.)
 */
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  if (!mounted) {
    return <span aria-hidden className="inline-block size-8" />;
  }

  const isDark = resolved === 'dark';

  return (
    <button
      type="button"
      aria-label={isDark ? '切换到浅色' : '切换到深色'}
      onClick={toggle}
      className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
