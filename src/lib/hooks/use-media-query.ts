'use client';

import { useEffect, useState } from 'react';

/**
 * Track a CSS media query.
 *
 * The first render always reports `false` — on the server, during hydration and
 * before the effect runs — so markup cannot mismatch. The real
 * `window.matchMedia(query).matches` value follows right after mount, and the
 * listener is torn down when `query` changes or the component unmounts.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQueryList = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);

    // Reading the query during render would break the `false`-until-mounted
    // contract (server, hydration and first client render), so it is synced
    // once here instead — `useSyncExternalStore` reports the real value on the
    // very first client render and cannot express it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMatches(mediaQueryList.matches);
    mediaQueryList.addEventListener('change', onChange);

    return () => mediaQueryList.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
