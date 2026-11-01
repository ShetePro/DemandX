import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRunState, type RunEvent, type RunStateSeed } from '@/lib/runs/event-reducer';

import { RunRail } from './run-rail';

const mocks = vi.hoisted(() => ({ useRunStream: vi.fn() }));

vi.mock('@/lib/hooks/use-run-stream', () => ({ useRunStream: mocks.useRunStream }));

beforeEach(() => {
  mocks.useRunStream.mockImplementation(
    (_runId: number, initialEvents: RunEvent[] = [], seed: RunStateSeed = {}) => ({
      state: initialRunState(initialEvents, seed),
      connected: true,
      retries: 0,
    }),
  );
});

const RUN_CREATED: RunEvent = { seq: 1, type: 'run.created', payload: { idea: '库存同步' } };
const S1_STARTED: RunEvent = { seq: 2, type: 'stage.started', payload: { stage: 'S1' } };

function stageItem(label: string): HTMLElement {
  const item = screen.getByText(label).closest('li');
  if (item === null) throw new Error(`stage item not found: ${label}`);
  return item;
}

describe('RunRail', () => {
  it('shows the empty state and no stages before a run exists', () => {
    render(<RunRail runId={null} />);

    expect(screen.getByText('尚未开始研究')).toBeVisible();
    expect(screen.queryByText('S0 检索角度')).not.toBeInTheDocument();
    expect(screen.queryByText('S1 采集')).not.toBeInTheDocument();
  });

  it('marks the live stage from the initial snapshot and counts its events', () => {
    render(<RunRail runId={7} initialEvents={[RUN_CREATED, S1_STARTED]} />);

    expect(stageItem('S1 采集')).toHaveAttribute('aria-current', 'step');
    expect(stageItem('S0 检索角度')).not.toHaveAttribute('aria-current');

    expect(screen.getByText('共 2 条事件')).toBeVisible();
    expect(screen.getByText('run.created')).toBeVisible();
    expect(screen.getByText('stage.started')).toBeVisible();
    expect(screen.getByText('进行中')).toBeVisible();
  });

  it('shows the terminal state instead of a live stage', () => {
    render(
      <RunRail
        runId={7}
        initialEvents={[
          RUN_CREATED,
          S1_STARTED,
          { seq: 3, type: 'run.finished', payload: { status: 'finished' } },
        ]}
      />,
    );

    expect(screen.getByText('已完成')).toBeVisible();
    expect(stageItem('S1 采集')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('已结束')).toBeVisible();
  });

  it('warns that a queued run will not start while the worker is offline', () => {
    render(<RunRail runId={7} runStatus="queued" runStage="S0" workerOnline={false} />);

    expect(screen.getByText(/worker 未运行/)).toBeVisible();
  });

  it('stays quiet about the worker when the heartbeat is fresh', () => {
    render(<RunRail runId={7} runStatus="queued" runStage="S0" workerOnline />);

    expect(screen.queryByText(/worker 未运行/)).toBeNull();
  });
});
