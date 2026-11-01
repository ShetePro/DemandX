'use client';

import { ArrowUpRight, Check, Lightbulb, Radar, RefreshCw, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { SignalBadge } from '@/components/common/signal-badge';
import type { DiscoveryResult, Opportunity } from '@/lib/discovery/types';
import { cn } from '@/lib/utils/cn';

import { startDiscoveredResearchAction } from './actions';
import { streamDiscoveryScan, type ScanPhase } from './stream';

const SCAN_PHRASES = [
  'Reddit · “I wish there was…”',
  'Twitter · “is there a tool”',
  '小红书 · “有没有 推荐”',
  '知乎 · “为什么 没有”',
  '论坛 · “太麻烦 吐槽”',
] as const;

const STEP_LABELS = [
  '检索中英文公开片段',
  '过滤内容农场与无商业线索页面',
  '模型筛选可落地的方向',
] as const;

const MONETIZATION_LABELS: Readonly<Record<string, string>> = {
  subscription: '订阅',
  usage: '按量付费',
  'one-time': '一次性买断',
  service: '服务 + 软件',
};

type ScanState =
  | { kind: 'scanning' }
  | { kind: 'ready'; result: DiscoveryResult }
  | { kind: 'error'; message: string };

export interface OpportunityPageProps {
  /** Injected in tests; the page uses the real server actions by default. */
  find?: (
    excludeUrls: readonly string[],
    onPhase: (phase: ScanPhase) => void,
  ) => Promise<{ ok: true; value: DiscoveryResult } | { ok: false; code: string; message: string }>;
  start?: (
    idea: string,
  ) => Promise<
    { ok: true; value: { threadId: number } } | { ok: false; code: string; message: string }
  >;
}

/**
 * `/discover`: a full page instead of a modal, because the scan produces more
 * than a dialog can show — provenance, timings, model choice and several
 * opportunities with their quotes all need room to be read side by side.
 */
export function OpportunityPage({
  find = streamDiscoveryScan,
  start = startDiscoveredResearchAction,
}: OpportunityPageProps) {
  const router = useRouter();
  const [state, setState] = useState<ScanState>({ kind: 'scanning' });
  const [starting, setStarting] = useState<string | null>(null);
  const [phrase, setPhrase] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [step, setStep] = useState(0);
  const requestId = useRef(0);
  /** URLs shown by earlier scans this visit; the next scan excludes them. */
  const seenUrls = useRef<string[]>([]);

  async function scan(): Promise<void> {
    const id = ++requestId.current;
    setState({ kind: 'scanning' });
    setElapsed(0);
    setStep(0);

    try {
      const result = await find(seenUrls.current, (phase: ScanPhase) => {
        const index = phase === 'search' ? 0 : phase === 'filter' ? 1 : 2;
        setStep((current) => Math.max(current, index));
      });
      if (id !== requestId.current) return;
      if (result.ok) {
        seenUrls.current = [
          ...new Set([...seenUrls.current, ...result.value.sources.map((source) => source.url)]),
        ].slice(-300);
        setStep(STEP_LABELS.length);
        setState({ kind: 'ready', result: result.value });
      } else setState({ kind: 'error', message: result.message });
    } catch {
      if (id === requestId.current) {
        setState({ kind: 'error', message: '扫描失败：网络或服务端错误，请重试。' });
      }
    }
  }

  // One scan per visit, started on the next tick: the route itself is the
  // action, and deferring keeps the mount render free of a state write.
  useEffect(() => {
    const timer = setTimeout(() => void scan(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scan is stable per visit
  }, []);

  useEffect(() => {
    if (state.kind !== 'scanning') return;
    const startedAt = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(tick);
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== 'scanning') return;
    const rotate = setInterval(() => setPhrase((value) => (value + 1) % SCAN_PHRASES.length), 2200);
    return () => clearInterval(rotate);
  }, [state.kind]);

  async function startResearch(opportunity: Opportunity): Promise<void> {
    setStarting(opportunity.title);
    try {
      const idea = `${opportunity.title}：${opportunity.problem}`;
      const result = await start(idea);
      if (!result.ok) {
        toast.error(`创建研究失败：${result.message}`);
        return;
      }
      router.push(`/threads/${result.value.threadId}`);
      router.refresh();
    } finally {
      setStarting(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-fg">
            <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent">
              <Radar className="size-4" aria-hidden="true" />
            </span>
            灵感雷达
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            扫描中英文公开网页里的抱怨、求推荐与付费线索，再由模型筛出值得验证的产品方向。每条结论都能回到原始链接核对。
          </p>
        </div>

        <button
          type="button"
          onClick={() => void scan()}
          disabled={state.kind === 'scanning'}
          className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
        >
          <RefreshCw
            className={cn('size-3.5', state.kind === 'scanning' && 'animate-spin')}
            aria-hidden="true"
          />
          {state.kind === 'scanning' ? '扫描中…' : '再扫一轮'}
        </button>
      </header>

      {state.kind === 'scanning' ? (
        <Scanning elapsedMs={elapsed} phrase={phrase} step={step} />
      ) : null}

      {state.kind === 'error' ? (
        <section
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-danger/40 bg-danger-soft px-5 py-4"
        >
          <p className="text-sm text-danger">{state.message}</p>
          <button
            type="button"
            onClick={() => void scan()}
            className="rounded-lg border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-danger/10"
          >
            重新扫描
          </button>
        </section>
      ) : null}

      {state.kind === 'ready' ? (
        <Results
          result={state.result}
          starting={starting}
          onStart={(opportunity) => void startResearch(opportunity)}
        />
      ) : null}
    </div>
  );
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Radar instead of a spinner: concentric rings plus a sweeping beam make the
 * wait feel like coverage, and the elapsed timer stays honest about how long
 * it has actually been running.
 */
function Scanning({
  elapsedMs,
  phrase,
  step,
}: {
  elapsedMs: number;
  phrase: number;
  step: number;
}) {
  return (
    <section
      aria-live="polite"
      className="grid items-center gap-6 rounded-2xl border border-border bg-surface p-6 lg:grid-cols-[auto_minmax(0,1fr)]"
    >
      <div className="relative mx-auto grid size-44 place-items-center">
        <span className="absolute inset-0 rounded-full border border-border" />
        <span className="absolute inset-5 rounded-full border border-accent/20" />
        <span className="absolute inset-10 rounded-full border border-accent/30" />
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,var(--accent)_55deg,transparent_110deg)] opacity-40 motion-safe:animate-[radar-sweep_2.4s_linear_infinite]"
        />
        <span className="absolute inset-0 rounded-full bg-accent/5" />

        {[
          { top: '26%', left: '62%', delay: '0.2s' },
          { top: '58%', left: '30%', delay: '0.9s' },
          { top: '70%', left: '68%', delay: '1.5s' },
        ].map((blip) => (
          <span
            key={`${blip.top}-${blip.left}`}
            aria-hidden="true"
            className="absolute size-1.5 rounded-full bg-accent motion-safe:animate-ping"
            style={{ top: blip.top, left: blip.left, animationDelay: blip.delay }}
          />
        ))}

        <span className="relative grid size-12 place-items-center rounded-full bg-accent-soft text-accent">
          <Lightbulb className="size-5 motion-safe:animate-[opportunity-lean_3.6s_ease-in-out_infinite]" />
        </span>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium text-fg">正在扫描</p>
          <span className="text-xs text-faint tabular-nums">{formatElapsed(elapsedMs)}</span>
        </div>

        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Sparkles className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span key={phrase} className="motion-safe:animate-[fade-in_400ms_ease-out]">
            {SCAN_PHRASES[phrase]}
          </span>
        </p>

        <ol className="flex flex-col gap-2.5">
          {STEP_LABELS.map((label, index) => {
            const done = index < step;
            const active = index === step;
            return (
              <li
                key={label}
                data-done={done ? 'true' : undefined}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-3 text-[13px] transition-colors',
                  done ? 'text-muted' : active ? 'text-fg' : 'text-faint',
                )}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full border',
                    done
                      ? 'border-success/50 bg-success-soft text-success'
                      : active
                        ? 'border-accent/50 bg-accent-soft text-accent'
                        : 'border-border text-faint',
                  )}
                >
                  {done ? (
                    <Check className="size-3" aria-hidden="true" />
                  ) : active ? (
                    <span className="size-1.5 rounded-full bg-accent motion-safe:animate-ping" />
                  ) : (
                    <span className="size-1 rounded-full bg-current opacity-40" />
                  )}
                </span>
                <span className="flex-1">{label}</span>
                {active ? <span className="text-[11px] text-accent">进行中</span> : null}
              </li>
            );
          })}
        </ol>

        <p className="text-[11px] text-faint">通常需要 15–30 秒；超过 45 秒会明确提示超时。</p>
      </div>
    </section>
  );
}

function Results({
  result,
  starting,
  onStart,
}: {
  result: DiscoveryResult;
  starting: string | null;
  onStart: (opportunity: Opportunity) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="耗时" value={formatElapsed(result.elapsedMs)} />
        <Stat label="公开片段" value={String(result.sources.length)} />
        <Stat label="检索来源" value={result.providers.join(' · ') || '—'} />
        <Stat label="分析模型" value={result.model} />
      </section>

      <ul className="grid gap-4 xl:grid-cols-2">
        {result.opportunities.map((opportunity, index) => (
          <li key={`${opportunity.title}-${opportunity.evidence[0]?.url ?? index}`}>
            <article className="flex h-full flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-[11px] font-semibold text-muted tabular-nums">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h2 className="text-[15px] leading-6 font-semibold text-fg">
                    {opportunity.title}
                  </h2>
                </div>
                <SignalBadge signal={opportunity.signal} />
              </div>

              <p className="text-[13px] leading-6 text-muted">{opportunity.problem}</p>

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] leading-5">
                <dt className="text-faint">目标人群</dt>
                <dd className="text-muted">{opportunity.audience}</dd>
                <dt className="text-faint">现有替代</dt>
                <dd className="text-muted">{opportunity.currentAlternative}</dd>
                <dt className="text-faint">竞品</dt>
                <dd className="text-muted">
                  {opportunity.competitors.length === 0
                    ? '片段未点名'
                    : opportunity.competitors.join('、')}
                </dd>
                <dt className="text-faint">变现</dt>
                <dd className="text-muted">
                  {MONETIZATION_LABELS[opportunity.monetization] ?? opportunity.monetization}
                </dd>
                <dt className="text-faint">MVP</dt>
                <dd className="text-muted">{opportunity.mvp}</dd>
              </dl>

              <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                <p className="text-[11px] font-medium tracking-wide text-faint">原始证据</p>
                <ul className="flex flex-col gap-2">
                  {opportunity.evidence.map((item) => (
                    <li key={`${item.url}-${item.quote}`} className="flex flex-col gap-1">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[12px] break-all text-accent underline-offset-2 hover:underline"
                      >
                        {item.url}
                        <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
                      </a>
                      <blockquote className="border-l-2 border-accent/40 pl-2 text-[12px] leading-5 text-muted">
                        “{item.quote}”
                      </blockquote>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-auto pt-1">
                <button
                  type="button"
                  disabled={starting !== null}
                  onClick={() => onStart(opportunity)}
                  className="w-full rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {starting === opportunity.title ? '创建中…' : '用它开始研究'}
                </button>
              </div>
            </article>
          </li>
        ))}
      </ul>

      <details className="rounded-2xl border border-border bg-surface px-5 py-4">
        <summary className="cursor-pointer text-[13px] font-medium text-muted">
          查看本次扫描的 {result.sources.length} 条原始片段
        </summary>
        <ul className="mt-3 flex flex-col gap-2">
          {result.sources.map((source) => (
            <li key={source.url} className="flex flex-col gap-0.5 text-[12px]">
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="break-all text-accent underline-offset-2 hover:underline"
              >
                {source.title}
              </a>
              <p className="line-clamp-2 text-muted">{source.snippet}</p>
            </li>
          ))}
        </ul>
      </details>

      <p className="flex items-center gap-1.5 text-[11px] text-faint">
        <Check className="size-3" aria-hidden="true" />
        所有链接来自公开搜索结果；模型不得引用未提供的 URL，伪造引用会被丢弃。
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-surface px-3 py-2.5">
      <span className="text-[11px] text-faint">{label}</span>
      <span className="truncate text-[13px] font-medium text-fg">{value}</span>
    </div>
  );
}
