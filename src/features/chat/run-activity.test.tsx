import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initialRunState, type RunEvent, type RunStateSeed } from '@/lib/runs/event-reducer';

import { RunActivity } from './run-activity';

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

const CREATED: RunEvent = { seq: 1, type: 'run.created', payload: { idea: '库存同步' } };
const S1_STARTED: RunEvent = { seq: 2, type: 'stage.started', payload: { stage: 'S1' } };
const S1_PROGRESS: RunEvent = {
  seq: 3,
  type: 'stage.progress',
  payload: { stage: 'S1', done: 12, total: 40, sources: 5 },
};
const SOURCE_ADDED: RunEvent = {
  seq: 4,
  type: 'source.added',
  payload: { stage: 'S1', platform: 'V2EX', title: '手工对账帖子', url: 'https://v2ex.com/t/1' },
};
const QUERY_FAILED: RunEvent = {
  seq: 5,
  type: 'query.failed',
  payload: { stage: 'S1', query: '库存同步 价格', message: '429' },
};

describe('RunActivity', () => {
  it('renders nothing without a run', () => {
    const { container } = render(<RunActivity runId={null} initialEvents={[]} />);

    expect(container.firstChild).toBeNull();
    expect(mocks.useRunStream).not.toHaveBeenCalled();
  });

  it('renders nothing for a queued run with no events yet', () => {
    const { container } = render(<RunActivity runId={7} initialEvents={[]} />);

    expect(container.firstChild).toBeNull();
  });

  it('shows the current stage and the latest progress counts', () => {
    render(<RunActivity runId={7} initialEvents={[CREATED, S1_STARTED, S1_PROGRESS]} />);

    const card = screen.getByRole('group', { name: '研究进度' });
    expect(card).toHaveTextContent('S1 采集');
    expect(card).toHaveTextContent('已处理 12/40 · 新来源 5');
    expect(card).toHaveTextContent('进行中');
  });

  it('lists the newest queries and stored sources, five at most', () => {
    const extra: RunEvent[] = Array.from({ length: 4 }, (_, index) => ({
      seq: 10 + index,
      type: 'cluster.created',
      payload: { stage: 'S3', name: `方向${index}`, independentSources: index + 1 },
    }));

    render(
      <RunActivity
        runId={7}
        initialEvents={[CREATED, S1_STARTED, S1_PROGRESS, SOURCE_ADDED, QUERY_FAILED, ...extra]}
      />,
    );

    const items = screen.getByRole('list', { name: '最近活动' }).querySelectorAll('li');
    expect(items).toHaveLength(5);
    // Six activity events exist; the oldest is gone, the newest five remain.
    expect(screen.queryByText('采集 V2EX · 手工对账帖子')).toBeNull();
    expect(screen.getByText('查询失败 库存同步 价格 · 429')).toBeVisible();
    expect(screen.getByText('聚类 方向0 · 1 个独立来源')).toBeVisible();
  });

  it('folds to one summary line when the run finishes', () => {
    render(
      <RunActivity
        runId={7}
        initialEvents={[
          CREATED,
          S1_STARTED,
          S1_PROGRESS,
          {
            seq: 6,
            type: 'report.ready',
            payload: { reportId: 3, decision: '建议先验证，再开发' },
          },
          { seq: 7, type: 'run.finished', payload: { status: 'finished', accepted: 12 } },
        ]}
      />,
    );

    expect(screen.queryByRole('group', { name: '研究进度' })).toBeNull();
    expect(screen.getByText('研究完成：12 条证据 · 决策 建议先验证，再开发')).toBeVisible();
  });

  it('takes the queued verdict from the run row, not from run.created', () => {
    render(<RunActivity runId={7} initialEvents={[CREATED]} status="queued" stage="S0" />);

    const card = screen.getByRole('group', { name: '研究进度' });
    expect(card).toHaveTextContent('排队中');
    expect(card).toHaveTextContent('S0 检索角度');
    expect(card).not.toHaveTextContent('进行中');
  });

  it('folds to the summary line when the row is finished even without its terminal event', () => {
    render(<RunActivity runId={7} initialEvents={[CREATED]} status="finished" stage="S2" />);

    expect(screen.queryByRole('group', { name: '研究进度' })).toBeNull();
    expect(screen.getByText('研究完成')).toBeVisible();
  });

  it('says how a failed run ended', () => {
    render(
      <RunActivity
        runId={7}
        initialEvents={[
          CREATED,
          S1_STARTED,
          { seq: 3, type: 'run.failed', payload: { code: 'SEARCH_UNAVAILABLE' } },
        ]}
      />,
    );

    expect(screen.getByText('研究失败：SEARCH_UNAVAILABLE')).toBeVisible();
  });
});
