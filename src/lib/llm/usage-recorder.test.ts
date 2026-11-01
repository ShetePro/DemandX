import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { usageWindowStart } from './usage-windows';
import type * as ClientModule from '@/lib/db/client';
import type * as RecorderModule from './usage-recorder';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    '拒绝在非 _test 数据库上运行集成测试：TEST_DATABASE_URL 的库名必须以 _test 结尾。',
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

// Static imports would evaluate the db client before DATABASE_URL is set; the
// dynamic import after `beforeAll` is the same pattern as repository.test.ts.
let recorder!: typeof RecorderModule;
let client!: typeof ClientModule;
const previous = process.env.DATABASE_URL;

suite('recordLlmUsage', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    recorder = await import('./usage-recorder');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE api_calls, provider_usage, llm_chains, provider_models, providers RESTART IDENTITY CASCADE',
    );
  });

  async function seedProvider(): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into providers (name, kind, base_url, enabled)
      values ('Local', 'ollama', 'http://127.0.0.1:11434', true)
      returning id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('provider insert returned no row');
    return id;
  }

  it('writes one ledger row and increments the three rolling windows', async () => {
    const providerId = await seedProvider();
    const now = new Date('2026-11-01T16:47:00.000Z');

    await recorder.recordLlmUsage({
      providerId,
      model: 'glm-5.3-flash',
      kind: 'openai-compatible',
      promptTokens: 120,
      completionTokens: 30,
      now,
    });
    await recorder.recordLlmUsage({
      providerId,
      model: 'glm-5.3-flash',
      kind: 'openai-compatible',
      promptTokens: 80,
      completionTokens: 20,
      now,
    });

    const calls = await client.sql<
      { model: string; prompt_tokens: number; completion_tokens: number }[]
    >`select model, prompt_tokens, completion_tokens from api_calls order by id`;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: 'glm-5.3-flash', prompt_tokens: 120 });

    const usage = await client.sql<
      { window: string; window_start: string; requests: number; prompt_tokens: number }[]
    >`select "window", window_start, requests, prompt_tokens from provider_usage order by "window"`;
    expect(usage).toHaveLength(3);
    for (const row of usage) {
      expect(row.requests).toBe(2);
      expect(Number(row.prompt_tokens)).toBe(200);
    }
    expect(
      new Date(String(usage.find((row) => row.window === '5h')?.window_start)).toISOString(),
    ).toBe('2026-11-01T15:00:00.000Z');
    expect(
      new Date(String(usage.find((row) => row.window === 'weekly')?.window_start)).toISOString(),
    ).toBe('2026-10-26T00:00:00.000Z');
    expect(
      new Date(String(usage.find((row) => row.window === 'monthly')?.window_start)).toISOString(),
    ).toBe('2026-11-01T00:00:00.000Z');
  });

  it('never throws when the write fails', async () => {
    await expect(
      recorder.recordLlmUsage({
        providerId: 999_999,
        model: 'x',
        kind: 'openai-compatible',
        promptTokens: 1,
        completionTokens: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('usageWindowStart', () => {
  it('floors 5h windows, starts weeks on Monday and months on the 1st', async () => {
    const sunday = new Date('2026-11-01T16:47:12.000Z');

    expect(usageWindowStart(sunday, '5h').toISOString()).toBe('2026-11-01T15:00:00.000Z');
    expect(usageWindowStart(sunday, 'weekly').toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(usageWindowStart(sunday, 'monthly').toISOString()).toBe('2026-11-01T00:00:00.000Z');

    expect(usageWindowStart(new Date('2026-11-01T04:59:59Z'), '5h').toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(usageWindowStart(new Date('2026-11-02T00:00:00Z'), 'weekly').toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });
});
