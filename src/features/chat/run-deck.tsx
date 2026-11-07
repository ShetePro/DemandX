'use client';

import { useRef, useState } from 'react';

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
 * How much of a covered card stays visible: its header row. Every card is
 * still fully rendered and laid out behind its wrapper, so hovering a card can
 * grow that wrapper to the card's measured height and push the newer cards
 * below it down with a height transition — no rebuild, no remount.
 */
const HEADER_PEEK = 44;

/**
 * A damped spring as a CSS `linear()` curve: it overshoots ~16% and settles
 * with one small dip, so the cards below the opening one carry the motion
 * instead of snapping to their new offsets. Collapse keeps a plain ease-out —
 * a spring there would dip the wrapper below the header and clip it.
 */
const SPRING_EASE =
  'linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.004 83.8%, 1)';

/**
 * Run deck: oldest on top, newest at the bottom, and each card below covers
 * the body of the card above it, leaving only that header strip readable.
 * Hovering (or focusing into) a covered card expands it to its full height and
 * pushes the cards underneath down, which is also how the newest card stays
 * fully visible at the bottom of the pile.
 */
export function RunDeck({ runs, workerOnline = true }: RunDeckProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const cards = useRef(new Map<number, HTMLDivElement>());

  if (runs.length === 0) {
    return (
      <p className="px-3 py-4 text-[11px] leading-5 text-faint">
        还没有研究记录。发起研究后，每次运行都会在这里生成一张卡片。
      </p>
    );
  }

  const ordered = [...runs].sort((a, b) => a.id - b.id);
  const newestId = ordered[ordered.length - 1]?.id;

  // The card is absolutely positioned inside its wrapper, so its laid-out
  // height is already the full card height even while the wrapper is clipped
  // to the header. Measure before opening so the height transition has both
  // ends; jsdom reports 0, where `auto` is the only sensible fallback.
  function open(runId: number): void {
    const card = cards.current.get(runId);
    const measured = card === undefined ? 0 : Math.ceil(card.getBoundingClientRect().height);
    if (measured > 0) {
      // +1px: the wrapper clips, and a rounded bottom border must not be cut.
      const height = measured + 1;
      setHeights((previous) =>
        previous[runId] === height ? previous : { ...previous, [runId]: height },
      );
    }
    setOpenId(runId);
  }

  return (
    <div
      aria-label="研究卡片"
      className="relative flex max-h-full w-full flex-col overflow-hidden px-3 pb-4"
    >
      {ordered.map((run, index) => {
        const isNewest = run.id === newestId;
        const openHeight = heights[run.id];
        const expanded = openId === run.id;

        return (
          <div
            key={run.id}
            style={{
              height: isNewest ? undefined : expanded ? (openHeight ?? 'auto') : HEADER_PEEK,
              // Newer cards sit above older ones; the expanding card grows
              // from under the next card instead of covering it.
              zIndex: index + 1,
              transitionTimingFunction: expanded ? SPRING_EASE : undefined,
            }}
            className={cn(
              // Each wrapper clips its card to the animated height, so the
              // margin is a real gap: the page background shows between cards
              // instead of the covered card's body touching the next one.
              'relative mb-2 overflow-hidden rounded-xl transition-[height] duration-[420ms] last:mb-0',
              // A springy overshoot when the card opens; the collapse keeps a
              // plain ease-out so the header never dips below its peek height.
              !expanded && 'ease-out',
            )}
            onMouseEnter={() => open(run.id)}
            onMouseLeave={() => setOpenId((current) => (current === run.id ? null : current))}
            onFocus={() => open(run.id)}
            onBlur={() => setOpenId((current) => (current === run.id ? null : current))}
          >
            <div
              ref={(element) => {
                if (element === null) cards.current.delete(run.id);
                else cards.current.set(run.id, element);
              }}
              className={cn(!isNewest && 'absolute inset-x-0 top-0')}
            >
              <RunActivity
                runId={run.id}
                initialEvents={run.events}
                status={run.status}
                stage={run.stage}
                workerOnline={workerOnline}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
