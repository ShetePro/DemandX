import { describe, expect, it, vi } from 'vitest';

import { startResearchAction } from './actions';

const mocks = vi.hoisted(() => ({
  createResearch: vi.fn(),
  enqueueS1: vi.fn(),
}));

vi.mock('@/lib/runs/repository', () => ({
  createResearch: mocks.createResearch,
  createRun: vi.fn(),
  createThread: vi.fn(),
  createRunInputSchema: { safeParse: () => ({ success: false }) },
  createThreadInputSchema: { safeParse: () => ({ success: false }) },
  formatIssues: (error: { issues: { message: string }[] }) =>
    error.issues.map((issue) => issue.message).join('；'),
}));

vi.mock('@/lib/runs/queue', () => ({ enqueueS1: mocks.enqueueS1 }));

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
