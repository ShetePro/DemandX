/**
 * Pure fold over the run event log. The server is the source of truth; this
 * reducer only projects already-persisted events into renderable state, so the
 * same sequence replayed after a reconnect lands on the same state.
 */

/** One event as it arrives from the stream (or from the first-paint snapshot). */
export type RunEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
};

export type RunStatus =
  'idle' | 'queued' | 'running' | 'paused' | 'finished' | 'failed' | 'cancelled';

export type RunStreamState = {
  lastSeq: number;
  events: RunEvent[];
  stage: string | null;
  status: RunStatus;
  terminal: boolean;
  error: string | null;
};

/**
 * Keep enough history to re-render the run timeline without letting a long
 * run grow the client's memory without bound. `lastSeq` still tracks the whole
 * log, so trimming never causes an event to be replayed.
 */
export const MAX_RETAINED_EVENTS = 300;

const RUN_STATUSES: readonly RunStatus[] = [
  'idle',
  'queued',
  'running',
  'paused',
  'finished',
  'failed',
  'cancelled',
];

/** Statuses after which the stream has nothing more to deliver. */
const TERMINAL_STATUSES: Readonly<Record<string, true>> = {
  finished: true,
  failed: true,
  cancelled: true,
};

function emptyState(): RunStreamState {
  return {
    lastSeq: 0,
    events: [],
    stage: null,
    status: 'idle',
    terminal: false,
    error: null,
  };
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}

function isTerminalStatus(value: unknown): value is RunStatus {
  return isRunStatus(value) && TERMINAL_STATUSES[value] === true;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Fold one event into the state. Returns the same object when the event is not
 * newer than the cursor, so a duplicate frame does not re-render the tree.
 */
export function reduce(state: RunStreamState, event: RunEvent): RunStreamState {
  if (!Number.isSafeInteger(event.seq) || event.seq <= state.lastSeq) return state;

  const events = [...state.events, event].slice(-MAX_RETAINED_EVENTS);
  const appended: RunStreamState = { ...state, lastSeq: event.seq, events };

  // A terminal run never changes its verdict again; late frames are recorded
  // but cannot flip the status back or clear the error.
  if (state.terminal) return appended;

  const payload = event.payload;
  let stage = state.stage;
  let status: RunStatus = state.status;
  let terminal: boolean = state.terminal;
  let error = state.error;

  // Stage events describe one step of the pipeline. `stage.finished` also
  // carries a `status`, but that is the *stage's* status and says nothing
  // about whether the run is over. Only updating `stage` here keeps an
  // intermediate stage from ending the stream.
  if (event.type.startsWith('stage.')) {
    stage = stringField(payload, 'stage') ?? stage;
    return { ...appended, stage };
  }

  if (event.type === 'run.failed') {
    status = 'failed';
    terminal = true;
    error = stringField(payload, 'code') ?? error;
  } else if (event.type === 'run.finished') {
    status = isTerminalStatus(payload.status) ? payload.status : 'finished';
    terminal = true;
    if (status === 'failed') error = stringField(payload, 'code') ?? error;
  } else {
    // Run-level updates name the run status explicitly (`runStatus`), so a
    // nested `status` field can never be mistaken for the run's verdict.
    const runStatus = payload.runStatus;

    if (isTerminalStatus(runStatus)) {
      status = runStatus;
      terminal = true;
      error = stringField(payload, 'code') ?? error;
    } else if (event.type === 'run.created') {
      status = 'running';
    } else if (isRunStatus(runStatus)) {
      status = runStatus;
    }
  }

  return { ...appended, stage, status, terminal, error };
}

/**
 * Project one server snapshot (oldest first) into state. The input is copied
 * and sorted because a snapshot assembled with an unstable order must still
 * fold in `seq` order.
 */
export function initialRunState(initial: readonly RunEvent[] = []): RunStreamState {
  return [...initial].sort((left, right) => left.seq - right.seq).reduce(reduce, emptyState());
}
