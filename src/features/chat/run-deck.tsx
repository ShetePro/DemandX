'use client';

import type { RunEvent } from '@/lib/runs/event-reducer';

import { cn } from '@/lib/utils/cn';

import { RunActivity } from './run-activity';

export interface RunDeckItem {
  id: number;
  status?: string | undefined;
  stage?: string | null | undefined;
  events: RunEvent[];
}

export interface RunDeckProps {
  runs: readonly RunDeckItem[];
  workerOnline?: boolean | undefined;
}

/**
 * Right-side run deck: every research run is a card, newest on top, cards
 * overlap like a hand of cards. Hovering raises and expands one card without
 * pushing the transcript around, which keeps the chat column stable while a
 * run streams.
 */
export function RunDeck({ runs, workerOnline = true }: RunDeckProps) {
  if (runs.length === 0) {
    return (
      <p className="px-3 py-4 text-[11px] leading-5 text-faint">
        还没有研究记录。发起研究后，每次运行都会在这里生成一张卡片。
      </p>
    );
  }

  const ordered = [...runs].reverse();

  return (
    <div aria-label="研究卡片" className="group/deck flex flex-col pb-4">
      {ordered.map((run, index) => (
        <div
          key={run.id}
          className={cn(
            'group/card relative -mt-4 transition-opacity first:mt-0 focus-within:z-30 hover:z-30',
            'group-hover/deck:opacity-60 focus-within:opacity-100 hover:opacity-100',
          )}
          style={{ zIndex: ordered.length - index }}
        >
          <div className="origin-top rounded-xl shadow-sm transition-[transform,box-shadow] duration-200 ease-out group-focus-within/card:-translate-y-2 group-focus-within/card:shadow-xl group-hover/card:-translate-y-2 group-hover/card:scale-[1.02] group-hover/card:shadow-xl">
            <RunActivity
              runId={run.id}
              initialEvents={run.events}
              status={run.status}
              stage={run.stage}
              workerOnline={workerOnline}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
