import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StageStepper } from './stage-stepper';

const STARTED_AT = new Date('2026-10-30T10:00:00.000Z');
const DEADLINE_AT = new Date('2026-10-30T11:30:00.000Z');
const SERVER_NOW = Date.parse('2026-10-30T10:30:00.000Z');

const BASE = {
  startedAt: STARTED_AT,
  finishedAt: null,
  deadlineAt: DEADLINE_AT,
  serverNow: SERVER_NOW,
} as const;

function stageItem(label: string): HTMLElement {
  // The "当前阶段" line repeats the label, so scope the lookup to the stepper list.
  const item = within(screen.getByRole('list')).getByText(label).closest('li');
  if (item === null) throw new Error(`stage item not found: ${label}`);
  return item;
}

describe('StageStepper', () => {
  it('marks the current stage with aria-current', () => {
    render(<StageStepper state={{ stage: 'S1', status: 'running', terminal: false }} {...BASE} />);

    expect(stageItem('S1 采集')).toHaveAttribute('aria-current', 'step');
    expect(stageItem('S0 检索角度')).not.toHaveAttribute('aria-current');
    expect(stageItem('S2 抽取')).not.toHaveAttribute('aria-current');
  });

  it('does not highlight any stage when the stage id is unknown', () => {
    render(<StageStepper state={{ stage: 'S9', status: 'running', terminal: false }} {...BASE} />);

    for (const item of screen.getAllByRole('listitem')) {
      expect(item).not.toHaveAttribute('aria-current');
    }
    expect(screen.getByText('S9')).toBeVisible();
  });

  it('shows elapsed time and the deadline-based remaining estimate', () => {
    render(<StageStepper state={{ stage: 'S1', status: 'running', terminal: false }} {...BASE} />);

    expect(screen.getByText(/已运行 30 分钟/)).toHaveTextContent(
      '已运行 30 分钟 · 预计剩余不超过 1 小时',
    );
  });

  it('shows the measured duration once the run is terminal', () => {
    render(
      <StageStepper
        state={{ stage: 'S6', status: 'finished', terminal: true }}
        {...BASE}
        finishedAt={new Date('2026-10-30T10:30:00.000Z')}
      />,
    );

    expect(screen.getByText(/本轮已结束，耗时 30 分钟/)).toBeVisible();
    expect(stageItem('S6 自检')).toHaveAttribute('data-mark', 'done');
    expect(stageItem('S6 自检')).not.toHaveAttribute('aria-current');
  });
});
