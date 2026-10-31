import { describe, expect, it, vi } from 'vitest';

import { appendAssistantMessageAction, startResearchAction } from './actions';

const mocks = vi.hoisted(() => ({
  createResearch: vi.fn(),
  appendAssistantMessage: vi.fn(),
  enqueueS1: vi.fn(),
}));

vi.mock('@/lib/runs/repository', () => ({
  appendAssistantMessage: mocks.appendAssistantMessage,
  createResearch: mocks.createResearch,
  createRun: vi.fn(),
  createThread: vi.fn(),
  createRunInputSchema: { safeParse: () => ({ success: false }) },
  createThreadInputSchema: { safeParse: () => ({ success: false }) },
  formatIssues: (error: { issues: { message: string }[] }) =>
    error.issues.map((issue) => issue.message).join('；'),
}));

vi.mock('@/lib/runs/queue', () => ({ enqueueS1: mocks.enqueueS1 }));

describe('appendAssistantMessageAction', () => {
  it('rejects a part type the transcript cannot render', async () => {
    await expect(
      appendAssistantMessageAction(7, [{ type: 'image', text: 'x' }]),
    ).resolves.toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(mocks.appendAssistantMessage).not.toHaveBeenCalled();
  });

  it('rejects a message that is not an array', async () => {
    await expect(appendAssistantMessageAction(7, '先看证据')).resolves.toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(mocks.appendAssistantMessage).not.toHaveBeenCalled();
  });

  it('drops empty fragments and stores text and reasoning only', async () => {
    mocks.appendAssistantMessage.mockResolvedValue({
      ok: true,
      value: { inserted: true, id: 11 },
    });

    await expect(
      appendAssistantMessageAction(7, [
        { type: 'reasoning', text: '先确认价格页' },
        { type: 'text', text: '   ' },
        { type: 'text', text: '付费意愿集中在旺季。', state: 'done' },
      ]),
    ).resolves.toEqual({ ok: true, value: { inserted: true, id: 11 } });

    expect(mocks.appendAssistantMessage).toHaveBeenCalledWith(7, [
      { type: 'reasoning', text: '先确认价格页' },
      { type: 'text', text: '付费意愿集中在旺季。' },
    ]);
  });

  it('reports a write that was already stored as not inserted', async () => {
    mocks.appendAssistantMessage.mockResolvedValue({
      ok: true,
      value: { inserted: false, id: 11 },
    });

    await expect(
      appendAssistantMessageAction(7, [{ type: 'text', text: '付费意愿集中在旺季。' }]),
    ).resolves.toEqual({ ok: true, value: { inserted: false, id: 11 } });
  });
});

describe('startResearchAction', () => {
  it('rejects an idea shorter than 8 characters before touching storage', async () => {
    const result = await startResearchAction({ idea: '发票太乱' });

    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: '想法至少 8 个字符',
    });
    expect(mocks.createResearch).not.toHaveBeenCalled();
  });

  it('creates the research and enqueues S1', async () => {
    mocks.createResearch.mockResolvedValue({
      ok: true,
      value: { ideaId: 3, threadId: 7, runId: 9 },
    });
    mocks.enqueueS1.mockResolvedValue({ ok: true, value: { jobId: 'job-1' } });

    await expect(startResearchAction({ idea: '跨境卖家库存同步太麻烦' })).resolves.toEqual({
      ok: true,
      value: { ideaId: 3, threadId: 7, runId: 9 },
    });
    expect(mocks.enqueueS1).toHaveBeenCalledWith(9);
  });
});
