import { describe, expect, it } from 'vitest';

import {
  MAX_RETAINED_EVENTS,
  initialRunState,
  reduce,
  type RunEvent,
  type RunStreamState,
} from './event-reducer';

function event(seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent {
  return { seq, type, payload };
}

function fold(events: RunEvent[], initial: RunStreamState = initialRunState()): RunStreamState {
  return events.reduce(reduce, initial);
}

describe('reduce', () => {
  it('appends a newer event and advances the cursor', () => {
    const state = reduce(initialRunState(), event(1, 'run.created', { idea: 'a' }));

    expect(state.lastSeq).toBe(1);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toEqual(event(1, 'run.created', { idea: 'a' }));
  });

  it('ignores a duplicated seq and returns the same state object', () => {
    const state = fold([event(3, 'stage.started', { stage: 'S1' })]);
    const duplicate = reduce(state, event(3, 'stage.started', { stage: 'S1' }));

    expect(duplicate).toBe(state);
    expect(duplicate.events).toHaveLength(1);
    expect(duplicate.lastSeq).toBe(3);
  });

  it('ignores an event older than the cursor instead of reordering history', () => {
    const state = fold([event(2, 'stage.started', { stage: 'S2' })]);
    const late = reduce(state, event(1, 'run.created'));

    expect(late).toBe(state);
    expect(late.events.map((item) => item.seq)).toEqual([2]);
  });

  it('accepts a gap, so resuming after a dropped connection still advances', () => {
    const state = fold([event(2, 'run.created'), event(7, 'stage.started', { stage: 'S3' })]);

    expect(state.lastSeq).toBe(7);
    expect(state.events.map((item) => item.seq)).toEqual([2, 7]);
  });

  it('rejects a seq that is not a safe integer', () => {
    const state = initialRunState();

    expect(reduce(state, event(Number.NaN, 'run.created'))).toBe(state);
    expect(reduce(state, event(1.5, 'run.created'))).toBe(state);
    expect(reduce(state, event(Number.POSITIVE_INFINITY, 'run.created'))).toBe(state);
  });

  it('tracks the stage from stage.started and stage.finished', () => {
    const started = fold([event(1, 'stage.started', { stage: 'S1' })]);
    expect(started.stage).toBe('S1');

    const moved = fold(
      [event(2, 'stage.finished', { stage: 'S1' }), event(3, 'stage.started', { stage: 'S2' })],
      started,
    );
    expect(moved.stage).toBe('S2');
  });

  it('ignores a stage payload without a usable stage name', () => {
    const state = fold([event(1, 'stage.started', { index: 0 })]);

    expect(state.stage).toBeNull();
  });

  it('marks a run as running when it is created', () => {
    const state = fold([event(1, 'run.created', { idea: 'a' })]);
    expect(state.status).toBe('running');
    expect(state.terminal).toBe(false);
  });

  it('reports run.failed with its code and freezes the verdict', () => {
    const failed = fold([event(1, 'run.failed', { code: 'LLM_UNAVAILABLE' })]);

    expect(failed.status).toBe('failed');
    expect(failed.terminal).toBe(true);
    expect(failed.error).toBe('LLM_UNAVAILABLE');

    const after = reduce(failed, event(2, 'run.finished', { status: 'finished' }));
    expect(after.status).toBe('failed');
    expect(after.terminal).toBe(true);
    expect(after.error).toBe('LLM_UNAVAILABLE');
    expect(after.events).toHaveLength(2);
  });

  it('marks a run as finished on run.finished', () => {
    const state = fold([event(1, 'run.finished')]);

    expect(state.status).toBe('finished');
    expect(state.terminal).toBe(true);
  });

  it('honours a terminal status carried by run.finished', () => {
    const state = fold([event(1, 'run.finished', { status: 'cancelled' })]);

    expect(state.status).toBe('cancelled');
    expect(state.terminal).toBe(true);
  });

  it('treats a terminal status on any event type as final', () => {
    const state = fold([event(1, 'run.updated', { status: 'cancelled' })]);

    expect(state.status).toBe('cancelled');
    expect(state.terminal).toBe(true);
    expect(state.events).toHaveLength(1);
  });

  it('applies a non-terminal status without ending the run', () => {
    const paused = reduce(initialRunState(), event(1, 'run.updated', { status: 'paused' }));

    expect(paused.status).toBe('paused');
    expect(paused.terminal).toBe(false);
  });

  it('ignores an unknown status string', () => {
    const state = reduce(initialRunState(), event(1, 'run.updated', { status: 'thinking' }));

    expect(state.status).toBe('idle');
    expect(state.terminal).toBe(false);
  });

  it('retains only the latest events while the cursor keeps moving forward', () => {
    const total = MAX_RETAINED_EVENTS + 5;
    const state = fold(
      Array.from({ length: total }, (_, index) => event(index + 1, 'stage.progress', { index })),
    );

    expect(state.lastSeq).toBe(total);
    expect(state.events).toHaveLength(MAX_RETAINED_EVENTS);
    expect(state.events[0]?.seq).toBe(6);
    expect(state.events.at(-1)?.seq).toBe(total);

    // A trimmed event must not be replayed just because it fell out of the buffer.
    const replayed = reduce(state, event(1, 'stage.progress'));
    expect(replayed).toBe(state);
    expect(replayed.lastSeq).toBe(total);
  });
});

describe('initialRunState', () => {
  it('starts idle with no history', () => {
    expect(initialRunState()).toEqual({
      lastSeq: 0,
      events: [],
      stage: null,
      status: 'idle',
      terminal: false,
      error: null,
    });
  });

  it('folds a shuffled snapshot in seq order', () => {
    const state = initialRunState([
      event(3, 'stage.started', { stage: 'S2' }),
      event(1, 'run.created'),
      event(2, 'stage.finished', { stage: 'S1' }),
    ]);

    expect(state.events.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(state.lastSeq).toBe(3);
    expect(state.stage).toBe('S2');
    expect(state.status).toBe('running');
  });

  it('keeps a terminal snapshot terminal so the hook does not reconnect', () => {
    const state = initialRunState([
      event(1, 'run.created'),
      event(2, 'run.finished', { status: 'finished' }),
    ]);

    expect(state.status).toBe('finished');
    expect(state.terminal).toBe(true);
  });

  it('trims an oversized snapshot to the retained window', () => {
    const total = MAX_RETAINED_EVENTS + 10;
    const state = initialRunState(
      Array.from({ length: total }, (_, index) => event(index + 1, 'stage.progress')),
    );

    expect(state.events).toHaveLength(MAX_RETAINED_EVENTS);
    expect(state.lastSeq).toBe(total);
  });
});
