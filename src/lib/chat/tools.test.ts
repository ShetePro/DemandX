import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRerun: vi.fn(),
  enqueueS1: vi.fn(),
  getRun: vi.fn(),
  listRunsForThread: vi.fn(),
  readEvents: vi.fn(),
  searchThreadEvidence: vi.fn(),
}));

vi.mock('@/lib/runs/repository', () => ({
  createRerun: mocks.createRerun,
  getRun: mocks.getRun,
  listRunsForThread: mocks.listRunsForThread,
  readEvents: mocks.readEvents,
}));
vi.mock('@/lib/runs/queue', () => ({ enqueueS1: mocks.enqueueS1 }));
vi.mock('@/lib/runs/evidence-repository', () => ({
  searchThreadEvidence: mocks.searchThreadEvidence,
}));

import {
  createChatTools,
  type EvidenceItem,
  type QueryEvidenceInput,
  type RerunResearchOutput,
  type RunStatusOutput,
} from './tools';

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

    expect(mocks.createRerun).toHaveBeenCalledWith(7, undefined);
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

  it('passes a chosen focus to the rerun', async () => {
    mocks.createRerun.mockResolvedValue({ ok: true, value: { runId: 50, threadId: 7 } });
    mocks.enqueueS1.mockResolvedValue({ ok: true, value: { jobId: 'job-2' } });

    const tools = createChatTools({ threadId: 7 });
    const tool = tools.rerun_research as unknown as {
      execute: (input: { focus?: string }) => Promise<RerunResearchOutput>;
    };
    await tool.execute({ focus: '只验证发票收款环节' });

    expect(mocks.createRerun).toHaveBeenCalledWith(7, '只验证发票收款环节');
  });

  describe('get_run_status tool', () => {
    function executeStatus(tools: ReturnType<typeof createChatTools>) {
      const tool = tools.get_run_status as unknown as {
        execute: (input: { runId?: number }) => Promise<RunStatusOutput>;
      };
      return tool.execute({});
    }

    it('reports the newest run of the thread with evidence and decision', async () => {
      mocks.listRunsForThread.mockResolvedValue({
        ok: true,
        value: [{ id: 230 }, { id: 231 }],
      });
      mocks.getRun.mockResolvedValue({
        ok: true,
        value: { id: 231, status: 'finished', stage: 'S6' },
      });
      mocks.readEvents.mockResolvedValue({
        ok: true,
        value: [
          { type: 'report.ready', payload: { reportId: 9, decision: '建议放弃' } },
          { type: 'run.finished', payload: { accepted: 3 } },
        ],
      });

      const result = await executeStatus(createChatTools({ threadId: 7 }));

      expect(mocks.getRun).toHaveBeenCalledWith(231);
      expect(result).toEqual({
        status: 'ok',
        runId: 231,
        state: 'finished',
        stage: 'S6',
        accepted: 3,
        decision: '建议放弃',
        reportId: 9,
        active: false,
      });
    });

    it('marks queued and running runs as active', async () => {
      mocks.listRunsForThread.mockResolvedValue({ ok: true, value: [{ id: 5 }] });
      mocks.getRun.mockResolvedValue({
        ok: true,
        value: { id: 5, status: 'running', stage: 'S1' },
      });
      mocks.readEvents.mockResolvedValue({ ok: true, value: [] });

      const result = await executeStatus(createChatTools({ threadId: 7 }));

      expect(result).toMatchObject({ runId: 5, active: true, state: 'running' });
    });

    it('refuses without a thread when no runId is given', async () => {
      const result = await executeStatus(createChatTools());
      expect(result.status).toBe('unavailable');
    });
  });

  describe('query_evidence tool', () => {
    function executeQuery(tools: ReturnType<typeof createChatTools>) {
      const tool = tools.query_evidence as unknown as {
        execute: (input: QueryEvidenceInput) => Promise<{ items: EvidenceItem[] }>;
      };
      return tool.execute({ signal: 'paying', q: '发票' });
    }

    it('reads accepted evidence from the conversation history', async () => {
      mocks.searchThreadEvidence.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 12,
            platform: 'Reddit',
            signal: 'paying',
            quote: '愿意每月付 20 美元',
            supports: '存在付费行为',
            url: 'https://reddit.com/r/x',
          },
        ],
      });

      const result = await executeQuery(createChatTools({ threadId: 7 }));

      expect(mocks.searchThreadEvidence).toHaveBeenCalledWith(7, { signal: 'paying', q: '发票' });
      expect(result.items).toEqual([
        {
          id: '12',
          platform: 'Reddit',
          summary: '愿意每月付 20 美元（存在付费行为）',
          signal: 'paying',
          url: 'https://reddit.com/r/x',
        },
      ]);
    });

    it('falls back to the conversation evidence when a keyword misses', async () => {
      mocks.searchThreadEvidence
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({
          ok: true,
          value: [
            {
              id: 3,
              platform: 'Reddit',
              signal: 'problem',
              quote: '月底对账全靠手工',
              supports: null,
              url: 'https://reddit.com/r/y',
            },
          ],
        });

      const result = await executeQuery(createChatTools({ threadId: 7 }));

      expect(mocks.searchThreadEvidence).toHaveBeenNthCalledWith(1, 7, {
        signal: 'paying',
        q: '发票',
      });
      expect(mocks.searchThreadEvidence).toHaveBeenNthCalledWith(2, 7, {});
      expect(result.items.map((item) => item.id)).toEqual(['3']);
    });
    it('returns an empty list without touching the database when there is no thread', async () => {
      const result = await executeQuery(createChatTools());

      expect(result.items).toEqual([]);
      expect(mocks.searchThreadEvidence).not.toHaveBeenCalled();
    });
  });

  describe('present_options tool', () => {
    it('acknowledges the panel without side effects', async () => {
      const tools = createChatTools({ threadId: 7 });
      const tool = tools.present_options as unknown as {
        execute: (input: {
          options: { id: string; label: string }[];
        }) => Promise<{ status: string }>;
      };

      await expect(
        tool.execute({
          options: [
            { id: 'a', label: '继续' },
            { id: 'b', label: '放弃' },
          ],
        }),
      ).resolves.toEqual({ status: 'shown' });
    });
  });
});
