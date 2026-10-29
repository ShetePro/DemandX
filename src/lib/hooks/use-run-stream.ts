'use client';

import { useEffect, useReducer, useRef, useState } from 'react';

import {
  initialRunState,
  reduce,
  type RunEvent,
  type RunStreamState,
} from '@/lib/runs/event-reducer';

/** Wait before each reconnect: 1s, 2s, 4s, then 8s for the remaining tries. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;
export const MAX_RETRIES = 5;

type StreamAction = { kind: 'event'; event: RunEvent } | { kind: 'snapshot'; events: RunEvent[] };

function streamReducer(state: RunStreamState, action: StreamAction): RunStreamState {
  if (action.kind === 'event') return reduce(state, action.event);
  return initialRunState(action.events);
}

/**
 * Decode one frame. `seq` comes from the `id:` line (EventSource exposes it as
 * `lastEventId`); the JSON body carries `{ type, payload }`. Anything that
 * cannot be ordered or typed is dropped rather than poisoning the state.
 */
function parseFrame(message: MessageEvent): RunEvent | null {
  const seq = Number(message.lastEventId);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as { type?: unknown; payload?: unknown };
  if (typeof frame.type !== 'string' || frame.type.length === 0) return null;

  const payload =
    typeof frame.payload === 'object' && frame.payload !== null && !Array.isArray(frame.payload)
      ? (frame.payload as Record<string, unknown>)
      : {};

  return { seq, type: frame.type, payload };
}

export type RunStreamResult = {
  state: RunStreamState;
  connected: boolean;
  retries: number;
};

/**
 * Live state of one run. Events are folded through the pure reducer; the hook
 * itself only owns the connection.
 *
 * - A disconnect is retried 1s → 2s → 4s → 8s, at most five times. Each
 *   attempt rebuilds the URL with the current `lastSeq`, which is the same
 *   cursor `Last-Event-ID` would carry.
 * - A terminal run closes the stream and never reconnects: the server closes
 *   terminal streams on its own, and EventSource would otherwise reconnect by
 *   default.
 * - `connected` follows open/error; `retries` is the current retry streak and
 *   resets after a successful open.
 *
 * `runId` is expected to be stable for a mounted run. Changing it resets the
 * state and reconnects from the start of the new log, but keying the component
 * by run is the cheaper way to switch runs.
 */
export function useRunStream(runId: number, initialEvents: RunEvent[] = []): RunStreamResult {
  const [state, dispatch] = useReducer(streamReducer, initialEvents, initialRunState);
  const [connected, setConnected] = useState(false);
  const [retries, setRetries] = useState(0);

  // The connection callbacks need the cursor and the terminal flag
  // synchronously, before React has committed the latest render.
  const stateRef = useRef(state);
  const runIdRef = useRef(runId);
  const initialEventsRef = useRef(initialEvents);

  useEffect(() => {
    initialEventsRef.current = initialEvents;
  });

  useEffect(() => {
    if (runIdRef.current !== runId) {
      runIdRef.current = runId;
      const snapshot = initialRunState(initialEventsRef.current);
      stateRef.current = snapshot;
      dispatch({ kind: 'snapshot', events: initialEventsRef.current });
      setConnected(false);
      setRetries(0);
    }

    let disposed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    function closeSource(): void {
      if (source === null) return;
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
      source = null;
    }

    function clearTimer(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    }

    // A snapshot may already be terminal; there is nothing to stream.
    if (stateRef.current.terminal) {
      setConnected(false);
      return () => {
        disposed = true;
      };
    }

    function connect(): void {
      if (disposed || stateRef.current.terminal) return;

      const cursor = stateRef.current.lastSeq;
      const stream = new EventSource(`/api/runs/${runId}/stream?after_seq=${cursor}`);
      source = stream;

      stream.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setRetries(0);
        setConnected(true);
      };

      stream.onmessage = (message) => {
        if (disposed) return;

        const event = parseFrame(message);
        if (event === null) return;

        const next = reduce(stateRef.current, event);
        if (next === stateRef.current) return;

        stateRef.current = next;
        dispatch({ kind: 'event', event });

        if (next.terminal) {
          clearTimer();
          closeSource();
          setConnected(false);
        }
      };

      stream.onerror = () => {
        if (disposed) return;
        setConnected(false);
        closeSource();

        // The run is over, or we have spent the reconnect budget. Leave it to
        // the caller to surface the failure; retrying forever would hide it.
        if (stateRef.current.terminal || attempts >= MAX_RETRIES) return;

        const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 8_000;
        attempts += 1;
        setRetries(attempts);
        timer = setTimeout(() => {
          timer = null;
          connect();
        }, delay);
      };
    }

    connect();

    return () => {
      disposed = true;
      clearTimer();
      closeSource();
    };
  }, [runId]);

  return { state, connected, retries };
}
