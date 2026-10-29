import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadSecretBox, type SecretBox } from '@/lib/crypto/secret';

import type { AppError, Result } from './types';
// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as RepositoryModule from './repository';

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

// `process.env.DATABASE_URL` is read when ./repository first imports the db
// client, so the URL is installed in `beforeAll` and the module is imported
// dynamically from there.
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const KEY = 'sk-integration-abcdef123456';
const NEW_KEY = 'sk-rotated-zyxwvu987654';
const BASE_URL = 'https://api.example.com/v1';

let repo!: typeof RepositoryModule;
let client!: typeof ClientModule;
let box!: SecretBox;
let tmpDir!: string;

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSecretFile = process.env.DEMANDX_SECRET_FILE;

suite('provider repository', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'demandx-repo-'));
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DEMANDX_SECRET_FILE = path.join(tmpDir, 'secret.key');

    repo = await import('./repository');
    client = await import('@/lib/db/client');
    box = loadSecretBox(process.env.DEMANDX_SECRET_FILE);
  });

  afterAll(async () => {
    await client.closeDb();
    rmSync(tmpDir, { recursive: true, force: true });

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSecretFile === undefined) delete process.env.DEMANDX_SECRET_FILE;
    else process.env.DEMANDX_SECRET_FILE = previousSecretFile;
  });

  beforeEach(async () => {
    await client.sql.unsafe('TRUNCATE providers, llm_chains RESTART IDENTITY CASCADE');
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  function expectFailure<T>(result: Result<T>): AppError {
    if (result.ok) throw new Error('expected a failure result, got ok');
    return result;
  }

  function create(overrides: Record<string, unknown> = {}) {
    return repo.createProvider({
      name: 'Example',
      kind: 'openai-compatible',
      baseUrl: BASE_URL,
      apiKey: KEY,
      ...overrides,
    });
  }

  async function ciphertextOf(id: number): Promise<string | null> {
    const rows = await client.sql<
      { api_key_ct: string | null }[]
    >`select api_key_ct from providers where id = ${id}`;
    return rows[0]?.api_key_ct ?? null;
  }

  async function providerCount(id: number): Promise<number> {
    const rows = await client.sql<
      { n: number }[]
    >`select count(*)::int as n from providers where id = ${id}`;
    return rows[0]?.n ?? 0;
  }

  async function reference(profile: string, position: number, providerId: number): Promise<void> {
    await client.sql`
      insert into llm_chains (profile, position, provider_id, model_id)
      values (${profile}, ${position}, ${providerId}, 'test-model')
    `;
  }

  it('creates a provider and exposes only the mask, never the key', async () => {
    const row = unwrap(await create());

    expect(row.name).toBe('Example');
    expect(row.kind).toBe('openai-compatible');
    expect(row.baseUrl).toBe(BASE_URL);
    expect(row.enabled).toBe(true);
    expect(row.headers).toEqual({});
    expect(row.monthlyAllowanceUsd).toBeNull();
    expect(row.keyMask).toBe(box.mask(KEY));
    expect(row.keyMask).not.toBe(KEY);

    const list = unwrap(await repo.listProviders());
    expect(list).toHaveLength(1);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('api_key_ct');
    expect(serialized).not.toContain('apiKeyCt');

    const ciphertext = await ciphertextOf(row.id);
    expect(ciphertext).not.toBeNull();
    expect(ciphertext).not.toBe(KEY);
    expect(ciphertext).not.toContain(KEY);
  });

  it('stores headers, allowance and enabled flags as typed values', async () => {
    const row = unwrap(
      await create({
        headers: { 'X-Org': 'acme' },
        monthlyAllowanceUsd: 12.5,
        enabled: false,
      }),
    );

    expect(row.headers).toEqual({ 'X-Org': 'acme' });
    expect(row.monthlyAllowanceUsd).toBe(12.5);
    expect(row.enabled).toBe(false);

    const [listed] = unwrap(await repo.listProviders());
    expect(listed?.headers).toEqual({ 'X-Org': 'acme' });
    expect(listed?.monthlyAllowanceUsd).toBe(12.5);
    expect(listed?.enabled).toBe(false);
  });

  it('resolves the original key through the single decrypt path', async () => {
    const row = unwrap(await create());
    expect(unwrap(await repo.resolveApiKey(row.id))).toBe(KEY);
  });

  it('returns null for ollama and for providers stored without a key', async () => {
    const ollama = unwrap(
      await repo.createProvider({
        name: 'Local',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    );
    expect(ollama.keyMask).toBeNull();
    expect(unwrap(await repo.resolveApiKey(ollama.id))).toBeNull();

    const keyless = unwrap(await create({ apiKey: undefined }));
    expect(keyless.keyMask).toBeNull();
    expect(unwrap(await repo.resolveApiKey(keyless.id))).toBeNull();
  });

  it('leaves the ciphertext untouched when a patch omits or empties apiKey', async () => {
    const row = unwrap(await create());
    const before = await ciphertextOf(row.id);

    const renamed = unwrap(await repo.updateProvider(row.id, { name: 'Renamed' }));
    expect(renamed.name).toBe('Renamed');
    expect(await ciphertextOf(row.id)).toBe(before);

    unwrap(await repo.updateProvider(row.id, { apiKey: '' }));
    expect(await ciphertextOf(row.id)).toBe(before);
    expect(unwrap(await repo.resolveApiKey(row.id))).toBe(KEY);
  });

  it('re-encrypts when a new key is supplied and the old key no longer resolves', async () => {
    const row = unwrap(await create());
    const before = await ciphertextOf(row.id);

    const updated = unwrap(await repo.updateProvider(row.id, { apiKey: NEW_KEY }));

    const after = await ciphertextOf(row.id);
    expect(after).not.toBe(before);
    expect(updated.keyMask).toBe(box.mask(NEW_KEY));
    expect(unwrap(await repo.resolveApiKey(row.id))).toBe(NEW_KEY);

    const serialized = JSON.stringify(unwrap(await repo.listProviders()));
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(NEW_KEY);
  });

  it('refuses to delete a provider referenced by llm_chains and keeps the row', async () => {
    const row = unwrap(await create());
    await reference('bulk', 1, row.id);
    await reference('quality', 2, row.id);

    const result = expectFailure(await repo.deleteProvider(row.id));

    expect(result.code).toBe('PROVIDER_REFERENCED');
    expect(result.message).toContain('quality#2');
    expect(result.message).toContain('bulk#1');
    expect(await providerCount(row.id)).toBe(1);
  });

  it('deletes a provider once the chains no longer reference it', async () => {
    const row = unwrap(await create());
    await reference('quality', 2, row.id);

    expectFailure(await repo.deleteProvider(row.id));
    await client.sql`delete from llm_chains where provider_id = ${row.id}`;

    expect(unwrap(await repo.deleteProvider(row.id))).toBeUndefined();
    expect(await providerCount(row.id)).toBe(0);
    expect(unwrap(await repo.listProviders())).toEqual([]);

    const second = expectFailure(await repo.deleteProvider(row.id));
    expect(second.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('rejects an invalid baseUrl without inserting a row', async () => {
    const result = expectFailure(
      await repo.createProvider({ name: 'Bad', kind: 'google', baseUrl: 'not-a-url' }),
    );

    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.message).toContain('baseUrl');
    expect(unwrap(await repo.listProviders())).toEqual([]);
  });

  it('rejects invalid update input before touching storage', async () => {
    const row = unwrap(await create());
    const before = await ciphertextOf(row.id);

    const badUrl = expectFailure(await repo.updateProvider(row.id, { baseUrl: 'nope' }));
    expect(badUrl.code).toBe('VALIDATION_FAILED');

    const shortKey = expectFailure(await repo.updateProvider(row.id, { apiKey: 'short' }));
    expect(shortKey.code).toBe('VALIDATION_FAILED');

    const emptyName = expectFailure(await repo.updateProvider(row.id, { name: '   ' }));
    expect(emptyName.code).toBe('VALIDATION_FAILED');

    expect(await ciphertextOf(row.id)).toBe(before);
    expect(unwrap(await repo.resolveApiKey(row.id))).toBe(KEY);
  });

  it('rejects a whitespace-only API key instead of storing it', async () => {
    const result = expectFailure(await create({ apiKey: '          ' }));

    expect(result.code).toBe('VALIDATION_FAILED');
    expect(unwrap(await repo.listProviders())).toEqual([]);
  });

  it('reports PROVIDER_NOT_FOUND for unknown ids', async () => {
    expect(expectFailure(await repo.updateProvider(999, { name: 'x' })).code).toBe(
      'PROVIDER_NOT_FOUND',
    );
    expect(expectFailure(await repo.deleteProvider(999)).code).toBe('PROVIDER_NOT_FOUND');
    expect(expectFailure(await repo.resolveApiKey(999)).code).toBe('PROVIDER_NOT_FOUND');
  });

  it('maps a corrupted ciphertext to SECRET_FAILED without throwing', async () => {
    const row = unwrap(await create());
    await client.sql`update providers set api_key_ct = 'v1:aaaa:bbbb:cccc' where id = ${row.id}`;

    const result = expectFailure(await repo.resolveApiKey(row.id));
    expect(result.code).toBe('SECRET_FAILED');
  });

  it('lists providers ordered by name', async () => {
    unwrap(await create({ name: 'gamma' }));
    unwrap(await create({ name: 'alpha' }));
    unwrap(await create({ name: 'beta' }));

    expect(unwrap(await repo.listProviders()).map((provider) => provider.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});
