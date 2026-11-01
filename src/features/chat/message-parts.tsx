'use client';

import { cjk } from '@streamdown/cjk';
import { useMemo, type ComponentProps } from 'react';
import { harden } from 'rehype-harden';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Streamdown, type Components } from 'streamdown';

import { CitationChip } from '@/components/common/citation-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChatMessage } from '@/lib/chat/types';
import { useCodeHighlighter } from '@/lib/hooks/use-code-highlighter';

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
  [harden, HARDEN_OPTIONS],
];

type ChatPart = ChatMessage['parts'][number];
type StartResearchPart = Extract<ChatPart, { type: 'tool-start_research' }>;
type QueryEvidencePart = Extract<ChatPart, { type: 'tool-query_evidence' }>;
type EvidenceDataPart = Extract<ChatPart, { type: 'data-evidence' }>;

export type MessagePartsProps = {
  message: ChatMessage;
  /** Opens the evidence drawer for a `[eN]` anchor or an evidence card. */
  onOpenCitation?: ((id: string) => void) | undefined;
  /** Confirmed in the approval card — the caller creates the run. */
  onStart?: ((idea: string) => void) | undefined;
  onAdjustAngles?: ((idea: string) => void) | undefined;
};

export function MessageParts({
  message,
  onOpenCitation,
  onStart,
  onAdjustAngles,
}: MessagePartsProps) {
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-3">
      {coalesceReasoning(message.parts).map((part, index) => {
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
          case 'tool-query_evidence':
            return <QueryEvidenceCard key={index} part={part} />;
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
      className="max-w-full min-w-0 text-sm leading-7 break-words text-fg [&_*]:max-w-full [&_*]:break-words [&_a]:max-w-full [&_a]:[overflow-wrap:anywhere] [&_a]:break-words [&_button]:max-w-full [&_button]:[overflow-wrap:anywhere] [&_button]:break-words [&_code]:[overflow-wrap:anywhere] [&_code]:break-words [&_li]:my-0.5 [&_li]:pl-1 [&_li>p]:my-0 [&_ol]:pl-6 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_ul]:pl-6"
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

/** Evidence retrieval runs on an empty set until P4 wires the real store. */
function QueryEvidenceCard({ part }: { part: QueryEvidencePart }) {
  const output = part.state === 'output-available' ? part.output : undefined;
  const items = output?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>证据检索</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            {part.state === 'output-error' ? '证据检索失败' : '没有找到足够证据'}
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
