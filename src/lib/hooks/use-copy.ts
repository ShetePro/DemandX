'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface CopyControls {
  /** `true` from a successful copy until the reset timer fires. */
  copied: boolean;
  /** Copy `text`; a rejected clipboard leaves `copied` untouched. */
  copy: (text: string) => Promise<void>;
}

/**
 * Copy text to the clipboard and expose a short-lived `copied` flag for
 * feedback. The reset timer is restarted by each call and cleared on unmount.
 */
export function useCopy(resetMs = 2000): CopyControls {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard can be missing (insecure context) or permission-denied.
        return;
      }

      clearResetTimer();
      setCopied(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, resetMs);
    },
    [clearResetTimer, resetMs],
  );

  return { copied, copy };
}
