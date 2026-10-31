'use client';

import { SendHorizontal, Square } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAutoResize } from '@/lib/hooks/use-auto-resize';

export type ComposerProps = {
  onSend: (text: string) => void;
  onStop: () => void;
  /** A reply is being streamed: the send button becomes 停止. */
  isStreaming?: boolean;
  placeholder?: string;
  /** Controlled draft. Omit both to keep the original internal state. */
  value?: string;
  onValueChange?: (value: string) => void;
};

/**
 * Message input. Enter sends, Shift+Enter inserts a newline, and Enter never
 * submits while an IME is composing — that keystroke belongs to the candidate
 * window, not the conversation.
 *
 * There is exactly one look: the new-research screen docks this same box into
 * the thread page, so any variant would be a visible flicker mid-flight.
 */
export function Composer({
  onSend,
  onStop,
  isStreaming = false,
  placeholder = '描述一个产品想法，或粘贴一段用户抱怨…',
  value,
  onValueChange,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const controlled = value !== undefined;
  const current = value ?? draft;
  const { ref } = useAutoResize({ value: current });
  const text = current.trim();

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
    <div className="rounded-2xl border border-border bg-surface/95 p-3 shadow-lg backdrop-blur-md focus-within:border-border-strong">
      <Textarea
        ref={ref}
        rows={1}
        value={current}
        onChange={(event) => update(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="输入消息"
        name="message"
        className="max-h-[240px] min-h-16 resize-none border-0 bg-transparent px-2 py-2 text-[15px] leading-relaxed shadow-none focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-1 pt-2">
        <span className="text-xs text-faint">Enter 发送 · Shift+Enter 换行</span>
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
