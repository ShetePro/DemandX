import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSecretBox, type SecretBox } from '@/lib/crypto/secret';
import { FALLBACK_PRESETS, type CatalogProvider, type CatalogSnapshot } from '@/lib/llm/catalog';
import type * as ClientModule from '@/lib/db/client';

import type * as ActionsModule from './actions';
import {
  PAYG_ISSUE_CODE,
  chainsInputSchema,
  isPaygBaseUrl,
  providerFormSchema,
  providerUpdateFormSchema,
} from './schema';

const catalogMocks = vi.hoisted(() => ({
  loadCatalog: vi.fn(),
  searchCatalog: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/llm/catalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadCatalog: catalogMocks.loadCatalog,
    searchCatalog: catalogMocks.searchCatalog,
  };
});

const PROVIDER = {
  name: 'OpenCode Go',
  kind: 'openai-compatible' as const,
  baseUrl: 'https://opencode.ai/inference/go',
  apiKey: 'sk-test-1234567890',
};

const CHAIN_ITEM = { providerId: 1, modelId: 'gpt-4o-mini' };

describe('isPaygBaseUrl', () => {
  it('treats the bare inference host as pay-as-you-go', () => {
    expect(isPaygBaseUrl('https://opencode.ai/inference')).toBe(true);
    expect(isPaygBaseUrl('https://opencode.ai/inference/')).toBe(true);
  });

  it('leaves the /go subscription endpoint alone', () => {
    expect(isPaygBaseUrl('https://opencode.ai/inference/go')).toBe(false);
  });

  it('sees through URL spellings that mean the same endpoint', () => {
    // Percent-encoding, doubled slash, upper case and a trailing host dot all
    // reach the same metered host; none may dodge the confirmation.
    expect(isPaygBaseUrl('https://opencode.ai/%69nference')).toBe(true);
    expect(isPaygBaseUrl('https://opencode.ai//inference')).toBe(true);
    expect(isPaygBaseUrl('https://opencode.ai/INFERENCE')).toBe(true);
    expect(isPaygBaseUrl('https://opencode.ai./inference')).toBe(true);
  });

  it('ignores unrelated endpoints and malformed URLs', () => {
    expect(isPaygBaseUrl('https://api.example.com')).toBe(false);
    expect(isPaygBaseUrl('not a url')).toBe(false);
  });
});

describe('providerFormSchema pay-as-you-go guard', () => {
  it('rejects a metered base URL without an explicit acknowledgement', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://opencode.ai/inference',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues.some((issue) => issue.message.includes('按量计费'))).toBe(true);
    expect(
      result.error.issues.some(
        (issue) => 'params' in issue && issue.params?.code === PAYG_ISSUE_CODE,
      ),
    ).toBe(true);
  });

  it('accepts the same endpoint once the operator ticks the box', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://opencode.ai/inference',
      acknowledgePayg: true,
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.baseUrl).toBe('https://opencode.ai/inference');
  });

  it('rejects an encoded or re-spelled metered URL just the same', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://opencode.ai/%69nference',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('按量计费'))).toBe(true);
    }
  });

  it('does not ask for confirmation on an ordinary endpoint', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://api.example.com/v1',
    });

    expect(result.success).toBe(true);
    // The form-only flag defaults to false and never blocks a normal save.
    if (result.success) expect(result.data.acknowledgePayg).toBe(false);
  });

  it('still validates the rest of the provider form', () => {
    const result = providerFormSchema.safeParse({ ...PROVIDER, name: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('name'))).toBe(true);
    }
  });
});

describe('providerUpdateFormSchema pay-as-you-go guard', () => {
  it('rejects switching an existing provider to the metered endpoint', () => {
    const result = providerUpdateFormSchema.safeParse({
      baseUrl: 'https://opencode.ai/inference',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('按量计费'))).toBe(true);
    }
  });

  it('does not ask for confirmation when the update omits the base URL', () => {
    expect(providerUpdateFormSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});

describe('chainsInputSchema', () => {
  it('accepts two non-empty chains', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [CHAIN_ITEM],
      quality: [CHAIN_ITEM, { providerId: 2, modelId: 'claude-sonnet' }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty chain', () => {
    const result = chainsInputSchema.safeParse({ bulk: [], quality: [CHAIN_ITEM] });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) => candidate.path[0] === 'bulk');
      expect(issue?.message).toContain('bulk 链不能为空');
    }
  });

  it('rejects a duplicated entry inside one chain', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [CHAIN_ITEM, { ...CHAIN_ITEM }],
      quality: [CHAIN_ITEM],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('重复'))).toBe(true);
    }
  });

  it('rejects an unknown profile instead of silently dropping it', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [CHAIN_ITEM],
      quality: [CHAIN_ITEM],
      draft: [CHAIN_ITEM],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed entry', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [{ providerId: 0, modelId: '  ' }],
      quality: [CHAIN_ITEM],
    });

    expect(result.success).toBe(false);
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

/** Database name from a postgres URL, or '' when it cannot be parsed. */
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// These tests TRUNCATE tables, so they must only ever see an explicitly named
// `*_test` database.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

let actions!: typeof ActionsModule;
let client!: typeof ClientModule;
let box!: SecretBox;
let tmpDir!: string;

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSecretFile = process.env.DEMANDX_SECRET_FILE;

const DEEPSEEK_CATALOG: CatalogProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  env: 'DEEPSEEK_API_KEY',
  group: 'domestic',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
};

function snapshot(providers: CatalogProvider[]): CatalogSnapshot {
  return { providers, source: 'network', fetchedAt: 1 };
}

suite('catalog server actions', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'demandx-catalog-'));
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DEMANDX_SECRET_FILE = path.join(tmpDir, 'secret.key');

    actions = await import('./actions');
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
    await client.sql.unsafe(
      'TRUNCATE providers, provider_models, llm_chains RESTART IDENTITY CASCADE',
    );
    catalogMocks.loadCatalog.mockReset();
    catalogMocks.searchCatalog.mockReset();
  });

  async function providerCount(): Promise<number> {
    const rows = await client.sql<{ n: number }[]>`select count(*)::int as n from providers`;
    return rows[0]?.n ?? 0;
  }

  async function modelsOf(providerId: number) {
    return client.sql<
      { model_id: string; display_name: string | null; source: string | null; available: boolean }[]
    >`select model_id, display_name, source, available_externally as available
      from provider_models where provider_id = ${providerId} order by model_id`;
  }

  async function ciphertextOf(providerId: number): Promise<string | null> {
    const rows = await client.sql<
      { api_key_ct: string | null }[]
    >`select api_key_ct from providers where id = ${providerId}`;
    return rows[0]?.api_key_ct ?? null;
  }

  async function seedProvider(
    name: string,
    baseUrl = 'https://api.example.com/v1',
    enabled = true,
  ): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into providers (name, kind, base_url, enabled)
      values (${name}, 'openai-compatible', ${baseUrl}, ${enabled})
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
      values (${providerId}, ${modelId}, ${availableExternally}, 'manual')
    `;
  }

  async function chainRows() {
    return client.sql<
      { profile: string; position: number; provider_id: number; model_id: string }[]
    >`
      select profile, position, provider_id, model_id
      from llm_chains
      order by profile, position
    `;
  }

  it('rejects an id that is not in the current catalog', async () => {
    catalogMocks.loadCatalog.mockResolvedValue(snapshot([DEEPSEEK_CATALOG]));

    const result = await actions.createFromCatalogAction({ catalogId: 'not-a-vendor' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_FAILED');
      expect(result.message).toContain('not-a-vendor');
    }
    expect(await providerCount()).toBe(0);
  });

  it('rejects an empty selection before touching the catalog or the database', async () => {
    const result = await actions.createFromCatalogAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');
    expect(catalogMocks.loadCatalog).not.toHaveBeenCalled();
    expect(await providerCount()).toBe(0);
  });

  it('creates a provider from a fallback entry that has no models', async () => {
    const fallback = FALLBACK_PRESETS.find((provider) => provider.id === 'deepseek');
    if (fallback === undefined) throw new Error('fallback preset missing');
    expect(fallback.models).toEqual([]);
    catalogMocks.loadCatalog.mockResolvedValue(snapshot([fallback]));

    const result = await actions.createFromCatalogAction({ catalogId: 'deepseek' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modelCount).toBe(0);
    expect(result.value.provider).toMatchObject({
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      keyMask: null,
    });
    expect(await providerCount()).toBe(1);
    expect(await modelsOf(result.value.provider.id)).toHaveLength(0);
  });

  it('writes the catalog models with source=catalog and keeps the key encrypted', async () => {
    const key = 'sk-catalog-abcdef123456';
    catalogMocks.loadCatalog.mockResolvedValue(snapshot([DEEPSEEK_CATALOG]));

    const result = await actions.createFromCatalogAction({
      catalogId: 'deepseek',
      apiKey: key,
      name: 'DeepSeek 目录',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modelCount).toBe(2);
    expect(result.value.provider.name).toBe('DeepSeek 目录');
    expect(result.value.provider.keyMask).toBe(box.mask(key));
    expect(result.value.provider.keyMask).not.toBe(key);

    const models = await modelsOf(result.value.provider.id);
    expect(models.map((model) => model.model_id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(models.every((model) => model.source === 'catalog')).toBe(true);
    expect(models.every((model) => model.available)).toBe(true);

    const ciphertext = await ciphertextOf(result.value.provider.id);
    expect(ciphertext).not.toBeNull();
    expect(ciphertext).not.toBe(key);
    expect(ciphertext).not.toContain(key);
  });

  it('accepts a keyless selection and stores no ciphertext', async () => {
    catalogMocks.loadCatalog.mockResolvedValue(snapshot([DEEPSEEK_CATALOG]));

    const result = await actions.createFromCatalogAction({ catalogId: 'deepseek' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider.keyMask).toBeNull();
    expect(await ciphertextOf(result.value.provider.id)).toBeNull();
  });

  it('refuses a metered endpoint instead of silently inserting it', async () => {
    catalogMocks.loadCatalog.mockResolvedValue(
      snapshot([{ ...DEEPSEEK_CATALOG, baseUrl: 'https://opencode.ai/inference' }]),
    );

    const result = await actions.createFromCatalogAction({ catalogId: 'deepseek' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PAYG_NOT_ACKNOWLEDGED');
    expect(await providerCount()).toBe(0);
  });

  it('never leaves a provider behind when one catalog model is invalid', async () => {
    catalogMocks.loadCatalog.mockResolvedValue(
      snapshot([
        {
          ...DEEPSEEK_CATALOG,
          models: [{ id: 'x'.repeat(201), name: 'Too long' }],
        },
      ]),
    );

    const result = await actions.createFromCatalogAction({ catalogId: 'deepseek' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');
    expect(await providerCount()).toBe(0);
  });

  it('passes the trimmed query and group to searchCatalog', async () => {
    const providers = [DEEPSEEK_CATALOG];
    catalogMocks.loadCatalog.mockResolvedValue(snapshot(providers));
    catalogMocks.searchCatalog.mockReturnValue([DEEPSEEK_CATALOG]);

    const result = await actions.getCatalogAction('  deepseek  ', 'domestic');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.providers).toEqual([DEEPSEEK_CATALOG]);
    expect(catalogMocks.searchCatalog).toHaveBeenCalledWith(providers, 'deepseek', 'domestic');
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      ok: true,
      value: { source: 'network', fetchedAt: 1 },
    });
  });

  it('defaults the catalog query to empty and the group to all', async () => {
    catalogMocks.loadCatalog.mockResolvedValue(snapshot([DEEPSEEK_CATALOG]));
    catalogMocks.searchCatalog.mockReturnValue([DEEPSEEK_CATALOG]);

    await actions.getCatalogAction();

    expect(catalogMocks.searchCatalog).toHaveBeenCalledWith([DEEPSEEK_CATALOG], '', 'all');
  });

  describe('appendModelToChainAction', () => {
    it('rejects a model that belongs to another provider', async () => {
      const mine = await seedProvider('Mine');
      const other = await seedProvider('Other');
      await seedModel(other, 'other-model');

      const result = await actions.appendModelToChainAction({
        profile: 'quality',
        providerId: mine,
        modelId: 'other-model',
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      if (!result.ok) expect(result.message).toContain('不在 provider');
      expect(await chainRows()).toEqual([]);
    });

    it('rejects a model that is only callable from the vendor client', async () => {
      const providerId = await seedProvider('Console');
      await seedModel(providerId, 'console-only', false);

      const result = await actions.appendModelToChainAction({
        profile: 'bulk',
        providerId,
        modelId: 'console-only',
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      if (!result.ok) expect(result.message).toContain('仅官方客户端');
      expect(await chainRows()).toEqual([]);
    });

    it('appends at the end and reports a one-based position for the UI', async () => {
      const providerId = await seedProvider('Stub');
      await seedModel(providerId, 'first');
      await seedModel(providerId, 'second');

      // Both chains start empty: the first click alone must make quality usable.
      const first = await actions.appendModelToChainAction({
        profile: 'quality',
        providerId,
        modelId: 'first',
      });
      expect(first).toEqual({ ok: true, value: { added: true, position: 0 } });

      const second = await actions.appendModelToChainAction({
        profile: 'quality',
        providerId,
        modelId: 'second',
      });
      expect(second).toEqual({ ok: true, value: { added: true, position: 1 } });

      expect(await chainRows()).toEqual([
        { profile: 'quality', position: 0, provider_id: providerId, model_id: 'first' },
        { profile: 'quality', position: 1, provider_id: providerId, model_id: 'second' },
      ]);
    });

    it('reports an existing entry instead of duplicating it', async () => {
      const providerId = await seedProvider('Stub');
      await seedModel(providerId, 'only');

      const first = await actions.appendModelToChainAction({
        profile: 'bulk',
        providerId,
        modelId: 'only',
      });
      const again = await actions.appendModelToChainAction({
        profile: 'bulk',
        providerId,
        modelId: 'only',
      });

      expect(first).toEqual({ ok: true, value: { added: true, position: 0 } });
      expect(again).toEqual({ ok: true, value: { added: false, position: 0 } });
      expect(await chainRows()).toEqual([
        { profile: 'bulk', position: 0, provider_id: providerId, model_id: 'only' },
      ]);
    });

    it('leaves the other profile untouched when it already has entries', async () => {
      const providerId = await seedProvider('Stub');
      await seedModel(providerId, 'bulk-model');
      await seedModel(providerId, 'quality-model');

      await actions.appendModelToChainAction({
        profile: 'bulk',
        providerId,
        modelId: 'bulk-model',
      });
      await actions.appendModelToChainAction({
        profile: 'quality',
        providerId,
        modelId: 'quality-model',
      });

      expect(await chainRows()).toEqual([
        { profile: 'bulk', position: 0, provider_id: providerId, model_id: 'bulk-model' },
        { profile: 'quality', position: 0, provider_id: providerId, model_id: 'quality-model' },
      ]);
    });

    it('refuses a disabled provider instead of writing an unusable chain', async () => {
      const providerId = await seedProvider('Off', 'https://off.example/v1', false);
      await seedModel(providerId, 'off-model');

      const result = await actions.appendModelToChainAction({
        profile: 'quality',
        providerId,
        modelId: 'off-model',
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
      if (!result.ok) expect(result.message).toContain('已停用');
      expect(await chainRows()).toEqual([]);
    });
  });
});
