'use client';

import { ArrowUpRight, Check, Lightbulb, Radar, RefreshCw, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';

import { SignalBadge } from '@/components/common/signal-badge';
import type { DiscoveryResult, Opportunity } from '@/lib/discovery/types';
import { cn } from '@/lib/utils/cn';

import { startDiscoveredResearchAction } from './actions';
import { streamDiscoveryScan, type ScanPhase } from './stream';

const SCAN_PHRASES = [
  'HN · 最近 14 天热点',
  'Reddit · “I wish there was…”',
  'Twitter · “is there a tool”',
  '小红书 · “有没有 推荐”',
  '知乎 · “为什么 没有”',
  '论坛 · “太麻烦 吐槽”',
] as const;

const STEP_LABELS = [
  '按最近热点与历史扫描规划新角度',
  '检索中英文公开片段',
  '过滤内容农场与无商业线索页面',
  '模型筛选可落地的方向',
] as const;

const SOCIAL_LABELS: Readonly<Record<string, string>> = {
  zhihu: '知乎',
  xiaohongshu: '小红书',
  douyin: '抖音',
  twitter: 'X',
};

const MONETIZATION_LABELS: Readonly<Record<string, string>> = {
  subscription: '订阅',
  usage: '按量付费',
  'one-time': '一次性买断',
  service: '服务 + 软件',
};

export interface OpportunityPageProps {
  /** Injected in tests; the page uses the real server actions by default. */
  find?: (
    excludeUrls: readonly string[],
    directions: readonly string[],
    onPhase: (phase: ScanPhase) => void,
  ) => Promise<{ ok: true; value: DiscoveryResult } | { ok: false; code: string; message: string }>;
  start?: (
    input: {
      idea: string;
      scanId: number | null;
      title: string;
      angle: string;
    },
  ) => Promise<
    | { ok: true; value: { threadId: number }; warning?: string | undefined }
    | { ok: false; code: string; message: string }
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
  /** Finished scans, oldest first; a rescan appends instead of replacing. */
  const [batches, setBatches] = useState<DiscoveryResult[]>([]);
  /** Empty means "let the model plan"; otherwise the scan must use these. */
  const [directions, setDirections] = useState<string[]>([]);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [phrase, setPhrase] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [step, setStep] = useState(0);
  const requestId = useRef(0);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  /** URLs shown by earlier scans this visit; the next scan excludes them. */
  const seenUrls = useRef<string[]>([]);

  async function scan(): Promise<void> {
    const id = ++requestId.current;
    setScanning(true);
    setError(null);
    setElapsed(0);
    setStep(0);

    try {
      const result = await find(seenUrls.current, directions, (phase: ScanPhase) => {
        const index =
          phase === 'plan' ? 0 : phase === 'search' ? 1 : phase === 'filter' ? 2 : 3;
        setStep((current) => Math.max(current, index));
      });
      if (id !== requestId.current) return;
      if (result.ok) {
        seenUrls.current = [
          ...new Set([...seenUrls.current, ...result.value.sources.map((source) => source.url)]),
        ].slice(-300);
        setStep(STEP_LABELS.length);
        // Append: earlier rounds stay on screen and stay accountable.
        setBatches((previous) => [...previous, result.value]);
      } else {
        setError(result.message);
      }
    } catch {
      if (id === requestId.current) {
        setError('扫描失败：网络或服务端错误，请重试。');
      }
    } finally {
      if (id === requestId.current) setScanning(false);
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
    if (!scanning) return;
    const startedAt = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - startedAt), 100);
    return () => clearInterval(tick);
  }, [scanning]);

  useEffect(() => {
    if (!scanning) return;
    const rotate = setInterval(() => setPhrase((value) => (value + 1) % SCAN_PHRASES.length), 2200);
    return () => clearInterval(rotate);
  }, [scanning]);

  // A rescan appends below a page the operator is already reading; bring the
  // new round's skeleton into view instead of leaving it off-screen.
  useEffect(() => {
    if (!scanning || batches.length === 0) return;
    skeletonRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [scanning, batches.length]);

  function addDirection(value: string): void {
    const clean = value.trim().replace(/\s+/g, ' ');
    if (clean === '') return;
    setDirections((previous) =>
      previous.includes(clean) || previous.length >= 5 ? previous : [...previous, clean],
    );
  }

  function removeDirection(value: string): void {
    setDirections((previous) => previous.filter((direction) => direction !== value));
  }

  async function startResearch(opportunity: Opportunity, scanId: number | null): Promise<void> {
    setStarting(opportunity.title);
    try {
      const idea = `${opportunity.title}：${opportunity.problem}`;
      const result = await start({
        idea,
        scanId,
        title: opportunity.title,
        angle: opportunity.angle,
      });
      if (!result.ok) {
        toast.error(`创建研究失败：${result.message}`);
        return;
      }
      if (result.warning !== undefined) toast.error(result.warning);
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

        <ScanButton scanning={scanning} onScan={() => void scan()} />
      </header>

      <DirectionPicker
        directions={directions}
        suggestions={[
          ...new Set(batches.flatMap((batch) => batch.angles)),
        ].filter((angle) => !directions.includes(angle))}
        disabled={scanning}
        onAdd={addDirection}
        onRemove={removeDirection}
      />

      {batches.length === 0 && scanning ? (
        <Scanning elapsedMs={elapsed} phrase={phrase} step={step} />
      ) : null}

      {batches.map((result, index) => (
        <Results
          key={result.scanId ?? `round-${index}`}
          round={index + 1}
          result={result}
          starting={starting}
          onStart={(opportunity) => void startResearch(opportunity, result.scanId)}
        />
      ))}

      {scanning && batches.length > 0 ? (
        <ScanSkeleton
          containerRef={skeletonRef}
          round={batches.length + 1}
          elapsedMs={elapsed}
          step={step}
        />
      ) : null}

      {error !== null ? (
        <section
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-danger/40 bg-danger-soft px-5 py-4"
        >
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => void scan()}
            className="rounded-lg border border-danger/40 px-3 py-1.5 text-[13px] text-danger hover:bg-danger/10"
          >
            {batches.length === 0 ? '重新扫描' : '再试一次'}
          </button>
        </section>
      ) : null}

      {batches.length > 0 ? (
        <div className="flex justify-center">
          <ScanButton
            scanning={scanning}
            onScan={() => void scan()}
            ariaLabel="再扫一轮（列表底部）"
          />
        </div>
      ) : null}

      {batches.length > 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-faint">
          <Check className="size-3" aria-hidden="true" />
          所有链接来自公开搜索结果；模型不得引用未提供的 URL，伪造引用会被丢弃。
        </p>
      ) : null}
    </div>
  );
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One action, two places: header and the end of the results list. */
function ScanButton({
  scanning,
  onScan,
  ariaLabel,
}: {
  scanning: boolean;
  onScan: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onScan}
      disabled={scanning}
      aria-label={ariaLabel}
      className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
    >
      <RefreshCw className={cn('size-3.5', scanning && 'animate-spin')} aria-hidden="true" />
      {scanning ? '扫描中…' : '再扫一轮'}
    </button>
  );
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

        <p className="text-[11px] text-faint">通常需要 30–60 秒（含 Reddit / GitHub 的限速检索）；模型单次超过 45 秒会明确提示超时。</p>
      </div>
    </section>
  );
}

function Results({
  round,
  result,
  starting,
  onStart,
}: {
  round: number;
  result: DiscoveryResult;
  starting: string | null;
  onStart: (opportunity: Opportunity) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted tabular-nums">
            第 {round} 轮
          </span>
          <span className="text-[11px] font-medium tracking-wide text-faint">本轮角度</span>
          {result.angles.map((angle) => (
            <span
              key={angle}
              className="rounded-md bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent"
            >
              {angle}
            </span>
          ))}
        </div>
        <p className="text-[12px] leading-5 text-muted">{result.rationale}</p>

        {result.queries.length > 0 ? (
          <details className="rounded-lg border border-border/60 px-3 py-2 text-[11px] text-muted">
            <summary className="cursor-pointer select-none text-faint">
              本轮查询（{result.queries.length}）
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1">
              {result.queries.map((query) => (
                <li key={query} className="truncate font-mono text-[10.5px]">
                  {query}
                </li>
              ))}
            </ul>
            {result.socialQueries.length > 0 ? (
              <p className="mt-2 text-faint">
                社交平台实际检索词：
                {result.socialQueries
                  .map((item) => `${SOCIAL_LABELS[item.platform] ?? item.platform}「${item.query}」`)
                  .join('、')}
              </p>
            ) : null}
          </details>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
          <span>
            新颖度 {Math.round(result.novelty.ratio * 100)}%（{result.novelty.newUrls}/
            {result.novelty.total} 条来源首次出现）
          </span>
          <span>已避开最近扫描的 {result.avoided} 条 URL</span>
          {result.strategy === 'fallback' ? (
            <span className="text-warning">本轮为固定池兜底：模型未能规划新角度</span>
          ) : null}
          {result.commercialGap ? (
            <span className="text-warning">
              本轮没有可引用的付费/商业线索：以下方向只基于问题信号，开始研究前需补证据
            </span>
          ) : null}
          {result.scanId === null ? (
            <span className="text-warning">本轮未写入记忆，下一轮无法据此去重</span>
          ) : null}
        </div>
      </section>

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
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-[11px] font-semibold text-muted tabular-nums">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h2 className="min-w-0 text-[15px] leading-6 font-semibold text-fg">
                    {opportunity.title}
                  </h2>
                  <span className="mt-0.5 shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-muted">
                    {opportunity.angle}
                  </span>
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
    </div>
  );
}

/**
 * Operator-chosen scan directions. Empty is the default "let the model plan";
 * picking any direction pins the planner to exactly those angles for every
 * subsequent round, including the rescan buttons at the top and bottom.
 */
function DirectionPicker({
  directions,
  suggestions,
  disabled,
  onAdd,
  onRemove,
}: {
  directions: readonly string[];
  suggestions: readonly string[];
  disabled: boolean;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const atLimit = directions.length >= 5;

  function submit(): void {
    const value = draft.trim();
    if (value === '' || atLimit) return;
    onAdd(value);
    setDraft('');
  }

  return (
    <section
      aria-label="扫描方向"
      className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-faint">扫描方向</span>

        {directions.map((direction) => (
          <span
            key={direction}
            className="flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent"
          >
            {direction}
            <button
              type="button"
              aria-label={`移除方向 ${direction}`}
              disabled={disabled}
              onClick={() => onRemove(direction)}
              className="rounded-sm text-accent/80 hover:text-accent disabled:opacity-50"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              submit();
            }}
            placeholder={atLimit ? '最多 5 个方向' : '输入方向，回车添加'}
            maxLength={40}
            disabled={disabled || atLimit}
            aria-label="添加扫描方向"
            className="h-8 w-56 rounded-lg border border-border bg-surface-2/40 px-2.5 text-[12px] text-fg placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || atLimit || draft.trim() === ''}
            className="flex h-8 items-center rounded-lg border border-border px-2.5 text-[12px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            添加
          </button>
        </div>
      </div>

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          <span>从已扫描角度快速添加：</span>
          {suggestions.slice(0, 8).map((angle) => (
            <button
              key={angle}
              type="button"
              disabled={disabled || atLimit}
              onClick={() => onAdd(angle)}
              className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              + {angle}
            </button>
          ))}
        </div>
      ) : null}

      <p className="text-[11px] text-faint">
        不选方向时由模型按最近热点与历史扫描自动规划；选定后，两处「再扫一轮」都会按这些方向检索。
      </p>
    </section>
  );
}

/**
 * The rescan skeleton: the earlier rounds stay readable above, while the new
 * round reserves the space it will occupy. Two cards match the common result
 * count without pretending to know how many ideas will survive the gates.
 */
function ScanSkeleton({
  containerRef,
  round,
  elapsedMs,
  step,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  round: number;
  elapsedMs: number;
  step: number;
}) {
  return (
    <section
      ref={containerRef}
      role="status"
      aria-label={`第 ${round} 轮扫描中`}
      aria-live="polite"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        <RefreshCw
          className="size-3.5 text-accent motion-safe:animate-spin"
          aria-hidden="true"
        />
        <span className="font-medium text-fg">第 {round} 轮扫描中</span>
        <span className="text-[11px] text-faint">
          {STEP_LABELS[step] ?? '整理结果'} · {formatElapsed(elapsedMs)}
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((index) => (
          <div
            key={index}
            aria-hidden="true"
            className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5"
          >
            <div className="flex items-start gap-2">
              <span className="size-6 shrink-0 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" />
              <span className="mt-1 h-4 w-3/5 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
              <span className="mt-0.5 ml-auto h-5 w-12 shrink-0 animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none" />
            </div>
            <span className="h-3 w-full animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <span className="h-3 w-4/5 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
            <div className="mt-1 flex flex-col gap-2">
              {[0, 1, 2, 3].map((row) => (
                <span
                  key={row}
                  className="h-3 w-full animate-pulse rounded bg-surface-2 motion-reduce:animate-none"
                />
              ))}
            </div>
            <span className="mt-1 h-9 w-full animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
          </div>
        ))}
      </div>

      <p className="text-[11px] text-faint">新一轮结果会追加在下方，之前的扫描不会被清除。</p>
    </section>
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
