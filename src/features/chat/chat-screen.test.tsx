import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/chat/types';

import { ChatScreen } from './chat-screen';

const mocks = vi.hoisted(() => ({
  createRunAction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: 'ready' as 'ready' | 'streaming',
}));

vi.mock('@ai-sdk/react', () => ({
  useChat: (options: { messages?: unknown[] } = {}) => ({
    messages: options.messages ?? [],
    status: mocks.status,
    sendMessage: mocks.sendMessage,
    stop: mocks.stop,
  }),
}));

vi.mock('./actions', () => ({ createRunAction: mocks.createRunAction }));

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
      input: { idea: '跨境卖家的多平台库存同步工具', angles: ['旺季爆单'] },
    },
  ],
};

beforeEach(() => {
  mocks.status = 'ready';
});

describe('ChatScreen', () => {
  it('renders the persisted history from the server', () => {
    render(
      <ChatScreen threadId={1} initialMessages={[TEXT_MESSAGE]} runId={null} evidenceHref={null} />,
    );

    expect(screen.getByText(/付费意愿集中在旺季/)).toBeVisible();
    expect(screen.getByTestId('run-rail')).toHaveTextContent('尚未开始研究');
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
        idea: '跨境卖家的多平台库存同步工具',
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
    expect(screen.getByTestId('run-rail')).toHaveTextContent('尚未开始研究');
  });
});
