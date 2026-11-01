'use client';

import { Check, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useRunStream } from '@/lib/hooks/use-run-stream';
import type { RunEvent, RunStateSeed, RunStreamState } from '@/lib/runs/event-reducer';
import { RUN_STAGES, STATUS_META, stageLabel, stageMark } from '@/lib/runs/stages';
import { cn } from '@/lib/utils/cn';

export type RunActivityProps = {
  /** `null` until the operator confirms the approval card. */
  runId: number | null;
  /** First-paint snapshot from the RSC, oldest first. */
  initialEvents?: RunEvent[];
  /**
   * The run row's own status/stage. The event log alone would read a queued run
   * as running (its first event is `run.created`), and a run whose log was
   * trimmed would lose its verdict.
   */
  status?: string | undefined;
  stage?: string | null | undefined;
  /** False when the worker heartbeat is stale; a queued run then will not start. */
  workerOnline?: boolean | undefined;
};

/**
 * The run, told on the assistant side of the transcript. The rail is a monitor
 * an operator opens on purpose; this card is the answer's own footnote, so it
 * only shows while there is something to say and folds back to a single line
 * once the run is over.
 */
export function RunActivity({
  runId,
  initialEvents = [],
  status,
  stage,
  workerOnline = true,
}: RunActivityProps) {
  if (runId === null) return null;
  return (
    <LiveRunActivity
      key={runId}
      runId={runId}
      initialEvents={initialEvents}
      seed={{ status, stage }}
      workerOnline={workerOnline}
    />
  );
}

function LiveRunActivity({
  runId,
  initialEvents,
  seed,
  workerOnline,
}: {
  runId: number;
  initialEvents: RunEvent[];
  seed: RunStateSeed;
  workerOnline: boolean;
}) {
  const { state } = useRunStream(runId, initialEvents, seed);

  const stalled = !workerOnline && state.status === 'queued';
  const failed = state.terminal && state.status === 'failed';

  // Finished / cancelled keep the one-line summary. A failure keeps the card:
  // the stage that died and its code are the whole point of showing it inline.
  if (state.terminal && !failed) return <TerminalLine state={state} />;

  // Queued with nothing logged yet: an empty card would be a promise the page
  // cannot keep — unless no worker is running, which the card must explain.
  if (state.events.length === 0 && !state.terminal && !stalled) return null;

  const progress = stageProgress(state);
  const activity = recentActivity(state.events);

  return (
    <div
      role="group"
      aria-label="实时研究"
      className={cn(
        'rounded-xl border px-3.5 py-3',
        failed ? 'border-danger/40 bg-danger-soft/30' : 'border-border bg-surface-2/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          {!state.terminal ? (
            <span
              aria-hidden="true"
              className="inline-block size-1.5 animate-pulse rounded-full bg-accent"
            />
          ) : null}
          实时研究
        </span>
        <Badge tone={STATUS_META[state.status].tone}>{STATUS_META[state.status].label}</Badge>
      </div>

      <ol aria-label="研究阶段" className="mt-2.5 flex flex-wrap items-center gap-1">
        {RUN_STAGES.map((stage, index) => {
          const mark = stageMark(index, state);
          return (
            <li
              key={stage.id}
              aria-current={mark === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px]',
                mark === 'done' && 'text-muted',
                mark === 'current' && 'bg-accent-soft font-semibold text-accent',
                mark === 'failed' && 'bg-danger-soft font-semibold text-danger',
                mark === 'pending' && 'text-faint',
              )}
            >
              {mark === 'done' ? <Check className="size-3" aria-hidden="true" /> : null}
              {mark === 'failed' ? <X className="size-3" aria-hidden="true" /> : null}
              {stage.label}
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[11.5px] text-muted">
        当前阶段：{stageLabel(state.stage) ?? (stalled ? '等待 worker 启动' : '等待开始')}
      </p>

      {progress !== null ? <p className="mt-1 text-[11.5px] text-muted">{progress}</p> : null}

      {failed && state.error !== null ? (
        <p className="mt-2 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11.5px] leading-5 text-danger">
          失败原因：{state.error}
        </p>
      ) : null}

      {stalled ? (
        <p className="mt-2 rounded-lg border border-warning/40 bg-warning-soft px-2.5 py-2 text-[11.5px] leading-5 text-warning">
          worker 未运行，任务不会自动开始。请在终端执行{' '}
          <code className="font-mono">pnpm worker</code>（或{' '}
          <code className="font-mono">pnpm dev:all</code>）。
        </p>
      ) : null}

      {activity.length > 0 && (
        <ul aria-label="最近查询与来源" className="mt-2.5 flex flex-col gap-1">
          {activity.map((event) => (
            <li
              key={event.seq}
              className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted"
            >
              <span className="shrink-0 font-mono text-[10.5px] text-faint">#{event.seq}</span>
              <span className="truncate" title={describe(event)}>
                {describe(event)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line for a run that is over: what it produced, and how it ended. */
function TerminalLine({ state }: { state: RunStreamState }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/40 px-3.5 py-2 text-xs text-muted">
      <span aria-hidden="true" className="inline-block size-1.5 shrink-0 rounded-full bg-muted" />
      <span className="min-w-0 truncate">{runSummary(state)}</span>
    </div>
  );
}

function runSummary(state: RunStreamState): string {
  if (state.status === 'failed') {
    return state.error === null ? '研究失败' : `研究失败：${state.error}`;
  }
  if (state.status === 'cancelled') return '研究已取消';
  if (state.status !== 'finished') return '研究已结束';

  const finished = lastEvent(state.events, (event) => event.type === 'run.finished');
  const evidence = numberField(finished?.payload, 'accepted');
  const ready = lastEvent(state.events, (event) => event.type === 'report.ready');
  const decision = stringField(ready?.payload, 'decision');

  const head = evidence === null ? '研究完成' : `研究完成：${evidence} 条证据`;
  return decision === null ? head : `${head} · 决策 ${decision}`;
}

/**
 * The newest `stage.progress` of the stage the run is on. Progress from an
 * earlier stage is stale the moment the worker moves on, so it is not shown
 * next to a stage it does not describe.
 */
function stageProgress(state: RunStreamState): string | null {
  const progress = lastEvent(
    state.events,
    (event) =>
      event.type === 'stage.progress' &&
      (state.stage === null || event.payload.stage === state.stage),
  );
  if (progress === undefined) return null;

  const done = numberField(progress.payload, 'done');
  const total = numberField(progress.payload, 'total');
  if (done === null || total === null) return null;

  const counters: string[] = [`已处理 ${done}/${total}`];
  const accepted = numberField(progress.payload, 'accepted');
  const rejected = numberField(progress.payload, 'rejected');
  const sources = numberField(progress.payload, 'sources');
  if (accepted !== null) counters.push(`接受 ${accepted}`);
  if (rejected !== null) counters.push(`拒绝 ${rejected}`);
  if (sources !== null) counters.push(`新来源 ${sources}`);

  return counters.join(' · ');
}

/** The last five activity events, oldest first, so new lines land at the bottom. */
function recentActivity(events: readonly RunEvent[]): RunEvent[] {
  return events
    .filter(
      (event) =>
        event.type.startsWith('query.') ||
        event.type === 'source.added' ||
        event.type === 'cluster.created',
    )
    .slice(-5);
}

function describe(event: RunEvent): string {
  const payload = event.payload;

  if (event.type === 'source.added') {
    const platform = stringField(payload, 'platform') ?? '来源';
    const title = stringField(payload, 'title') ?? stringField(payload, 'url') ?? '';
    const duplicate = payload.duplicate === true ? '（重复）' : '';
    return `采集 ${platform} · ${title}${duplicate}`;
  }

  if (event.type === 'cluster.created') {
    const name = stringField(payload, 'name') ?? '未命名方向';
    const independent = numberField(payload, 'independentSources');
    return independent === null ? `聚类 ${name}` : `聚类 ${name} · ${independent} 个独立来源`;
  }

  if (event.type === 'query.failed') {
    const query = stringField(payload, 'query') ?? '';
    const message = stringField(payload, 'message') ?? '未知错误';
    return `查询失败 ${query} · ${message}`;
  }

  if (event.type === 'query.fallback') {
    const query = stringField(payload, 'query') ?? '';
    const providers = Array.isArray(payload.providers)
      ? payload.providers.filter((value): value is string => typeof value === 'string').join('/')
      : '兜底';
    return `查询回退 ${query} · ${providers}`;
  }

  if (event.type === 'query.unrecorded') {
    return `查询未入库 ${stringField(payload, 'query') ?? ''}`;
  }

  return event.type;
}

function lastEvent(
  events: readonly RunEvent[],
  match: (event: RunEvent) => boolean,
): RunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && match(event)) return event;
  }
  return undefined;
}

function numberField(payload: Record<string, unknown> | undefined, key: string): number | null {
  const value = payload?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
