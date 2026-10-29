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
}: ComposerProps) {
  const [value, setValue] = useState('');
  const { ref } = useAutoResize({ value });
  const text = value.trim();

  function send(): void {
    if (isStreaming || text === '') return;
    onSend(text);
    setValue('');
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
    <div className="rounded-xl border border-border bg-surface p-2 shadow-sm">
      <Textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="输入消息"
        className="max-h-[136px] min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <span className="text-[11px] text-faint">Enter 发送 · Shift+Enter 换行</span>
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
