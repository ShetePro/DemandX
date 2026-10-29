'use client';

import { useEffect, useState } from 'react';

/**
 * `value`, delayed until it has stopped changing for `delay` milliseconds.
 * Each change restarts the timer; the pending timer is cleared on unmount.
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
