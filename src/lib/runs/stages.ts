/**
 * Stage vocabulary shared by the chat rail and the run monitor. Both pages
 * fold the same event log, so the labels, the "current step" rule and the
 * disconnect copy must not drift apart.
 */
import type { RunStatus, RunStreamState } from './event-reducer';

/** The pipeline stages, named as the worker and the report describe them. */
export const RUN_STAGES = [
  { id: 'S0', label: 'S0 检索角度' },
  { id: 'S1', label: 'S1 采集' },
  { id: 'S2', label: 'S2 抽取' },
  { id: 'S3', label: 'S3 聚类' },
  { id: 'S4', label: 'S4 评级' },
  { id: 'S5', label: 'S5 报告' },
  { id: 'S6', label: 'S6 自检' },
] as const;

/** Reconnect budget; also the threshold for the "disconnected" message. */
export const MAX_RETRIES = 5;

export const STATUS_META: Record<
  RunStatus,
  { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }
> = {
  idle: { label: '等待中', tone: 'neutral' },
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '进行中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'warning' },
  finished: { label: '已完成', tone: 'success' },
  failed: { label: '已失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'danger' },
};

export type StageMark = 'done' | 'current' | 'failed' | 'pending';

/**
 * Stages before the current one are done because the worker moves forward
 * only; a terminal run marks its last stage finished or failed and leaves the
 * rest pending rather than pretending they ran.
 */
export function stageMark(
  index: number,
  state: Pick<RunStreamState, 'stage' | 'status' | 'terminal'>,
): StageMark {
  const current = RUN_STAGES.findIndex((stage) => stage.id === state.stage);
  if (current === -1) return 'pending';

  if (state.terminal) {
    if (index < current) return 'done';
    if (index === current) return state.status === 'finished' ? 'done' : 'failed';
    return 'pending';
  }

  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'pending';
}

/** The stage's display label, or `null` when no stage has started yet. */
export function stageLabel(stage: string | null): string | null {
  if (stage === null) return null;
  return RUN_STAGES.find((item) => item.id === stage)?.label ?? stage;
}

export function connectionLabel(
  state: Pick<RunStreamState, 'terminal'>,
  connected: boolean,
  retries: number,
): string {
  if (state.terminal) return '已结束';
  if (connected) return '实时连接';
  if (retries >= MAX_RETRIES) return '连接已断开，请刷新页面';
  if (retries > 0) return `重连中（第 ${retries} 次）`;
  return '未连接';
}
