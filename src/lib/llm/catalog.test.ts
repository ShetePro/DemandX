import { describe, expect, it, vi } from 'vitest';

import fixture from './__fixtures__/models-dev.json';
import {
  CATALOG_URL,
  FALLBACK_PRESETS,
  loadCatalog,
  mapCatalog,
  searchCatalog,
  type CatalogCacheStore,
  type CatalogProvider,
} from './catalog';

const DOMESTIC_IDS = [
  'deepseek',
  'moonshotai-cn',
  'zhipuai',
  'alibaba-cn',
  'siliconflow-cn',
  'volcengine',
  'stepfun',
  'minimax-cn',
  'modelscope',
];

function fetchReturning(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
}

function fetchFailing(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
}

function find(providers: CatalogProvider[], id: string): CatalogProvider {
  const provider = providers.find((entry) => entry.id === id);
  if (provider === undefined) throw new Error(`missing provider ${id}`);
  return provider;
}

describe('mapCatalog', () => {
  it('maps an openai-compatible entry with its published endpoint, env hint and models', () => {
    const providers = mapCatalog(fixture);
    const deepseek = find(providers, 'deepseek');

    expect(deepseek.kind).toBe('openai-compatible');
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek.env).toBe('DEEPSEEK_API_KEY');
    expect(deepseek.group).toBe('domestic');
    expect(deepseek.models).toEqual([
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp' },
    ]);
  });

  it('fills the default endpoint for openai, anthropic and google', () => {
    const providers = mapCatalog(fixture);

    expect(find(providers, 'openai').baseUrl).toBe('https://api.openai.com/v1');
    expect(find(providers, 'anthropic').baseUrl).toBe('https://api.anthropic.com/v1');
    expect(find(providers, 'google').baseUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );

    expect(find(providers, 'openai').kind).toBe('openai-compatible');
    expect(find(providers, 'anthropic').kind).toBe('anthropic-compatible');
    expect(find(providers, 'google').kind).toBe('google');
  });

  it('maps a native SDK vendor to its documented OpenAI-compatible endpoint', () => {
    const groq = find(mapCatalog(fixture), 'groq');

    expect(groq.kind).toBe('openai-compatible');
    expect(groq.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(groq.group).toBe('overseas');
  });

  it('skips unsupported npm families and entries without any endpoint', () => {
    const ids = mapCatalog(fixture).map((provider) => provider.id);

    // Azure needs a per-resource URL; the self-hosted entry publishes no api
    // and has no default endpoint, so neither can become a working provider.
    expect(ids).not.toContain('azure');
    expect(ids).not.toContain('self-hosted-demo');
    expect(ids).toEqual(
      expect.arrayContaining(['anthropic', 'deepseek', 'google', 'groq', 'openai', 'openrouter']),
    );
  });

  it('keeps Azure, Bedrock and Vertex out of the directory', () => {
    const rawFixture = fixture as Record<string, unknown>;
    const ids = mapCatalog({
      azure: rawFixture.azure,
      deepseek: rawFixture.deepseek,
      'amazon-bedrock': {
        id: 'amazon-bedrock',
        name: 'Amazon Bedrock',
        npm: '@ai-sdk/amazon-bedrock',
        env: ['AWS_ACCESS_KEY_ID'],
        models: {},
      },
      'google-vertex': {
        id: 'google-vertex',
        name: 'Vertex',
        npm: '@ai-sdk/google-vertex',
        env: ['GOOGLE_VERTEX_PROJECT'],
        models: {},
      },
    }).map((provider) => provider.id);

    expect(ids).toEqual(['deepseek']);
    const fallbackIds = FALLBACK_PRESETS.map((provider) => provider.id);
    for (const id of ['azure', 'amazon-bedrock', 'google-vertex']) {
      expect(fallbackIds).not.toContain(id);
    }
  });

  it('sorts providers by name', () => {
    const names = mapCatalog(fixture).map((provider) => provider.name);

    expect(names).toEqual([
      'Anthropic',
      'DeepSeek',
      'Google',
      'Groq',
      'MiniMax (minimax.cn)',
      'OpenAI',
      'OpenRouter',
    ]);
  });

  it('returns the built-in presets when the fetch failed', () => {
    const providers = mapCatalog(undefined, { fetchOk: false });

    expect(providers).toHaveLength(FALLBACK_PRESETS.length);
    expect(providers.every((provider) => provider.models.length === 0)).toBe(true);
  });
});

describe('searchCatalog', () => {
  const providers = mapCatalog(fixture);

  it('matches id, name, base URL and env case-insensitively', () => {
    expect(searchCatalog(providers, 'DEEPSEEK').map((provider) => provider.id)).toEqual([
      'deepseek',
    ]);
    expect(searchCatalog(providers, 'api.openai.com').map((provider) => provider.id)).toEqual([
      'openai',
    ]);
    expect(searchCatalog(providers, 'api.groq.com').map((provider) => provider.id)).toEqual([
      'groq',
    ]);
    expect(searchCatalog(providers, 'minimax_api_key').map((provider) => provider.id)).toEqual([
      'minimax-cn',
    ]);
  });

  it('filters by group', () => {
    expect(searchCatalog(providers, '', 'domestic').map((provider) => provider.id)).toEqual([
      'deepseek',
      'minimax-cn',
    ]);
    expect(searchCatalog(providers, '', 'overseas')).toHaveLength(5);
    expect(searchCatalog(providers, '', 'local')).toEqual([]);
  });

  it('caps the result at 40 rows', () => {
    const many: CatalogProvider[] = Array.from({ length: 60 }, (_, index) => ({
      id: `provider-${index}`,
      name: `Provider ${index}`,
      kind: 'openai-compatible',
      baseUrl: `https://api${index}.example.com/v1`,
      env: null,
      models: [],
      group: 'overseas',
    }));

    expect(searchCatalog(many, '')).toHaveLength(40);
  });
});

describe('loadCatalog', () => {
  it('caches a successful fetch and reports the cache on the next call', async () => {
    const fetchImpl = fetchReturning(fixture);
    const cache: CatalogCacheStore = { current: null };
    let now = 1_000;

    const first = await loadCatalog({ fetchImpl, cache, now: () => now });
    expect(first.source).toBe('network');
    expect(first.fetchedAt).toBe(1_000);
    expect(first.providers.map((provider) => provider.id)).toContain('deepseek');

    now += 60 * 60 * 1000;
    const second = await loadCatalog({ fetchImpl, cache, now: () => now });
    expect(second.source).toBe('cache');
    expect(second.fetchedAt).toBe(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(CATALOG_URL, expect.anything());
  });

  it('refetches once the 24h TTL has passed', async () => {
    const fetchImpl = fetchReturning(fixture);
    const cache: CatalogCacheStore = { current: null };
    let now = 0;

    await loadCatalog({ fetchImpl, cache, now: () => now });
    now = 24 * 60 * 60 * 1000;
    const refreshed = await loadCatalog({ fetchImpl, cache, now: () => now });

    expect(refreshed.source).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the built-in presets when the network fails', async () => {
    const fetchImpl = fetchFailing();
    const cache: CatalogCacheStore = { current: null };

    const snapshot = await loadCatalog({ fetchImpl, cache, now: () => 42 });

    expect(snapshot.source).toBe('fallback');
    expect(snapshot.fetchedAt).toBe(42);
    expect(snapshot.providers.length).toBeGreaterThanOrEqual(20);
    expect(cache.current).toBeNull();
    for (const id of DOMESTIC_IDS) {
      expect(snapshot.providers.map((provider) => provider.id)).toContain(id);
    }
    expect(snapshot.providers.every((provider) => provider.models.length === 0)).toBe(true);
  });

  it('falls back when the response is not ok', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const snapshot = await loadCatalog({ fetchImpl, cache: { current: null } });

    expect(snapshot.source).toBe('fallback');
  });

  it('classifies the built-in presets into all three groups', () => {
    const groups = new Set(FALLBACK_PRESETS.map((provider) => provider.group));

    expect(groups).toEqual(new Set(['domestic', 'overseas', 'local']));
    expect(find([...FALLBACK_PRESETS], 'ollama')).toMatchObject({
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      env: null,
      group: 'local',
    });
    expect(find([...FALLBACK_PRESETS], 'lmstudio')).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      env: null,
      group: 'local',
    });
  });
});
