import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/chat/types';

import { ChatScreen } from './chat-screen';

type ChatOptions = {
  messages?: unknown[];
  onFinish?: (event: { message: unknown }) => void;
};

const mocks = vi.hoisted(() => ({
  createRunAction: vi.fn(),
  appendAssistantMessageAction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: 'ready' as 'ready' | 'streaming',
  /** The options the component handed to `useChat` on the last render. */
  options: null as ChatOptions | null,
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: ChatOptions = {}) => {
    mocks.options = options;
    return {
      messages: options.messages ?? [],
      status: mocks.status,
      sendMessage: mocks.sendMessage,
      stop: mocks.stop,
    };
  },
}));

vi.mock('./actions', () => ({
  createRunAction: mocks.createRunAction,
  appendAssistantMessageAction: mocks.appendAssistantMessageAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: () => ({ scrollRef: { current: null }, contentRef: { current: null } }),
}));

vi.mock('./run-rail', () => ({
  RunRail: ({ runId }: { runId: number | null }) => (
    <div data-testid="run-rail">{runId === null ? '尚未开始研究' : `run-${runId}`}</div>
  ),
}));

// The live card owns its SSE connection; its own suite covers that.
vi.mock('./run-activity', () => ({
  RunActivity: ({ runId }: { runId: number | null }) =>
    runId === null ? null : <div data-testid="run-activity">{`run-${runId}`}</div>,
}));

const IDEA = '跨境卖家的多平台库存同步工具';

const USER_MESSAGE: ChatMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: IDEA, state: 'done' }],
};

const TEXT_MESSAGE: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  parts: [{ type: 'text', text: '先看证据：付费意愿集中在旺季。', state: 'done' }],
};

const APPROVAL_MESSAGE: ChatMessage = {
  id: 'm2',
  role: 'assistant',
  parts: [
    {
      type: 'tool-start_research',
      toolCallId: 'call-1',
      state: 'input-available',
      input: { idea: IDEA, angles: ['旺季爆单'] },
    },
  ],
};

beforeEach(() => {
  mocks.status = 'ready';
  mocks.options = null;
});

describe('ChatScreen', () => {
  it('renders the persisted history from the server', () => {
    render(
      <ChatScreen threadId={1} initialMessages={[TEXT_MESSAGE]} runId={null} evidenceHref={null} />,
    );

    expect(screen.getByText(/付费意愿集中在旺季/)).toBeVisible();
  });

  it('does not render the run rail before a run exists', () => {
    const { container } = render(
      <ChatScreen threadId={1} initialMessages={[TEXT_MESSAGE]} runId={null} evidenceHref={null} />,
    );

    expect(container.querySelector('aside[aria-label="运行详情"]')).toBeNull();
    expect(screen.queryByTestId('run-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-activity')).not.toBeInTheDocument();
  });

  it('creates the run from the approval card and refreshes the page', async () => {
    const user = userEvent.setup();
    mocks.createRunAction.mockResolvedValue({
      ok: true,
      value: { runId: 42, threadId: 1 },
    });

    render(
      <ChatScreen
        threadId={1}
        initialMessages={[APPROVAL_MESSAGE]}
        runId={null}
        evidenceHref={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: '开始研究' }));

    await waitFor(() =>
      expect(mocks.createRunAction).toHaveBeenCalledWith({
        threadId: 1,
        idea: IDEA,
      }),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalledWith('研究已开始');
    await waitFor(() => expect(screen.getByTestId('run-rail')).toHaveTextContent('run-42'));
  });

  it('keeps the old state and reports the failure when the run cannot be created', async () => {
    const user = userEvent.setup();
    mocks.createRunAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '创建 run 失败 (SQLSTATE 08006)',
    });

    render(
      <ChatScreen
        threadId={1}
        initialMessages={[APPROVAL_MESSAGE]}
        runId={null}
        evidenceHref={null}
      />,
    );

    await user.click(screen.getByRole('button', { name: '开始研究' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('创建 run 失败 (SQLSTATE 08006)'));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(document.querySelector('aside[aria-label="运行详情"]')).toBeNull();
  });

  it('asks the first question once instead of duplicating the stored turn', () => {
    render(
      <ChatScreen
        threadId={1}
        initialMessages={[USER_MESSAGE]}
        autoPrompt={IDEA}
        runId={7}
        evidenceHref={null}
      />,
    );

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith({ text: IDEA });
    // The persisted question is dropped from the seed; sending adds it back, so
    // the transcript holds one bubble, never two.
    expect(mocks.options?.messages).toEqual([]);
    expect(screen.queryByText(IDEA)).not.toBeInTheDocument();
  });

  it('does not ask again when the thread already has an answer', () => {
    render(
      <ChatScreen
        threadId={1}
        initialMessages={[USER_MESSAGE, TEXT_MESSAGE]}
        autoPrompt={IDEA}
        runId={7}
        evidenceHref={null}
      />,
    );

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.options?.messages).toHaveLength(2);
  });

  it('does not send the prompt twice when the component re-renders', () => {
    const { rerender } = render(
      <ChatScreen
        threadId={1}
        initialMessages={[USER_MESSAGE]}
        autoPrompt={IDEA}
        runId={7}
        evidenceHref={null}
      />,
    );

    rerender(
      <ChatScreen
        threadId={1}
        initialMessages={[USER_MESSAGE]}
        autoPrompt={IDEA}
        runId={7}
        evidenceHref={null}
      />,
    );

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('persists the streamed answer, keeping text and reasoning only', async () => {
    mocks.appendAssistantMessageAction.mockResolvedValue({
      ok: true,
      value: { inserted: true, id: 3 },
    });

    render(
      <ChatScreen threadId={1} initialMessages={[USER_MESSAGE]} runId={7} evidenceHref={null} />,
    );

    await act(async () => {
      mocks.options?.onFinish?.({
        message: {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '先确认价格页', state: 'done' },
            { type: 'text', text: '付费意愿集中在旺季。', state: 'done' },
            {
              type: 'tool-query_evidence',
              toolCallId: 'call-2',
              state: 'input-available',
              input: { q: '库存同步' },
            },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(mocks.appendAssistantMessageAction).toHaveBeenCalledWith(1, [
        { type: 'reasoning', text: '先确认价格页' },
        { type: 'text', text: '付费意愿集中在旺季。' },
      ]),
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('tells the operator when the answer could not be saved', async () => {
    mocks.appendAssistantMessageAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '保存助手回复失败 (SQLSTATE 08006)',
    });

    render(
      <ChatScreen threadId={1} initialMessages={[USER_MESSAGE]} runId={7} evidenceHref={null} />,
    );

    await act(async () => {
      mocks.options?.onFinish?.({
        message: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答案' }] },
      });
    });

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('保存回复失败：保存助手回复失败 (SQLSTATE 08006)'),
    );
  });
});
