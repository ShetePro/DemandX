import { describe, expect, it, vi } from 'vitest';

// The tools only prepare arguments; touching the database would mean chat had
// side effects before the operator confirms. The factory records *whether the
// import graph reached the db client at all* — a plain flag, not a mock, so
// `clearMocks` between tests cannot erase the evidence.
const dbClientImport = vi.hoisted(() => ({ reached: false }));

vi.mock('@/lib/db/client', () => {
  dbClientImport.reached = true;
  return { db: {} };
});

import {
  SIGNALS,
  createChatTools,
  prepareStartResearch,
  queryEvidence,
  queryEvidenceInputSchema,
  startResearchInputSchema,
} from './tools';

describe('chat tools', () => {
  it('never imports the database client', () => {
    expect(dbClientImport.reached).toBe(false);
  });

  it('wires both tools for the model', () => {
    const tools = createChatTools();

    expect(Object.keys(tools)).toEqual(['query_evidence', 'start_research']);
    expect(tools.start_research.execute).toBe(prepareStartResearch);
    expect(tools.query_evidence.execute).toBe(queryEvidence);
  });

  it('start_research only asks for confirmation', async () => {
    const result = await prepareStartResearch({ idea: '跨境卖家的多平台库存同步工具' });

    expect(result).toEqual({
      status: 'needs_confirmation',
      idea: '跨境卖家的多平台库存同步工具',
      angles: [],
    });
  });

  it('start_research echoes the prepared angles without creating a run', async () => {
    const result = await prepareStartResearch({
      idea: '独立开发者的发票与报销工具',
      angles: ['报税季痛点', '会计软件替代'],
    });

    expect(result.angles).toEqual(['报税季痛点', '会计软件替代']);
    expect(result).not.toHaveProperty('runId');
  });

  it('query_evidence returns an empty list until real evidence exists', async () => {
    await expect(queryEvidence()).resolves.toEqual({ items: [] });
  });

  it('rejects an idea shorter than 8 characters', () => {
    expect(startResearchInputSchema.safeParse({ idea: '太短' }).success).toBe(false);
  });

  it('caps the angle list at five entries', () => {
    const angles = ['一', '二', '三', '四', '五', '六'];

    expect(
      startResearchInputSchema.safeParse({ idea: '跨境卖家的多平台库存同步', angles }).success,
    ).toBe(false);
  });

  it('accepts only the five signal classes', () => {
    expect(SIGNALS).toHaveLength(5);
    expect(queryEvidenceInputSchema.safeParse({ signal: 'paying' }).success).toBe(true);
    expect(queryEvidenceInputSchema.safeParse({ signal: 'buzz' }).success).toBe(false);
  });
});
