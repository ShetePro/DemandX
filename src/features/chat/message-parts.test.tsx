import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/chat/types';

import { MessageParts } from './message-parts';

function message(parts: ChatMessage['parts']): ChatMessage {
  return { id: 'message-1', role: 'assistant', parts };
}

describe('MessageParts', () => {
  it('turns [eN] anchors in assistant text into chips', () => {
    render(
      <MessageParts
        message={message([
          { type: 'text', text: '多数卖家仍在手工对账 [e12]，付费意愿集中在旺季。', state: 'done' },
        ])}
      />,
    );

    expect(screen.getByRole('button', { name: '证据 e12' })).toBeVisible();
  });

  it('opens the evidence drawer with the citation id', async () => {
    const user = userEvent.setup();
    const onOpenCitation = vi.fn();

    render(
      <MessageParts
        onOpenCitation={onOpenCitation}
        message={message([{ type: 'text', text: '价格战已经在打 [e3]。', state: 'done' }])}
      />,
    );

    await user.click(screen.getByRole('button', { name: '证据 e3' }));

    expect(onOpenCitation).toHaveBeenCalledWith('e3');
  });

  it('renders the research approval card and starts only on click', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();

    render(
      <MessageParts
        onStart={onStart}
        message={message([
          {
            type: 'tool-start_research',
            toolCallId: 'call-1',
            state: 'input-available',
            input: { idea: '跨境卖家的多平台库存同步工具', angles: ['旺季爆单'] },
          },
        ])}
      />,
    );

    expect(screen.getByText('开始完整研究？')).toBeVisible();
    expect(screen.getByText('跨境卖家的多平台库存同步工具')).toBeVisible();
    expect(screen.getByText('旺季爆单')).toBeVisible();
    expect(onStart).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '开始研究' }));

    expect(onStart).toHaveBeenCalledWith('跨境卖家的多平台库存同步工具');
  });

  it('says so when an evidence query returns nothing', () => {
    render(
      <MessageParts
        message={message([
          {
            type: 'tool-query_evidence',
            toolCallId: 'call-2',
            state: 'output-available',
            input: { q: '库存同步' },
            output: { items: [] },
          },
        ])}
      />,
    );

    expect(screen.getByText('没有找到足够证据')).toBeVisible();
  });

  it('renders a data-evidence mini card with platform and summary', () => {
    render(
      <MessageParts
        message={message([
          {
            type: 'data-evidence',
            data: { id: 'e12', platform: 'V2EX', summary: '卖家手工同步库存，旺季每天两小时' },
          },
        ])}
      />,
    );

    expect(screen.getByText('V2EX')).toBeVisible();
    expect(screen.getByText('卖家手工同步库存，旺季每天两小时')).toBeVisible();
  });

  it('skips an unknown part instead of throwing, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = message([{ type: 'reasoning', text: '先看付费证据' }]);

    expect(() => render(<MessageParts message={unknown} />)).not.toThrow();
    render(<MessageParts message={unknown} />);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reasoning'));
  });
});
