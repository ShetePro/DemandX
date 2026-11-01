import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRerun: vi.fn(),
  enqueueS1: vi.fn(),
}));

vi.mock('@/lib/runs/repository', () => ({ createRerun: mocks.createRerun }));
vi.mock('@/lib/runs/queue', () => ({ enqueueS1: mocks.enqueueS1 }));

import { createChatTools, type RerunResearchOutput } from './tools';

function executeRerun(tools: ReturnType<typeof createChatTools>) {
  const tool = tools.rerun_research as unknown as {
    execute: (input: { reason?: string }) => Promise<RerunResearchOutput>;
  };
  return tool.execute({ reason: '用户要求重新验证' });
}

describe('rerun_research tool', () => {
  it('starts a run for the current thread and enqueues S1', async () => {
    mocks.createRerun.mockResolvedValue({ ok: true, value: { runId: 42, threadId: 7 } });
    mocks.enqueueS1.mockResolvedValue({ ok: true, value: { jobId: 'job-1' } });

    const result = await executeRerun(createChatTools({ threadId: 7 }));

    expect(mocks.createRerun).toHaveBeenCalledWith(7);
    expect(mocks.enqueueS1).toHaveBeenCalledWith(42);
    expect(result).toEqual({ status: 'started', runId: 42 });
  });

  it('refuses when the chat is not attached to a thread', async () => {
    const result = await executeRerun(createChatTools());

    expect(result.status).toBe('unavailable');
    expect(mocks.createRerun).not.toHaveBeenCalled();
  });

  it('reports a storage failure instead of claiming the run started', async () => {
    mocks.createRerun.mockResolvedValue({ ok: false, code: 'NOT_FOUND', message: '会话不存在' });

    const result = await executeRerun(createChatTools({ threadId: 9 }));

    expect(result).toEqual({ status: 'failed', message: '会话不存在' });
    expect(mocks.enqueueS1).not.toHaveBeenCalled();
  });

  it('reports a queue failure after the run was created', async () => {
    mocks.createRerun.mockResolvedValue({ ok: true, value: { runId: 43, threadId: 9 } });
    mocks.enqueueS1.mockResolvedValue({ ok: false, code: 'STORAGE_FAILED', message: 'pg 挂了' });

    const result = await executeRerun(createChatTools({ threadId: 9 }));

    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toContain('入队失败');
  });
});
