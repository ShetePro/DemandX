'use client';

import { cjk } from '@streamdown/cjk';
import { useMemo, useState, type ComponentProps } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { harden } from 'rehype-harden';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Streamdown, type Components } from 'streamdown';

import { CitationChip } from '@/components/common/citation-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { EvidenceItem } from '@/lib/chat/tools';
import type { ChatMessage } from '@/lib/chat/types';
import { useCodeHighlighter } from '@/lib/hooks/use-code-highlighter';
import { cn } from '@/lib/utils/cn';

import { claimRehypePlugin } from './claim-rehype';
import { CITATION_TAG, citationRehypePlugin, citationSanitizeSchema } from './citations';

/**
 * Why the whole pipeline is spelled out: Streamdown starts from
 * `rehypePlugins ?? DEFAULT`, so passing a plugin of our own *replaces*
 * `rehype-raw` + `rehype-sanitize` + `rehype-harden` instead of extending it.
 * Omitting the sanitize step would leave `javascript:` hrefs and `data:` images
 * from model output live. The order is the library's and must stay: raw HTML is
 * parsed first, citations are inserted second, and the inserted elements are
 * then validated by the schema that declares them.
 */
const HARDEN_OPTIONS = {
  allowedImagePrefixes: ['*'],
  allowedLinkPrefixes: ['*'],
  allowedProtocols: ['*'],
  allowDataImages: true,
};

type RehypePlugins = NonNullable<ComponentProps<typeof Streamdown>['rehypePlugins']>;

const REHYPE_PLUGINS: RehypePlugins = [
  rehypeRaw,
  citationRehypePlugin,
  [rehypeSanitize, citationSanitizeSchema],
  // After sanitize: the claim kind is derived from the text, and the sanitizer
  // would strip an attribute it does not know.
  claimRehypePlugin,
  [harden, HARDEN_OPTIONS],
];

type ChatPart = ChatMessage['parts'][number];

/** Unique evidence ids cited by one assistant message, for the meta line. */
function countUniqueCitations(message: ChatMessage): number {
  const ids = new Set<string>();
  for (const part of message.parts) {
    if (part.type !== 'text') continue;
    for (const match of part.text.matchAll(/\[e(\d+)\]/g)) {
      if (match[1] !== undefined) ids.add(match[1]);
    }
  }
  return ids.size;
}
type StartResearchPart = Extract<ChatPart, { type: 'tool-start_research' }>;
type QueryEvidencePart = Extract<ChatPart, { type: 'tool-query_evidence' }>;
type EvidenceDataPart = Extract<ChatPart, { type: 'data-evidence' }>;
type PresentOptionsPart = Extract<ChatPart, { type: 'tool-present_options' }>;
/** Consecutive evidence searches collapse into one card; repeating the same
 *  empty result twice tells the reader nothing new. */
type EvidenceGroupPart = { type: 'evidence-group'; parts: QueryEvidencePart[] };
type RenderPart = ChatPart | EvidenceGroupPart;

export type MessagePartsProps = {
  message: ChatMessage;
  /** Opens the evidence drawer for a `[eN]` anchor or an evidence card. */
  onOpenCitation?: ((id: string) => void) | undefined;
  /** Confirmed in the approval card — the caller creates the run. */
  onStart?: ((idea: string) => void) | undefined;
  onAdjustAngles?: ((idea: string) => void) | undefined;
  /** Sends the chosen option (label + hint) back to the agent as a user turn. */
  onChooseOption?: ((option: { label: string; description?: string }) => void) | undefined;
};

export function MessageParts({
  message,
  onOpenCitation,
  onStart,
  onAdjustAngles,
  onChooseOption,
}: MessagePartsProps) {
  const citationCount = countUniqueCitations(message);

  return (
    <div className="flex max-w-full min-w-0 flex-col gap-3">
      {message.role === 'assistant' && citationCount > 0 ? (
        <p className="flex items-center gap-1.5 text-[10.5px] text-faint">
          <Sparkles className="size-3 text-accent" aria-hidden="true" />
          基于 {citationCount} 条证据 · 事实与推断已分开标注
        </p>
      ) : null}
      {groupEvidence(coalesceReasoning(message.parts)).map((part, index) => {
        switch (part.type) {
          case 'text':
            return (
              <TextPart
                key={index}
                text={part.text}
                state={part.state}
                onOpenCitation={onOpenCitation}
              />
            );
          case 'reasoning':
            return (
              <ReasoningPart
                key={index}
                text={part.text}
                state={part.state}
                onOpenCitation={onOpenCitation}
              />
            );
          case 'tool-start_research':
            return (
              <StartResearchCard
                key={index}
                part={part}
                onStart={onStart}
                onAdjustAngles={onAdjustAngles}
              />
            );
          case 'tool-present_options':
            return <OptionsCard key={index} part={part} onChoose={onChooseOption} />;
          case 'tool-query_evidence':
            return <QueryEvidenceCard key={index} parts={[part]} />;
          case 'evidence-group':
            return <QueryEvidenceCard key={index} parts={part.parts} />;
          case 'tool-get_run_status':
            // Status is spoken in the reply; the card would duplicate it.
            return null;
          case 'tool-rerun_research':
            // The tool only switches the live run card; a duplicate "重新验证"
            // card here would just repeat that state.
            return null;
          case 'data-evidence':
            return <EvidenceMiniCard key={index} part={part} onOpen={onOpenCitation} />;
          default:
            warnUnsupportedPart(part.type);
            return null;
        }
      })}
    </div>
  );
}

/**
 * One warning per part type per page load: an unhandled part repeats on every
 * token of a stream, and the type is what a maintainer needs to know.
 */
const warnedPartTypes = new Set<string>();

/**
 * Models emit a reasoning part per thought segment, so a single answer can
 * carry several of them back to back. Rendered one per part, that is a stack
 * of nearly empty "思考过程" bars; merged, it is one block with the full
 * reasoning, and empty segments disappear entirely.
 */
function groupEvidence(parts: ChatPart[]): RenderPart[] {
  const grouped: RenderPart[] = [];
  for (const part of parts) {
    if (part.type !== 'tool-query_evidence') {
      grouped.push(part);
      continue;
    }
    const last = grouped.at(-1);
    if (last?.type === 'evidence-group') last.parts.push(part);
    else grouped.push({ type: 'evidence-group', parts: [part] });
  }
  return grouped;
}

function coalesceReasoning(parts: ChatPart[]): ChatPart[] {
  const merged: ChatPart[] = [];
  for (const part of parts) {
    if (part.type !== 'reasoning') {
      merged.push(part);
      continue;
    }
    if (part.text.trim() === '') continue;

    const previous = merged.at(-1);
    if (previous?.type === 'reasoning') {
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + part.text,
        state: part.state,
      } as ChatPart;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function warnUnsupportedPart(type: string): void {
  if (warnedPartTypes.has(type)) return;
  warnedPartTypes.add(type);
  console.warn(`[chat] 未识别的消息片段，已跳过：${type}`);
}

/**
 * Shared by the answer and the reasoning: the same pipeline (raw HTML →
 * citations → sanitize → harden) must apply to both, because both come from
 * the model.
 */
function MarkdownPart({
  text,
  state,
  onOpenCitation,
  className,
}: {
  text: string;
  state?: 'streaming' | 'done' | undefined;
  onOpenCitation?: ((id: string) => void) | undefined;
  className: string;
}) {
  const code = useCodeHighlighter(text);
  const components = useMemo<Components>(
    () => ({
      [CITATION_TAG]: (props: Record<string, unknown>) => {
        const id = typeof props['data-id'] === 'string' ? props['data-id'] : '';
        return <CitationChip id={id} onOpen={onOpenCitation} />;
      },
    }),
    [onOpenCitation],
  );

  return (
    <Streamdown
      mode={state === 'streaming' ? 'streaming' : 'static'}
      className={className}
      plugins={code === undefined ? { cjk } : { cjk, code }}
      rehypePlugins={REHYPE_PLUGINS}
      components={components}
    >
      {text}
    </Streamdown>
  );
}

function TextPart({
  text,
  state,
  onOpenCitation,
}: {
  text: string;
  state?: 'streaming' | 'done' | undefined;
  onOpenCitation?: ((id: string) => void) | undefined;
}) {
  return (
    <MarkdownPart
      text={text}
      state={state}
      onOpenCitation={onOpenCitation}
      className="answer-markdown max-w-full min-w-0 text-[13.5px] leading-7 break-words text-fg [&_*]:max-w-full [&_*]:break-words [&_a]:max-w-full [&_a]:[overflow-wrap:anywhere] [&_a]:break-words [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_button]:max-w-full [&_button]:[overflow-wrap:anywhere] [&_button]:break-words [&_code]:[overflow-wrap:anywhere] [&_code]:break-words [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-border [&_li]:my-1 [&_li]:pl-1 [&_li]:leading-6 [&_li>p]:my-0 [&_ol]:my-2 [&_ol]:pl-6 [&_p]:my-2.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_strong]:font-semibold [&_strong]:text-fg [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-surface-2 [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:pl-6"
    />
  );
}

/**
 * The model's thinking, kept beside the answer instead of hidden. It opens
 * while it streams (with a pulse so it does not read as finished text) and
 * collapses once the answer is complete; a reader can still expand it.
 */
function ReasoningPart({
  text,
  state,
  onOpenCitation,
}: {
  text: string;
  state?: 'streaming' | 'done' | undefined;
  onOpenCitation?: ((id: string) => void) | undefined;
}) {
  const streaming = state === 'streaming';

  return (
    <details
      open={streaming}
      className="max-w-full min-w-0 overflow-hidden rounded-xl border border-border bg-surface-2/50 px-3 py-2 text-muted"
    >
      <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted select-none">
        {streaming && (
          <span
            aria-hidden="true"
            className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
          />
        )}
        思考过程
        <span className="font-normal text-faint">{text.length} 字</span>
      </summary>
      <div className="mt-2 min-w-0">
        <MarkdownPart
          text={text}
          state={state}
          onOpenCitation={onOpenCitation}
          className="max-w-full min-w-0 text-[13px] leading-6 break-words text-muted [&_*]:max-w-full [&_*]:break-words [&_a]:max-w-full [&_a]:[overflow-wrap:anywhere] [&_a]:break-words [&_button]:max-w-full [&_button]:[overflow-wrap:anywhere] [&_button]:break-words [&_code]:[overflow-wrap:anywhere] [&_code]:break-words [&_li]:my-0.5 [&_li]:pl-1 [&_li>p]:my-0 [&_ol]:pl-6 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_ul]:pl-6"
        />
      </div>
    </details>
  );
}

function formatAngles(part: StartResearchPart): string[] {
  const raw = part.input?.angles;
  if (!Array.isArray(raw)) return [];

  const angles: string[] = [];
  for (const angle of raw) if (typeof angle === 'string') angles.push(angle);
  return angles;
}

/**
 * The approval card. The tool only proposed parameters — nothing runs until the
 * operator presses 开始研究, so the button is disabled while no handler exists
 * (the thread view wires it in T2.4).
 */
function StartResearchCard({
  part,
  onStart,
  onAdjustAngles,
}: {
  part: StartResearchPart;
  onStart?: ((idea: string) => void) | undefined;
  onAdjustAngles?: ((idea: string) => void) | undefined;
}) {
  const rawIdea = part.input?.idea;
  const idea = typeof rawIdea === 'string' ? rawIdea : '';
  const angles = formatAngles(part);

  return (
    <Card>
      <CardHeader>
        <CardTitle>开始完整研究？</CardTitle>
        <p className="text-xs text-muted">预计耗时约 35 分钟，会采集一手帖子与定价页</p>
      </CardHeader>
      <CardContent className="flex max-w-full min-w-0 flex-col gap-3">
        {idea === '' ? (
          <p className="text-sm text-muted">正在整理研究主题…</p>
        ) : (
          <p className="text-sm text-fg">{idea}</p>
        )}
        {angles.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {angles.map((angle) => (
              <li key={angle}>
                <Badge>{angle}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onStart?.(idea)} disabled={!onStart || idea === ''}>
            开始研究
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAdjustAngles?.(idea)}
            disabled={!onAdjustAngles}
          >
            调整角度
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const SIGNAL_LABELS: Readonly<Record<string, string>> = {
  problem: '问题',
  seeking: '寻找',
  paying: '付费',
  switching: '切换',
  recurring: '持续',
};

function evidenceConditions(part: QueryEvidencePart): string {
  const conditions: string[] = [];
  const input = part.input;
  if (input?.signal !== undefined) {
    conditions.push(`信号 ${SIGNAL_LABELS[input.signal] ?? input.signal}`);
  }
  if (input?.platform !== undefined) conditions.push(`平台 ${input.platform}`);
  if (input?.q !== undefined) conditions.push(`关键词“${input.q}”`);
  return conditions.length === 0 ? '未加筛选' : conditions.join(' · ');
}

/**
 * Evidence searches grouped per answer. An empty result shows what was asked
 * and why nothing came back (still collecting, failed run, no evidence yet)
 * instead of a bare "没有找到足够证据" the reader cannot act on.
 */
function QueryEvidenceCard({ parts }: { parts: QueryEvidencePart[] }) {
  const outputs = parts.map((part) =>
    part.state === 'output-available' ? part.output : undefined,
  );

  const seen = new Set<string>();
  const items: EvidenceItem[] = [];
  for (const output of outputs) {
    for (const item of output?.items ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  const note = [...outputs].reverse().find((output) => output?.note !== undefined)?.note;
  const errored = parts.some((part) => part.state === 'output-error');
  const conditions = [...new Set(parts.map(evidenceConditions))];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          证据检索
          {parts.length > 1 ? (
            <span className="ml-1 text-[11px] font-normal text-faint">· {parts.length} 次</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-[11px] text-faint">检索条件：{conditions.join('；')}</p>
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            {errored ? '证据检索失败' : (note ?? '本会话还没有可引用的证据。')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Badge tone="accent">{item.platform}</Badge>
                  {item.url !== undefined && <SourceLink href={item.url} />}
                </div>
                <p className="text-sm text-fg">{item.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The action panel that closes an answer: the agent states a conclusion, then
 * offers the concrete next steps as buttons instead of a prose list.
 */
function OptionsCard({
  part,
  onChoose,
}: {
  part: PresentOptionsPart;
  onChoose?: ((option: { label: string; description?: string }) => void) | undefined;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  type OptionShape = { id: string; label: string; description?: string };
  const input = part.input as { options?: OptionShape[] } | undefined;
  const stored = part as unknown as { options?: OptionShape[] };
  const options = input?.options ?? stored.options ?? [];
  if (options.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="下一步选项"
      className="rounded-xl border border-accent/40 bg-accent-soft/30 p-3"
    >
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-accent">
        <Sparkles className="size-3" aria-hidden="true" />
        选择一个方向继续
      </p>
      <div className="flex flex-col gap-2">
        {options.map((option) => {
          const disabled = onChoose === undefined || chosen !== null;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                setChosen(option.label);
                onChoose?.({
                  label: option.label,
                  ...(option.description === undefined ? {} : { description: option.description }),
                });
              }}
              className={cn(
                'group/option flex flex-col items-start gap-0.5 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors',
                disabled ? 'opacity-60' : 'hover:border-accent/50 hover:bg-surface-2',
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-fg">
                  {chosen === option.label ? '已选择 · ' : ''}
                  {option.label}
                </span>
                <ArrowRight
                  className="size-3.5 shrink-0 text-faint transition-transform group-hover/option:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
              {option.description === undefined ? null : (
                <span className="text-[11px] leading-5 text-muted">{option.description}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SourceLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[11px] text-accent underline-offset-2 hover:underline"
    >
      原文
    </a>
  );
}

function EvidenceMiniCard({
  part,
  onOpen,
}: {
  part: EvidenceDataPart;
  onOpen?: ((id: string) => void) | undefined;
}) {
  const { id, platform, summary } = part.data;

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Badge tone="accent">{platform}</Badge>
        <span className="text-[11px] text-faint">{id}</span>
      </div>
      <p className="text-sm text-fg">{summary}</p>
      <div className="flex items-center gap-2">
        {part.data.url !== undefined && <SourceLink href={part.data.url} />}
        {onOpen !== undefined && (
          <Button variant="ghost" size="sm" onClick={() => onOpen(id)}>
            查看证据
          </Button>
        )}
      </div>
    </Card>
  );
}
