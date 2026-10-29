'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Bump when the envelope shape changes; older payloads fall back to `initial`. */
const STORAGE_VERSION = 1;

interface StoredEnvelope<T> {
  v: number;
  data: T;
}

export type LocalStorageSetter<T> = (next: T | ((previous: T) => T)) => void;

/** `[value, setValue, remove]` */
export type LocalStorageControls<T> = [T, LocalStorageSetter<T>, () => void];

function isEnvelope(value: unknown): value is StoredEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'v' in value && 'data' in value;
}

/** Parsed value, or `fallback` for absent/corrupt/future-version payloads. */
function readStored<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;

    const parsed: unknown = JSON.parse(raw);
    if (!isEnvelope(parsed) || parsed.v !== STORAGE_VERSION) return fallback;

    return parsed.data as T;
  } catch {
    return fallback;
  }
}

function writeStored<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;

  try {
    const envelope: StoredEnvelope<T> = { v: STORAGE_VERSION, data: value };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Safari private mode or a full quota: keep going with the in-memory value.
  }
}

/**
 * A `useState`-shaped value persisted as versioned JSON in `localStorage`.
 *
 * The first render returns `initial` so server and hydration output match; the
 * stored value is read right after mount. Other tabs stay in sync through the
 * `storage` event. Storage failures never throw — the value still updates in
 * memory for the lifetime of the component.
 */
export function useLocalStorage<T>(key: string, initial: T): LocalStorageControls<T> {
  const [value, setValueState] = useState<T>(initial);
  const initialRef = useRef(initial);
  // Mirrors `value` for callers that set twice in one tick, where the state
  // updater has not run yet.
  const valueRef = useRef(value);

  useEffect(() => {
    initialRef.current = initial;
  });

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Deliberate post-mount read: reading during render would break hydration.
  useEffect(() => {
    const stored = readStored(key, initialRef.current);
    valueRef.current = stored;
    setValueState(stored);
  }, [key]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onStorage = (event: StorageEvent) => {
      // `null` means another tab called clear(); a null key must also reset us.
      if (event.key !== null && event.key !== key) return;
      const stored = readStored(key, initialRef.current);
      valueRef.current = stored;
      setValueState(stored);
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const setValue = useCallback<LocalStorageSetter<T>>(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (previous: T) => T)(valueRef.current) : next;
      valueRef.current = resolved;
      writeStored(key, resolved);
      setValueState(resolved);
    },
    [key],
  );

  const remove = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore: the in-memory value still resets below.
      }
    }

    valueRef.current = initialRef.current;
    setValueState(initialRef.current);
  }, [key]);

  return useMemo(() => [value, setValue, remove], [value, setValue, remove]);
}
