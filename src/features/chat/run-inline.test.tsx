import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRunState, type RunEvent, type RunStateSeed } from '@/lib/runs/event-reducer';

import { RunInlineProgress } from './run-inline';

const mocks = vi.hoisted(() => ({ useRunStream: vi.fn() }));

vi.mock('@/lib/hooks/use-run-stream', () => ({ useRunStream: mocks.useRunStream }));

const CREATED: RunEvent = { seq: 1, type: 'run.created', payload: {} };
const PROGRESS: RunEvent = {
  seq: 2,
  type: 'stage.progress',
  payload: { stage: 'S1', done: 12, total: 40, sources: 5 },
};
const QUERY_FAILED: RunEvent = {
  seq: 3,
  type: 'query.failed',
  payload: { stage: 'S1', query: '库存同步', message: '429' },
};

beforeEach(() => {
  mocks.useRunStream.mockImplementation(
    (_id: number, events: RunEvent[] = [], seed: RunStateSeed = {}) => ({
      state: initialRunState(events, seed),
      connected: true,
      retries: 0,
    }),
  );
});

describe('RunInlineProgress', () => {
  it('streams the current stage and the newest query failures', () => {
    render(
      <RunInlineProgress
        runId={7}
        events={[CREATED, PROGRESS, QUERY_FAILED]}
        status="running"
        stage="S1"
      />,
    );

    const line = screen.getByRole('status', { name: '研究进度 run #7' });
    expect(line).toHaveTextContent('S1 采集');
    expect(line).toHaveTextContent('查询失败 库存同步 · 429');
  });

  it('folds to one line once the run is over', () => {
    render(
      <RunInlineProgress
        runId={7}
        events={[
          CREATED,
          { seq: 2, type: 'run.finished', payload: { status: 'finished', accepted: 6 } },
        ]}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('run #7');
    expect(screen.getByRole('status')).toHaveTextContent('6 条证据');
  });

  it('explains a stalled queued run when the worker is offline', () => {
    render(
      <RunInlineProgress
        runId={7}
        events={[CREATED]}
        status="queued"
        stage="S0"
        workerOnline={false}
      />,
    );

    expect(screen.getByText(/worker 未运行/)).toBeVisible();
  });

  it('renders nothing for a queued run with no events while the worker is online', () => {
    const { container } = render(<RunInlineProgress runId={7} events={[]} status="queued" />);
    expect(container.firstChild).toBeNull();
  });

  it('asks for the transcript once when a live run settles', () => {
    const onSettled = vi.fn();
    const { rerender } = render(
      <RunInlineProgress runId={7} events={[CREATED]} status="running" onSettled={onSettled} />,
    );
    expect(onSettled).not.toHaveBeenCalled();

    rerender(
      <RunInlineProgress
        runId={7}
        events={[CREATED, { seq: 2, type: 'run.finished', payload: { status: 'finished' } }]}
        onSettled={onSettled}
      />,
    );

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not reload for a run that was already over on first paint', () => {
    const onSettled = vi.fn();

    render(
      <RunInlineProgress
        runId={7}
        events={[CREATED, { seq: 2, type: 'run.finished', payload: { status: 'finished' } }]}
        onSettled={onSettled}
      />,
    );

    expect(onSettled).not.toHaveBeenCalled();
  });
});
