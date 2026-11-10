import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as ConnectionModule from './connection';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

/** Database name from a postgres URL, or '' when it cannot be parsed. */
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// These integration tests TRUNCATE tables, so they only run against an
// explicitly named `*_test` database.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

let connection!: typeof ConnectionModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL || 'postgres://placeholder:placeholder@127.0.0.1:1/placeholder';
  connection = await import('./connection');
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

function answer(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

suite('testProviderConnection', () => {
  beforeEach(async () => {
    await client.sql.unsafe('TRUNCATE providers, provider_models RESTART IDENTITY CASCADE');
  });

  async function seedProvider(baseUrl: string, name = 'OpenCode Go'): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into providers (name, kind, base_url, enabled)
      values (${name}, 'openai-compatible', ${baseUrl}, true)
      returning id
    `;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('insert returned no id');
    return id;
  }

  async function seedModel(
    providerId: number,
    modelId: string,
    availableExternally = true,
  ): Promise<void> {
    await client.sql`
      insert into provider_models (provider_id, model_id, available_externally, source)
      values (${providerId}, ${modelId}, ${availableExternally}, 'catalog')
    `;
  }

  it('moves on from a 403 and succeeds on the next callable model', async () => {
    const providerId = await seedProvider('https://opencode.ai/inference/go');
    await seedModel(providerId, 'a-paid');
    await seedModel(providerId, 'b-paid');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return body.model === 'a-paid' ? new Response(null, { status: 403 }) : answer();
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await connection.testProviderConnection(providerId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe('b-paid');
      expect(result.value.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Every attempt carries the same synthesized OpenCode session header.
    const sessions = fetchMock.mock.calls.map(([, init]) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers['x-opencode-session'];
    });
    expect(sessions[0]).toMatch(/^demandx-[0-9a-f]{12}$/);
    expect(sessions[1]).toBe(sessions[0]);
  });

  it('does not call the provider when every usable model is *-free', async () => {
    const providerId = await seedProvider('https://opencode.ai/inference/go');
    await seedModel(providerId, 'a-free');
    await seedModel(providerId, 'b-free');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await connection.testProviderConnection(providerId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('没有可外部调用的模型');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes the operator-chain model before alphabetically earlier stale ids', async () => {
    const providerId = await seedProvider('https://example.com/v1');
    await seedModel(providerId, 'aaa-dead');
    await seedModel(providerId, 'zzz-live');
    await client.sql`
      insert into llm_chains (profile, provider_id, model_id, position)
      values ('bulk', ${providerId}, 'zzz-live', 0)
    `;
    const fetchMock = vi.fn().mockResolvedValue(answer());
    vi.stubGlobal('fetch', fetchMock);

    const result = await connection.testProviderConnection(providerId);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.model).toBe('zzz-live');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body)).model).toBe('zzz-live');
  });

  it('surfaces the upstream message instead of a bare HTTP status', async () => {
    const providerId = await seedProvider('https://example.com/v1');
    await seedModel(providerId, 'dead-model');
    const response = new Response(
      JSON.stringify({ error: { message: 'Upstream request failed: Model is unavailable.' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await connection.testProviderConnection(providerId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('连接失败：HTTP 400（Upstream request failed: Model is unavailable.）');
    }
  });

  it('explains an OpenCode 403 instead of echoing a bare status', async () => {
    const providerId = await seedProvider('https://opencode.ai/inference/go');
    await seedModel(providerId, 'a-paid');
    await seedModel(providerId, 'b-paid');

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await connection.testProviderConnection(providerId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toBe(
        'OpenCode 返回 403：免费模型仅限官方客户端，或该模型在当前区域/隐私设置下不可用',
      );
    }
  });

  it('keeps the plain status message for a non-OpenCode 403', async () => {
    const providerId = await seedProvider('https://api.example.com/v1', 'Example');
    await seedModel(providerId, 'a-model');

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await connection.testProviderConnection(providerId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe('连接失败：HTTP 403');
  });
});
