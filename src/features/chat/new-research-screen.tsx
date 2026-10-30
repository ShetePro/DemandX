'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';

import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { cn } from '@/lib/utils/cn';

import { startResearchAction } from './actions';
import { Composer } from './composer';
import {
  matchSuggestions,
  mergeSuggestions,
  suggestionWindow,
  type ResearchSuggestion,
} from './research-suggestions';

/** Wait for the dock animation to finish before the thread page takes over. */
const DOCK_DELAY_MS = 420;

/** Matches `pb-6` below; the slide ends exactly at the anchored bottom. */
const DOCK_BOTTOM_INSET = 24;

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
  const [dockFrom, setDockFrom] = useState(0);
  const [pending, setPending] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const pushTimer = useRef<number | undefined>(undefined);

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

  useEffect(() => {
    return () => {
      clearTimeout(pushTimer.current);
    };
  }, []);

  async function handleSend(idea: string): Promise<void> {
    if (pending || phase === 'docking') return;
    setPending(true);

    try {
      const result = await startResearchAction({ idea });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      // Measure the composer before the layout re-anchors. The animation then
      // starts at the pre-submit position, so docking never looks like a jump.
      const node = composerRef.current;
      const container = containerRef.current;
      if (node !== null && container !== null) {
        const box = node.getBoundingClientRect();
        const bounds = container.getBoundingClientRect();
        const bottom = bounds.height > 0 ? bounds.bottom : window.innerHeight;
        setDockFrom(Math.max(0, bottom - DOCK_BOTTOM_INSET - box.height - box.top));
      }

      setPhase('docking');
      pushTimer.current = window.setTimeout(() => {
        router.push(`/threads/${result.value.threadId}`);
      }, DOCK_DELAY_MS);
    } catch {
      toast.error('创建研究失败：网络错误');
    } finally {
      setPending(false);
    }
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
        phase === 'docking' ? 'justify-end pb-6' : 'justify-center pb-10',
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        <div
          ref={composerRef}
          role="group"
          aria-label="研究输入"
          data-docking={phase === 'docking'}
          style={{ '--dock-from': `${dockFrom}px` } as CSSProperties}
          className="relative"
        >
          {/* Absolute so the composer itself is exactly centred; floating the
              prompt keeps it above the composer while both slide together. */}
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
            size="hero"
            value={draft}
            onValueChange={setDraft}
            onSend={(text) => void handleSend(text)}
            onStop={() => undefined}
            placeholder="写下你观察到的痛点，或粘贴一条用户抱怨…"
          />
        </div>
      </div>
    </section>
  );
}
