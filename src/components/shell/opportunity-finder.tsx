'use client';

import { Lightbulb, Loader2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { SignalBadge } from '@/components/common/signal-badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DiscoveryResult } from '@/lib/discovery/types';
import { cn } from '@/lib/utils/cn';

export type FindResult =
  { ok: true; value: DiscoveryResult } | { ok: false; code: string; message: string };

export type StartResult =
  { ok: true; value: { threadId: number } } | { ok: false; code: string; message: string };

export interface OpportunityFinderProps {
  /** Server actions are injected by the layout (feature code cannot be imported here). */
  onFind: () => Promise<FindResult>;
  onStart: (idea: string) => Promise<StartResult>;
  className?: string;
}

type ScanState =
  | { kind: 'scanning' }
  | { kind: 'ready'; result: DiscoveryResult }
  | { kind: 'error'; message: string };

/**
 * "Find an opportunity": one AI scan over public web results (Chinese and
 * English phrasings) that proposes problems worth validating. It deliberately
 * stops at snippets — starting a research thread is what turns a lead into
 * evidence.
 */
export function OpportunityFinder({ onFind, onStart, className }: OpportunityFinderProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ScanState>({ kind: 'scanning' });
  const [starting, setStarting] = useState<string | null>(null);

  async function scan(): Promise<void> {
    setState({ kind: 'scanning' });
    try {
      const result = await onFind();
      if (result.ok) setState({ kind: 'ready', result: result.value });
      else setState({ kind: 'error', message: result.message });
    } catch {
      setState({ kind: 'error', message: '扫描失败：网络或服务端错误，请重试。' });
    }
  }

  function openAndScan(): void {
    setOpen(true);
    void scan();
  }

  async function start(opportunity: { title: string; problem: string }): Promise<void> {
    setStarting(opportunity.title);
    try {
      const idea = `${opportunity.title}：${opportunity.problem}`;
      const result = await onStart(idea);
      if (!result.ok) {
        toast.error(`创建研究失败：${result.message}`);
        return;
      }
      setOpen(false);
      router.push(`/threads/${result.value.threadId}`);
      router.refresh();
    } finally {
      setStarting(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openAndScan}
        className={cn(
          'group relative isolate flex h-9 w-full items-center justify-center gap-2 overflow-visible rounded-lg border border-accent/50 bg-accent-soft text-[13px] font-medium text-accent transition-colors hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          className,
        )}
      >
        {/* Halo: fades in and breathes so the action reads as "live", not a link. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px -z-10 rounded-lg bg-accent/25 opacity-70 blur-md motion-safe:animate-[opportunity-glow_2.8s_ease-in-out_infinite]"
        />
        <span className="relative grid size-4 place-items-center">
          <Lightbulb className="size-4 text-warning motion-safe:animate-[opportunity-lean_3.6s_ease-in-out_infinite]" />
          <Sparkles
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 size-2.5 text-accent opacity-0 motion-safe:animate-[opportunity-spark_2.8s_ease-in-out_infinite]"
          />
        </span>
        寻找机会
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lightbulb className="size-4 text-warning" aria-hidden="true" />
              机会雷达
            </DialogTitle>
            <DialogDescription>
              扫描中英文公开网页里的抱怨、求推荐与付费线索，再交给模型筛选值得验证的方向。
            </DialogDescription>
          </DialogHeader>

          {state.kind === 'scanning' ? (
            <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted">
              <span className="relative grid size-10 place-items-center">
                <span className="absolute inset-0 rounded-full bg-accent/20 motion-safe:animate-ping" />
                <Loader2 className="size-5 animate-spin text-accent" aria-hidden="true" />
              </span>
              <p>正在检索 Reddit / Twitter / 小红书 / 知乎 的公开片段…</p>
              <p className="text-xs text-faint">通常需要 20–60 秒</p>
            </div>
          ) : null}

          {state.kind === 'error' ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <p role="alert" className="text-sm text-danger">
                {state.message}
              </p>
              <button
                type="button"
                onClick={() => void scan()}
                className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
              >
                重新扫描
              </button>
            </div>
          ) : null}

          {state.kind === 'ready' ? (
            <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
              <p className="text-[11px] text-faint">
                {state.result.providers.join(' · ')} · 已分析 {state.result.sources.length}{' '}
                条公开片段
              </p>

              {state.result.opportunities.map((opportunity) => (
                <article
                  key={`${opportunity.title}-${opportunity.evidence[0]?.url ?? ''}`}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-sm font-semibold text-fg">{opportunity.title}</h3>
                    <SignalBadge signal={opportunity.signal} />
                  </div>
                  <p className="text-[13px] leading-6 text-muted">{opportunity.problem}</p>
                  <p className="text-[11px] text-faint">目标人群：{opportunity.audience}</p>

                  <ul className="flex flex-col gap-1">
                    {opportunity.evidence.map((item) => (
                      <li key={`${item.url}-${item.quote}`} className="text-[11px] leading-5">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-accent underline-offset-2 hover:underline"
                        >
                          {item.url}
                        </a>
                        <span className="text-muted"> — “{item.quote}”</span>
                      </li>
                    ))}
                  </ul>

                  <div>
                    <button
                      type="button"
                      disabled={starting !== null}
                      onClick={() => void start(opportunity)}
                      className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      {starting === opportunity.title ? '创建中…' : '用它开始研究'}
                    </button>
                  </div>
                </article>
              ))}

              <button
                type="button"
                onClick={() => void scan()}
                className="self-start rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg"
              >
                再扫一轮
              </button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
