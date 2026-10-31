'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import type { CreateResearchResult, Result } from '@/lib/runs/repository';
import { cn } from '@/lib/utils/cn';

import { startResearchAction } from './actions';
import { Composer } from './composer';
import {
  matchSuggestions,
  mergeSuggestions,
  suggestionWindow,
  type ResearchSuggestion,
} from './research-suggestions';

/** The composer's whole journey from the centred slot to the bottom bar. */
const DOCK_DURATION_MS = 520;

/**
 * iOS-sheet easing: a gentle start and a long deceleration. An aggressive
 * spring curve would spend the first 100ms on 90% of the distance and leave the
 * rest as dead time; this one keeps moving for the whole 520ms.
 */
const DOCK_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/** Below this the dock is imperceptible; running the FLIP would only cost frames. */
const DOCK_MIN_DISTANCE_PX = 2;

const SUGGESTION_DEBOUNCE_MS = 150;

export type NewResearchScreenProps = {
  /** Newest real pitches from the `ideas` table, newest first. */
  recentIdeas?: readonly string[];
};

/**
 * `/threads/new`: one question, a few directions, and a composer that is the
 * centre of the screen. Submitting creates the thread and its first run, then
 * the composer docks to the bottom while the prompt fades, so the conversation
 * page opens with the user's turn already in place.
 */
export function NewResearchScreen({ recentIdeas = [] }: NewResearchScreenProps) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [batchState, setBatchState] = useState({ query: '', batch: 0 });
  const [phase, setPhase] = useState<'idle' | 'docking'>('idle');
  const [pending, setPending] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  /** Composer `top` from the last frame the reader saw, before the layout flips. */
  const firstTop = useRef<number | null>(null);
  /** The create request, started on the keystroke so the dock never waits for it. */
  const actionRef = useRef<Promise<Result<CreateResearchResult>> | null>(null);

  const debouncedDraft = useDebouncedValue(draft, SUGGESTION_DEBOUNCE_MS);
  const suggestions = useMemo(() => mergeSuggestions(recentIdeas), [recentIdeas]);
  const matched = useMemo(
    () => matchSuggestions(suggestions, debouncedDraft),
    [suggestions, debouncedDraft],
  );
  // A new query starts over; storing the debounced query with the page avoids
  // resetting it from an effect after every keystroke.
  const batch = batchState.query === debouncedDraft ? batchState.batch : 0;
  const pool = matched.length > 0 ? matched : suggestions;
  const visible = suggestionWindow(pool, batch);

  // FLIP: the layout has already re-anchored the composer by the time this runs,
  // so play the same node back from where it was and let it land. Because the
  // animation runs on one DOM node with `fill: both`, no style is swapped
  // mid-flight; the thread page only takes over once both the motion and the
  // request have landed — neither waits for the other.
  useLayoutEffect(() => {
    if (phase !== 'docking') return;
    const action = actionRef.current;
    if (action === null) return;

    const node = composerRef.current;
    const from = firstTop.current;
    const to = node?.getBoundingClientRect().top;
    const dy = from === null || to === undefined ? 0 : from - to;
    // The reader's preference at the moment the motion starts, not a
    // render-time snapshot: it is a one-shot decision, not reactive UI.
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let animation: Animation | null = null;
    // No node, a jump too small to see, reduced motion, or a runtime without the
    // Web Animations API: there is nothing to play, only a request to await.
    if (
      node !== null &&
      !prefersReduced &&
      Math.abs(dy) >= DOCK_MIN_DISTANCE_PX &&
      typeof node.animate === 'function'
    ) {
      animation = node.animate(
        [
          { transform: `translateY(${dy}px) scale(0.985)` },
          { transform: 'translateY(-3px) scale(1.003)', offset: 0.78 },
          { transform: 'translateY(0) scale(1)' },
        ],
        { duration: DOCK_DURATION_MS, easing: DOCK_EASING, fill: 'both' },
      );
    }

    // `cancel()` in cleanup rejects `finished`; swallowing it keeps the expected
    // teardown out of the console while still awaiting the real landing.
    const docked =
      animation === null
        ? Promise.resolve()
        : animation.finished.then(
            () => undefined,
            () => undefined,
          );
    let cancelled = false;

    // A failure must not teleport the card back to the middle: play the dock in
    // reverse, then hand the layout back to the centred prompt.
    async function rollBack(): Promise<void> {
      if (animation === null) return;
      animation.reverse();
      await animation.finished.catch(() => undefined);
    }

    void Promise.all([docked, action.catch(() => null)]).then(async ([, result]) => {
      if (cancelled) return;

      if (result === null) {
        toast.error('创建研究失败：网络错误');
      } else if (!result.ok) {
        toast.error(result.message);
      } else {
        router.push(`/threads/${result.value.threadId}`);
        // The sidebar list is server data rendered by the layout; without a
        // refresh the new conversation is missing until the next full load.
        router.refresh();
        return;
      }

      await rollBack();
      if (cancelled) return;
      setPending(false);
      setPhase('idle');
    });

    return () => {
      cancelled = true;
      animation?.cancel();
    };
  }, [phase, router]);

  function handleSend(idea: string): void {
    if (pending || phase === 'docking') return;

    // The card has to move on the keystroke, not when the network answers:
    // measure it, flip the layout, and let the request run alongside the dock.
    const node = composerRef.current;
    if (node === null) return;

    setPending(true);
    firstTop.current = node.getBoundingClientRect().top;
    actionRef.current = startResearchAction({ idea });
    setPhase('docking');
  }

  function pick(suggestion: ResearchSuggestion): void {
    if (phase === 'docking') return;
    setDraft(suggestion.idea);
  }

  return (
    <section
      ref={containerRef}
      aria-label="新建研究"
      className={cn(
        'flex min-h-full flex-col px-4 pt-10',
        phase === 'docking' ? 'justify-end pb-4' : 'justify-center pb-10',
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div
          ref={composerRef}
          role="group"
          aria-label="研究输入"
          data-docking={phase === 'docking'}
          className="relative"
        >
          {/* Absolute so the composer itself is exactly centred; floating the
              prompt keeps it above the composer without entering the FLIP
              measurement — it only fades, the layout never moves it. */}
          <div
            data-research-fade
            className="absolute inset-x-0 bottom-full mb-8 px-4 max-md:static max-md:mb-6 max-md:px-0"
          >
            <div className="mx-auto w-full max-w-3xl">
              <p className="text-xs font-medium tracking-wide text-muted">新研究</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg">先描述一个问题</h1>
              <p className="mt-2 text-sm text-muted">
                写下你观察到的痛点或抱怨，助手会先整理研究角度
              </p>

              <section className="mt-7" aria-labelledby="research-suggestions-heading">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="research-suggestions-heading" className="text-xs font-semibold text-fg">
                    推荐方向
                  </h2>
                  <button
                    type="button"
                    onClick={() => setBatchState({ query: debouncedDraft, batch: batch + 1 })}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <RefreshCw aria-hidden="true" className="size-3" />
                    换一批
                  </button>
                </div>

                <ul aria-label="推荐方向" className="mt-2.5 flex flex-wrap gap-2">
                  {visible.map((suggestion) => (
                    <li key={suggestion.key}>
                      <button
                        type="button"
                        onClick={() => pick(suggestion)}
                        title={suggestion.idea}
                        className="max-w-[240px] truncate rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {suggestion.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>

          <Composer
            value={draft}
            onValueChange={setDraft}
            onSend={handleSend}
            onStop={() => undefined}
          />
        </div>
      </div>
    </section>
  );
}
