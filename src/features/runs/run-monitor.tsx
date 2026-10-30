'use client';

import { useMemo } from 'react';

import { useRunStream } from '@/lib/hooks/use-run-stream';
import type { RunEvent } from '@/lib/runs/event-reducer';
import type { RecentSourceEvent, SourceEventSummary } from '@/lib/runs/sources-repository';
import { connectionLabel } from '@/lib/runs/stages';
import { cn } from '@/lib/utils/cn';

import { DegradationBanner } from './degradation-banner';
import { FailuresPanel, type FailureItem } from './failures-panel';
import { StageStepper } from './stage-stepper';

const SOURCE_EVENT_TYPES: Readonly<Record<string, true>> = {
  'source.needs_human': true,
  'source.failed': true,
  'source.skipped': true,
};

export interface RunMonitorProps {
  runId: number;
  /** Newest page of the event log, oldest first. */
  initialEvents: RunEvent[];
  initialStatus: string;
  initialStage: string | null;
  initialError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  deadlineAt: Date | null;
  initialSummary: SourceEventSummary;
  initialFailures: readonly RecentSourceEvent[];
  serverNow: number;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bumpReason(
  reasons: SourceEventSummary['reasons'],
  reason: string,
): SourceEventSummary['reasons'] {
  const counts = new Map(reasons.map((item) => [item.reason, item.count]));
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => ({ reason: key, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

/**
 * Add one SSE event to the first-paint summary. Only events after the snapshot
 * are folded, so the server's totals are never counted twice.
 */
function applySourceEvent(summary: SourceEventSummary, event: RunEvent): SourceEventSummary {
  const payload = event.payload;

  if (event.type === 'source.skipped') {
    return {
      ...summary,
      skipped: summary.skipped + 1,
      reasons: bumpReason(summary.reasons, stringField(payload, 'reason') ?? 'unknown'),
    };
  }
  if (event.type === 'source.failed') {
    return { ...summary, failed: summary.failed + 1 };
  }
  if (event.type === 'source.needs_human') {
    return { ...summary, needsHuman: summary.needsHuman + 1 };
  }
  if (event.type === 'stage.capped') {
    return {
      ...summary,
      capped: true,
      cappedMaxPages: numberField(payload, 'maxPages') ?? summary.cappedMaxPages,
    };
  }

  return summary;
}

function toFailureItem(event: RunEvent): FailureItem {
  const payload = event.payload;
  return {
    key: `seq-${event.seq}`,
    type: event.type,
    url: stringField(payload, 'url'),
    platform: stringField(payload, 'platform'),
    reason: stringField(payload, 'reason') ?? stringField(payload, 'code'),
    createdAt: null,
  };
}

function summarizePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '—';

  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : (JSON.stringify(value) ?? '—');
      return `${key}: ${rendered}`;
    })
    .join(' · ')
    .slice(0, 96);
}

/**
 * Live half of the monitor page. The RSC renders the first paint; this island
 * keeps the stage, the failure counts and the event list current. The server
 * snapshot is the newest page of the log, so the SSE cursor starts at its last
 * seq and only new events are folded in.
 */
export function RunMonitor({
  runId,
  initialEvents,
  initialStatus,
  initialStage,
  initialError,
  startedAt,
  finishedAt,
  deadlineAt,
  initialSummary,
  initialFailures,
  serverNow,
}: RunMonitorProps) {
  const { state, connected, retries } = useRunStream(runId, initialEvents, {
    status: initialStatus,
    stage: initialStage,
  });

  const initialLastSeq = initialEvents.at(-1)?.seq ?? 0;

  const liveEvents = useMemo(
    () => state.events.filter((event) => event.seq > initialLastSeq),
    [state.events, initialLastSeq],
  );

  const summary = useMemo(
    () => liveEvents.reduce(applySourceEvent, initialSummary),
    [liveEvents, initialSummary],
  );

  const failures = useMemo(() => {
    const live = liveEvents
      .filter((event) => SOURCE_EVENT_TYPES[event.type] === true)
      .map(toFailureItem)
      .reverse();

    const initial = initialFailures.map((item) => ({
      key: `event-${item.eventId}`,
      type: item.type,
      url: item.url,
      platform: item.platform,
      reason: item.reason,
      createdAt: item.createdAt,
    }));

    return [...live, ...initial].slice(0, 10);
  }, [liveEvents, initialFailures]);

  return (
    <div className="flex flex-col gap-4">
      <DegradationBanner
        status={state.status}
        summary={summary}
        error={state.error ?? initialError}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StageStepper
          state={state}
          startedAt={startedAt}
          finishedAt={finishedAt}
          deadlineAt={deadlineAt}
          serverNow={serverNow}
        />
        <FailuresPanel summary={summary} items={failures} />
      </div>

      <section
        aria-labelledby="run-events-heading"
        className="rounded-xl border border-border bg-surface p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="run-events-heading" className="text-sm font-semibold text-fg">
            最近事件
          </h2>
          <span className="text-xs text-muted tabular-nums">共 {state.lastSeq} 条事件</span>
        </div>

        {state.events.length === 0 ? (
          <p className="mt-3 text-sm text-muted">还没有事件。</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {state.events
              .slice(-12)
              .reverse()
              .map((event) => (
                <li key={event.seq} className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
                  <span className="w-10 shrink-0 text-right text-faint tabular-nums">
                    #{event.seq}
                  </span>
                  <span className="shrink-0 font-mono text-fg">{event.type}</span>
                  <span className="truncate text-faint" title={summarizePayload(event.payload)}>
                    {summarizePayload(event.payload)}
                  </span>
                </li>
              ))}
          </ul>
        )}

        <p className="mt-3 flex items-center gap-1.5 border-t border-border pt-3 text-[11px] text-muted">
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-1.5 rounded-full',
              state.terminal ? 'bg-muted' : connected ? 'bg-success' : 'bg-warning',
            )}
          />
          {connectionLabel(state, connected, retries)}
        </p>
      </section>
    </div>
  );
}
