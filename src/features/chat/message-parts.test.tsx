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

  it('explains an empty evidence query and shows what was searched', () => {
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

    expect(screen.getByText('证据检索')).toBeVisible();
    expect(screen.getByText('检索条件：关键词“库存同步”')).toBeVisible();
    expect(screen.getByText('本会话还没有可引用的证据。')).toBeVisible();
  });

  it('collapses repeated evidence searches into one card with the reason', () => {
    render(
      <MessageParts
        message={message([
          {
            type: 'tool-query_evidence',
            toolCallId: 'call-3',
            state: 'output-available',
            input: { signal: 'problem' },
            output: {
              items: [],
              note: 'run 238 正在进行（S1）；证据通过 S2 抽取校验后才会入库，现在检索不到是正常的。',
            },
          },
          {
            type: 'tool-query_evidence',
            toolCallId: 'call-4',
            state: 'output-available',
            input: { signal: 'switching' },
            output: {
              items: [],
              note: 'run 238 正在进行（S1）；证据通过 S2 抽取校验后才会入库，现在检索不到是正常的。',
            },
          },
        ])}
      />,
    );

    expect(screen.getByText('证据检索')).toBeVisible();
    expect(screen.getByText('· 2 次')).toBeVisible();
    expect(screen.getByText(/检索条件：信号 问题；信号 切换/)).toBeVisible();
    expect(screen.getByText(/S2 抽取校验后才会入库/)).toBeVisible();
  });

  it('tags conclusions and inferences so the answer has a hierarchy', () => {
    const { container } = render(
      <MessageParts
        message={message([
          {
            type: 'text',
            text: '**结论：** 值得先验证，但还不到下结论的时候。\n\n**推断：** 这个痛点是结构性的。\n\n**未知：** 还没有真实的付费样本。',
            state: 'done',
          },
        ])}
      />,
    );

    expect(container.querySelector('[data-claim="conclusion"]')).not.toBeNull();
    expect(container.querySelector('[data-claim="inference"]')).not.toBeNull();
    expect(container.querySelector('[data-claim="unknown"]')).not.toBeNull();
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

  it('strips javascript: link targets coming from model output', () => {
    const { container } = render(
      <MessageParts
        message={message([{ type: 'text', text: '看这里 [点击](javascript:alert(1)) 。' }])}
      />,
    );

    expect(container.innerHTML).not.toContain('javascript:');
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toContain('javascript:');
    }
    expect(container.textContent).toContain('[blocked]');
  });

  it('drops data: image sources coming from model output', () => {
    const { container } = render(
      <MessageParts
        message={message([
          { type: 'text', text: '![x](data:text/html,<script>alert(1)</script>)' },
        ])}
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[Image blocked: x]');
  });

  it('keeps ordinary https links clickable', () => {
    const { container } = render(
      <MessageParts
        message={message([{ type: 'text', text: '参考 [链接](https://example.com)。' }])}
      />,
    );

    const link = container.querySelector('[data-streamdown="link"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('链接');
    expect(container.textContent).not.toContain('[blocked]');
  });

  it('leaves citations inside fenced code alone', () => {
    render(
      <MessageParts
        message={message([
          { type: 'text', text: '```ts\nconst a = "[e14]";\n```\n\n正文 [e15]', state: 'done' },
        ])}
      />,
    );

    expect(screen.queryByRole('button', { name: '证据 e14' })).toBeNull();
    expect(screen.getByRole('button', { name: '证据 e15' })).toBeVisible();
  });

  it('shows the reasoning while it streams, with the pulse and the text', () => {
    const { container } = render(
      <MessageParts
        message={message([
          { type: 'reasoning', text: '先看价格页，再看招聘帖。', state: 'streaming' },
        ])}
      />,
    );

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('思考过程')).toBeVisible();
    expect(screen.getByText('先看价格页，再看招聘帖。')).toBeVisible();
  });

  it('collapses the reasoning once the turn is done without losing the text', () => {
    const { container } = render(
      <MessageParts
        message={message([{ type: 'reasoning', text: '先看价格页，再看招聘帖。', state: 'done' }])}
      />,
    );

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('思考过程')).toBeVisible();
    expect(container.textContent).toContain('先看价格页，再看招聘帖。');
  });

  it('merges consecutive reasoning parts into one block', () => {
    const { container } = render(
      <MessageParts
        message={message([
          { type: 'reasoning', text: '先看价格页。', state: 'done' },
          { type: 'reasoning', text: '再看招聘帖。', state: 'done' },
        ])}
      />,
    );

    expect(container.querySelectorAll('details')).toHaveLength(1);
    expect(container.textContent).toContain('先看价格页。再看招聘帖。');
  });

  it('skips an unknown part instead of throwing, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = message([{ type: 'source-url', sourceId: 's1', url: 'https://example.com' }]);

    expect(() => render(<MessageParts message={unknown} />)).not.toThrow();
    render(<MessageParts message={unknown} />);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('source-url'));
  });

  it('renders the option panel and reports the chosen label', async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    render(
      <MessageParts
        message={message([
          {
            type: 'tool-present_options',
            toolCallId: 'call-options',
            state: 'output-available',
            input: {
              options: [
                { id: 'narrow', label: '收窄到发票收款', description: '只验证计费环节' },
                { id: 'stop', label: '放弃这个方向', description: '结束验证' },
              ],
            },
            output: { status: 'shown' },
          },
        ])}
        onChooseOption={choose}
      />,
    );

    const panel = screen.getByRole('group', { name: '下一步选项' });
    expect(panel).toHaveTextContent('收窄到发票收款');
    await user.click(screen.getByRole('button', { name: /收窄到发票收款/ }));
    expect(choose).toHaveBeenCalledWith({
      label: '收窄到发票收款',
      description: '只验证计费环节',
    });
    expect(screen.getByRole('button', { name: /收窄到发票收款/ })).toBeDisabled();
  });
});
