import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from './types';
// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as ChainRepositoryModule from './chain-repository';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

/** Database name from a postgres URL, or '' when it cannot be parsed. */
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// Integration tests TRUNCATE tables. Refuse to run against anything that is not
// an explicitly named `*_test` database, even if a bad URL is passed in.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

// `process.env.DATABASE_URL` is read when the db client first loads, so the URL
// is installed in `beforeAll` and the module is imported dynamically.
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let repo!: typeof ChainRepositoryModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

type ChainRow = { profile: string; position: number; provider_id: number; model_id: string };

suite('chain repository', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    repo = await import('./chain-repository');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe('TRUNCATE providers, llm_chains RESTART IDENTITY CASCADE');
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  async function provider(
    name: string,
    kind: string,
    baseUrl: string,
    enabled: boolean,
    headers: Record<string, string> = {},
  ): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into providers (name, kind, base_url, enabled, headers)
      values (${name}, ${kind}, ${baseUrl}, ${enabled}, ${JSON.stringify(headers)}::jsonb)
      returning id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert returned no id');
    return id;
  }

  async function model(
    providerId: number,
    modelId: string,
    availableExternally = true,
  ): Promise<void> {
    await client.sql`
      insert into provider_models (provider_id, model_id, available_externally)
      values (${providerId}, ${modelId}, ${availableExternally})
    `;
  }

  async function link(profile: string, position: number, providerId: number, model: string) {
    await client.sql`
      insert into llm_chains (profile, position, provider_id, model_id)
      values (${profile}, ${position}, ${providerId}, ${model})
    `;
  }

  async function chains(): Promise<ChainRow[]> {
    return client.sql<ChainRow[]>`
      select profile, position, provider_id, model_id
      from llm_chains
      order by profile, position
    `;
  }

  describe('getChain', () => {
    it('returns enabled providers in position order, joined with their provider', async () => {
      const first = await provider('First', 'openai-compatible', 'https://first.example/v1', true, {
        'x-opencode-session': 'session-1',
      });
      const second = await provider('Second', 'ollama', 'http://127.0.0.1:11434', true);

      // Inserted out of order on purpose: `position` must decide, not insertion.
      await link('bulk', 2, second, 'small-model');
      await link('bulk', 1, first, 'big-model');

      const chain = unwrap(await repo.getChain('bulk'));

      expect(chain).toEqual([
        {
          providerId: first,
          providerName: 'First',
          kind: 'openai-compatible',
          baseUrl: 'https://first.example/v1',
          modelId: 'big-model',
          headers: { 'x-opencode-session': 'session-1' },
        },
        {
          providerId: second,
          providerName: 'Second',
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          modelId: 'small-model',
          headers: {},
        },
      ]);
    });

    it('keeps profiles apart', async () => {
      const p = await provider('Shared', 'google', 'https://g.example', true);
      await link('bulk', 1, p, 'bulk-model');
      await link('quality', 1, p, 'quality-model');

      expect(unwrap(await repo.getChain('bulk')).map((item) => item.modelId)).toEqual([
        'bulk-model',
      ]);
      expect(unwrap(await repo.getChain('quality')).map((item) => item.modelId)).toEqual([
        'quality-model',
      ]);
    });

    it('drops providers that were disabled without editing the chain', async () => {
      const on = await provider('On', 'openai-compatible', 'https://on.example/v1', true);
      const off = await provider('Off', 'openai-compatible', 'https://off.example/v1', false);
      await link('bulk', 1, off, 'off-model');
      await link('bulk', 2, on, 'on-model');

      const chain = unwrap(await repo.getChain('bulk'));

      expect(chain.map((item) => item.providerName)).toEqual(['On']);
    });

    it('returns an empty list when the profile has no chain', async () => {
      expect(unwrap(await repo.getChain('quality'))).toEqual([]);
    });
  });

  describe('saveChains', () => {
    it('replaces both chains with positions starting at zero', async () => {
      const p = await provider('P', 'openai-compatible', 'https://p.example/v1', true);
      await model(p, 'small-model');
      const q = await provider('Q', 'google', 'https://g.example', true);
      await model(q, 'gemini-model');

      // A stale row that must not survive the rewrite.
      await link('bulk', 7, p, 'small-model');

      unwrap(
        await repo.saveChains({
          bulk: [
            { providerId: p, modelId: 'small-model' },
            { providerId: q, modelId: 'gemini-model' },
          ],
          quality: [{ providerId: q, modelId: 'gemini-model' }],
        }),
      );

      expect(await chains()).toEqual([
        { profile: 'bulk', position: 0, provider_id: p, model_id: 'small-model' },
        { profile: 'bulk', position: 1, provider_id: q, model_id: 'gemini-model' },
        { profile: 'quality', position: 0, provider_id: q, model_id: 'gemini-model' },
      ]);
      // Each profile reads back independently and in order.
      expect(unwrap(await repo.getChain('bulk')).map((item) => item.modelId)).toEqual([
        'small-model',
        'gemini-model',
      ]);
      expect(unwrap(await repo.getChain('quality')).map((item) => item.modelId)).toEqual([
        'gemini-model',
      ]);
    });

    it('refuses an unknown provider and writes nothing', async () => {
      const result = await repo.saveChains({
        bulk: [{ providerId: 987654, modelId: 'ghost-model' }],
        quality: [{ providerId: 987654, modelId: 'ghost-model' }],
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      if (!result.ok) expect(result.message).toContain('不存在');
      expect(await chains()).toEqual([]);
    });

    it('refuses a disabled provider and leaves the old chain untouched', async () => {
      const on = await provider('On', 'openai-compatible', 'https://on.example/v1', true);
      const off = await provider('Off', 'openai-compatible', 'https://off.example/v1', false);
      await model(on, 'on-model');
      await model(off, 'off-model');

      unwrap(
        await repo.saveChains({
          bulk: [{ providerId: on, modelId: 'on-model' }],
          quality: [{ providerId: on, modelId: 'on-model' }],
        }),
      );
      const before = await chains();

      const result = await repo.saveChains({
        bulk: [
          { providerId: on, modelId: 'on-model' },
          { providerId: off, modelId: 'off-model' },
        ],
        quality: [{ providerId: on, modelId: 'on-model' }],
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      if (!result.ok) expect(result.message).toContain('已停用');
      expect(await chains()).toEqual(before);
    });

    it('refuses a model that is not exposed to outside clients', async () => {
      const p = await provider('P', 'openai-compatible', 'https://p.example/v1', true);
      await model(p, 'console-only', false);

      const result = await repo.saveChains({
        bulk: [{ providerId: p, modelId: 'console-only' }],
        quality: [{ providerId: p, modelId: 'console-only' }],
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      if (!result.ok) expect(result.message).toContain('可用模型列表');
      expect(await chains()).toEqual([]);
    });

    it('refuses a model that belongs to a different provider', async () => {
      const p = await provider('P', 'openai-compatible', 'https://p.example/v1', true);
      const q = await provider('Q', 'openai-compatible', 'https://q.example/v1', true);
      await model(q, 'q-model');

      const result = await repo.saveChains({
        bulk: [{ providerId: p, modelId: 'q-model' }],
        quality: [{ providerId: q, modelId: 'q-model' }],
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      expect(await chains()).toEqual([]);
    });

    it('writes a single profile and leaves the other empty', async () => {
      const p = await provider('P', 'openai-compatible', 'https://p.example/v1', true);
      await model(p, 'small-model');

      // One-click append configures one chain at a time; the editor's own
      // schema is what refuses to save an empty profile.
      unwrap(
        await repo.saveChains({
          bulk: [],
          quality: [{ providerId: p, modelId: 'small-model' }],
        }),
      );

      expect(await chains()).toEqual([
        { profile: 'quality', position: 0, provider_id: p, model_id: 'small-model' },
      ]);
    });
  });
});
