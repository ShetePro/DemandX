import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRunStream } from './use-run-stream';

/** Minimal EventSource stand-in: records construction and replays frames. */
class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  receive(seq: number, type: string, payload: Record<string, unknown> = {}): void {
    this.receiveRaw(JSON.stringify({ type, payload }), String(seq));
  }

  receiveRaw(data: string, lastEventId: string): void {
    this.onmessage?.(new MessageEvent('message', { data, lastEventId }));
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

function stream(index = MockEventSource.instances.length - 1): MockEventSource {
  const instance = MockEventSource.instances[index];
  if (instance === undefined) throw new Error(`no stream opened at index ${index}`);
  return instance;
}

function urls(): string[] {
  return MockEventSource.instances.map((instance) => instance.url);
}

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useRunStream', () => {
  it('opens the stream from the first cursor and reports the connection', () => {
    const { result } = renderHook(() => useRunStream(7));

    expect(urls()).toEqual(['/api/runs/7/stream?after_seq=0']);
    expect(result.current.connected).toBe(false);

    act(() => stream().open());

    expect(result.current.connected).toBe(true);
    expect(result.current.retries).toBe(0);
  });

  it('folds frames into renderable state', () => {
    const { result } = renderHook(() => useRunStream(1));

    act(() => {
      stream().receive(1, 'run.created', { idea: 'a' });
      stream().receive(2, 'stage.started', { stage: 'S1' });
    });

    expect(result.current.state.events).toHaveLength(2);
    expect(result.current.state.lastSeq).toBe(2);
    expect(result.current.state.status).toBe('running');
    expect(result.current.state.stage).toBe('S1');
  });

  it('keeps the stream open when a stage finishes with its own status', () => {
    const { result } = renderHook(() => useRunStream(14));

    act(() => stream().open());
    act(() => {
      stream().receive(1, 'run.created');
      stream().receive(2, 'stage.finished', { stage: 'S1', status: 'finished' });
    });

    expect(result.current.state.stage).toBe('S1');
    expect(result.current.state.status).toBe('running');
    expect(result.current.state.terminal).toBe(false);
    expect(result.current.connected).toBe(true);
    expect(stream().close).not.toHaveBeenCalled();

    // No reconnect timer was armed and the original stream is still the only one.
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    act(() => stream().receive(3, 'run.finished', { status: 'finished' }));
    expect(result.current.state.terminal).toBe(true);
    expect(stream().close).toHaveBeenCalled();
  });

  it('drops a duplicated frame', () => {
    const { result } = renderHook(() => useRunStream(1));

    act(() => {
      stream().receive(1, 'run.created');
      stream().receive(1, 'run.created');
    });

    expect(result.current.state.events).toHaveLength(1);
    expect(result.current.state.lastSeq).toBe(1);
  });

  it('drops malformed frames and frames without a cursor', () => {
    const { result } = renderHook(() => useRunStream(1));

    act(() => {
      stream().receiveRaw('not json', '1');
      stream().receiveRaw('{"type":"run.created","payload":{}}', '');
      stream().receiveRaw('{"payload":{}}', '2');
      stream().receiveRaw('[]', '3');
    });

    expect(result.current.state.events).toHaveLength(0);
    expect(result.current.state.lastSeq).toBe(0);
  });

  it('reconnects after 1s from the last seen cursor', () => {
    const { result } = renderHook(() => useRunStream(4));

    act(() => stream().receive(3, 'stage.started', { stage: 'S1' }));
    act(() => stream().fail());

    expect(result.current.connected).toBe(false);
    expect(result.current.retries).toBe(1);
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(999));
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(2);
    expect(urls()[1]).toBe('/api/runs/4/stream?after_seq=3');
    expect(stream(0)?.close).toHaveBeenCalled();
  });

  it('backs off 1s, 2s, 4s, 8s and stops after five reconnects', () => {
    renderHook(() => useRunStream(5));

    for (const [attempt, delay] of [1_000, 2_000, 4_000, 8_000, 8_000].entries()) {
      expect(MockEventSource.instances).toHaveLength(attempt + 1);

      act(() => stream().fail());
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(MockEventSource.instances).toHaveLength(attempt + 1);

      act(() => vi.advanceTimersByTime(1));
      expect(MockEventSource.instances).toHaveLength(attempt + 2);
    }

    // The fifth reconnect failed too: no sixth attempt is scheduled.
    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(6);
  });

  it('resets the retry budget after a successful connection', () => {
    const { result } = renderHook(() => useRunStream(6));

    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(1_000));

    act(() => stream().open());
    expect(result.current.retries).toBe(0);

    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(1_000));
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('never reconnects once the run is finished', () => {
    const { result } = renderHook(() => useRunStream(8));

    act(() => stream().receive(1, 'run.finished', { status: 'finished' }));

    expect(result.current.state.terminal).toBe(true);
    expect(result.current.state.status).toBe('finished');
    expect(result.current.connected).toBe(false);
    expect(stream().close).toHaveBeenCalled();

    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('reports a failed run and stops reconnecting', () => {
    const { result } = renderHook(() => useRunStream(9));

    act(() => stream().receive(1, 'run.failed', { code: 'LLM_UNAVAILABLE' }));

    expect(result.current.state.status).toBe('failed');
    expect(result.current.state.error).toBe('LLM_UNAVAILABLE');
    expect(result.current.state.terminal).toBe(true);

    act(() => stream().fail());
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('does not open a stream for an already terminal snapshot', () => {
    const { result } = renderHook(() =>
      useRunStream(10, [{ seq: 2, type: 'run.finished', payload: { status: 'finished' } }]),
    );

    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.state.terminal).toBe(true);
    expect(result.current.connected).toBe(false);
  });

  it('closes the stream and cancels a pending retry on unmount', () => {
    const { unmount } = renderHook(() => useRunStream(11));

    act(() => stream().fail());
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(stream(0)?.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('resets state and reconnects from zero when the run changes', () => {
    const { result, rerender } = renderHook(({ runId }: { runId: number }) => useRunStream(runId), {
      initialProps: { runId: 12 },
    });

    act(() => stream().receive(2, 'stage.started', { stage: 'S1' }));
    expect(result.current.state.lastSeq).toBe(2);

    rerender({ runId: 13 });

    expect(stream(0)?.close).toHaveBeenCalled();
    expect(urls()[1]).toBe('/api/runs/13/stream?after_seq=0');
    expect(result.current.state.lastSeq).toBe(0);
    expect(result.current.state.events).toHaveLength(0);
    expect(result.current.connected).toBe(false);

    act(() => stream().receive(1, 'run.created'));
    expect(result.current.state.events).toHaveLength(1);
  });
});
