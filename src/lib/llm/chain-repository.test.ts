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

suite('getChain', () => {
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
  ): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into providers (name, kind, base_url, enabled)
      values (${name}, ${kind}, ${baseUrl}, ${enabled})
      returning id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert returned no id');
    return id;
  }

  async function link(profile: string, position: number, providerId: number, model: string) {
    await client.sql`
      insert into llm_chains (profile, position, provider_id, model_id)
      values (${profile}, ${position}, ${providerId}, ${model})
    `;
  }

  it('returns enabled providers in position order, joined with their provider', async () => {
    const first = await provider('First', 'openai-compatible', 'https://first.example/v1', true);
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
      },
      {
        providerId: second,
        providerName: 'Second',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        modelId: 'small-model',
      },
    ]);
  });

  it('keeps profiles apart', async () => {
    const p = await provider('Shared', 'google', 'https://g.example', true);
    await link('bulk', 1, p, 'bulk-model');
    await link('quality', 1, p, 'quality-model');

    expect(unwrap(await repo.getChain('bulk')).map((item) => item.modelId)).toEqual(['bulk-model']);
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
