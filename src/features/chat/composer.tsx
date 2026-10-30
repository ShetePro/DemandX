'use client';

import { SendHorizontal, Square } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAutoResize } from '@/lib/hooks/use-auto-resize';
import { cn } from '@/lib/utils/cn';

export type ComposerProps = {
  onSend: (text: string) => void;
  onStop: () => void;
  /** A reply is being streamed: the send button becomes 停止. */
  isStreaming?: boolean;
  placeholder?: string;
  /** `hero` is the new-research screen's larger first-paint composer. */
  size?: 'default' | 'hero';
  /** Controlled draft. Omit both to keep the original internal state. */
  value?: string;
  onValueChange?: (value: string) => void;
};

/**
 * Message input. Enter sends, Shift+Enter inserts a newline, and Enter never
 * submits while an IME is composing — that keystroke belongs to the candidate
 * window, not the conversation.
 */
export function Composer({
  onSend,
  onStop,
  isStreaming = false,
  placeholder = '描述一个产品想法，或粘贴一段用户抱怨…',
  size = 'default',
  value,
  onValueChange,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const controlled = value !== undefined;
  const current = value ?? draft;
  const { ref } = useAutoResize({ value: current });
  const text = current.trim();
  const hero = size === 'hero';

  function update(next: string): void {
    if (!controlled) setDraft(next);
    onValueChange?.(next);
  }

  function send(): void {
    if (isStreaming || text === '') return;
    onSend(text);
    update('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // `isComposing` is true between compositionstart and compositionend; the
    // same key event is then consuming the IME candidate, not sending.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  return (
    <div
      className={cn(
        'border border-border bg-surface',
        hero
          ? 'rounded-2xl p-3 shadow-lg focus-within:border-border-strong'
          : 'rounded-xl border-border/80 bg-surface/95 p-2 shadow-lg backdrop-blur-md focus-within:border-border-strong',
      )}
    >
      <Textarea
        ref={ref}
        rows={1}
        value={current}
        onChange={(event) => update(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="输入消息"
        name="message"
        className={cn(
          'resize-none border-0 bg-transparent px-2 shadow-none focus-visible:outline-none',
          hero
            ? 'max-h-[220px] min-h-20 py-2 text-base leading-relaxed'
            : 'max-h-[136px] min-h-9 py-1.5',
        )}
      />
      <div className={cn('flex items-center justify-between gap-2 px-1', hero ? 'pt-2' : 'pt-1')}>
        <span className={cn('text-faint', hero ? 'text-xs' : 'text-[11px]')}>
          Enter 发送 · Shift+Enter 换行
        </span>
        {isStreaming ? (
          <Button size="icon" variant="ghost" aria-label="停止" onClick={onStop}>
            <Square className="size-4" />
          </Button>
        ) : (
          <Button size="icon" aria-label="发送" onClick={send} disabled={text === ''}>
            <SendHorizontal className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
