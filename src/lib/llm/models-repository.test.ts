import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as ModelsRepositoryModule from './models-repository';

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

/**
 * The pure endpoint tests still need the module, and the module's db client
 * connects lazily: a placeholder URL is enough as long as no query runs. The
 * integration suite below installs the real test database first.
 */
const suite = TEST_DATABASE_URL ? describe : describe.skip;

let repo!: typeof ModelsRepositoryModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL || 'postgres://placeholder:placeholder@127.0.0.1:1/placeholder';
  repo = await import('./models-repository');
  client = await import('@/lib/db/client');
});

afterAll(async () => {
  await client.closeDb();

  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modelsEndpointFor', () => {
  it('asks OpenCode Go for the shared inference catalogue', () => {
    expect(repo.modelsEndpointFor('openai-compatible', 'https://opencode.ai/inference/go')).toBe(
      'https://opencode.ai/inference/v1/models',
    );
  });

  it('drops the chat path a configured OpenCode base URL may carry', () => {
    expect(
      repo.modelsEndpointFor('openai-compatible', 'https://opencode.ai/inference/go/openai/v1'),
    ).toBe('https://opencode.ai/inference/v1/models');
  });

  it('finds the catalogue on the metered OpenCode endpoint too', () => {
    expect(repo.modelsEndpointFor('openai-compatible', 'https://opencode.ai/inference')).toBe(
      'https://opencode.ai/inference/v1/models',
    );
    expect(repo.modelsEndpointFor('openai-compatible', 'https://opencode.ai/inference/')).toBe(
      'https://opencode.ai/inference/v1/models',
    );
  });

  it('appends /models to an ordinary OpenAI-compatible base without doubling slashes', () => {
    expect(repo.modelsEndpointFor('openai-compatible', 'https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1/models',
    );
    expect(repo.modelsEndpointFor('openai-compatible', 'https://opencode.ai/api')).toBe(
      'https://opencode.ai/api/models',
    );
  });

  it('uses Ollama’s native tags endpoint at the daemon root', () => {
    expect(repo.modelsEndpointFor('ollama', 'http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
    expect(repo.modelsEndpointFor('ollama', 'http://127.0.0.1:11434/v1/')).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
  });
});

suite('refreshModels', () => {
  beforeEach(async () => {
    await client.sql.unsafe('TRUNCATE providers, provider_models RESTART IDENTITY CASCADE');
  });

  async function seedProvider(name: string, baseUrl: string): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into providers (name, kind, base_url, enabled)
      values (${name}, 'openai-compatible', ${baseUrl}, true)
      returning id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert returned no id');
    return id;
  }

  it('requests /inference/v1/models for an OpenCode Go base URL', async () => {
    const providerId = await seedProvider(
      'OpenCode Go',
      'https://opencode.ai/inference/go/openai/v1',
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'glm-5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await repo.refreshModels(providerId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((model) => model.modelId)).toEqual(['glm-5']);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://opencode.ai/inference/v1/models');
    expect(init).toMatchObject({ headers: expect.any(Object) });
  });

  it('keeps the OpenAI-compatible suffix for an ordinary endpoint', async () => {
    const providerId = await seedProvider('Stub', 'http://127.0.0.1:4010/v1');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'stub-model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await repo.refreshModels(providerId);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4010/v1/models');
  });
});
