import { asArray, asRecord, asString } from './adapters/http';
import type { ProviderKind } from './types';

/**
 * Provider directory. models.dev publishes one JSON document with every
 * vendor, the SDK it speaks (`npm`) and preview endpoints; the settings page
 * uses it so an operator does not have to copy base URLs by hand.
 */
export const CATALOG_URL = 'https://models.dev/api.json';

/** How long a successful fetch is reused, in-process. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** A hung directory request must not block the settings page. */
const CATALOG_TIMEOUT_MS = 10_000;

/** At most this many rows are returned to the client. */
export const CATALOG_SEARCH_LIMIT = 40;

/**
 * Vendors whose `api` field is empty in models.dev but which publish an
 * OpenAI-compatible endpoint. The native SDKs listed here all speak the same
 * wire format, so they map to our `openai-compatible` adapter; only the default
 * endpoint differs. Keeping the table explicit means a new vendor is a
 * deliberate edit, never a guess derived from its name.
 */
export const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  // OpenAI-compatible endpoints documented by the vendors themselves.
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  togetherai: 'https://api.together.xyz/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  perplexity: 'https://api.perplexity.ai',
};

/**
 * `npm` decides the protocol family. Anything else (Azure's per-resource URL,
 * Bedrock/Vertex's request signing) needs parameters this app does not collect,
 * so those entries stay out of the directory and remain manual-only.
 */
const NPM_KINDS: Readonly<Record<string, ProviderKind>> = {
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@openrouter/ai-sdk-provider': 'openai-compatible',
  // The native OpenAI SDK has the same wire format as our compatible adapter.
  '@ai-sdk/openai': 'openai-compatible',
  '@ai-sdk/groq': 'openai-compatible',
  '@ai-sdk/mistral': 'openai-compatible',
  '@ai-sdk/xai': 'openai-compatible',
  '@ai-sdk/togetherai': 'openai-compatible',
  '@ai-sdk/cohere': 'openai-compatible',
  '@ai-sdk/cerebras': 'openai-compatible',
  '@ai-sdk/perplexity': 'openai-compatible',
  '@ai-sdk/anthropic': 'anthropic-compatible',
  '@ai-sdk/google': 'google',
};

export type CatalogGroup = 'domestic' | 'overseas' | 'local';

export type CatalogGroupFilter = CatalogGroup | 'all';

export const CATALOG_GROUPS: ReadonlyArray<{ value: CatalogGroupFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'domestic', label: '国内' },
  { value: 'overseas', label: '海外' },
  { value: 'local', label: '本地' },
];

export type CatalogModel = { id: string; name: string };

export type CatalogProvider = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** First environment variable models.dev lists, shown as a hint only. */
  env: string | null;
  models: CatalogModel[];
  group: CatalogGroup;
};

/** One vendor prefix is treated as domestic even when it is a global brand. */
const DOMESTIC_IDS: Readonly<Record<string, true>> = {
  deepseek: true,
  'moonshotai-cn': true,
  zhipuai: true,
  'alibaba-cn': true,
  'siliconflow-cn': true,
  volcengine: true,
  stepfun: true,
  'minimax-cn': true,
  modelscope: true,
};

/** Local daemons: no key, reachable only from this machine. */
const LOCAL_IDS: Readonly<Record<string, true>> = { ollama: true, lmstudio: true };

export function groupFor(id: string): CatalogGroup {
  if (Object.hasOwn(LOCAL_IDS, id)) return 'local';
  if (Object.hasOwn(DOMESTIC_IDS, id)) return 'domestic';
  return 'overseas';
}

type FallbackSeed = Omit<CatalogProvider, 'models'>;

/**
 * The directory is an external service; when it cannot be reached the page must
 * still let the operator add a provider. These are the vendors this app is
 * known to work with, with their documented endpoints — no values are guessed.
 */
const FALLBACK_SEEDS: ReadonlyArray<FallbackSeed> = [
  // 国内
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    env: 'DEEPSEEK_API_KEY',
    group: 'domestic',
  },
  {
    id: 'moonshotai-cn',
    name: 'Moonshot AI (China)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    env: 'MOONSHOT_API_KEY',
    group: 'domestic',
  },
  {
    id: 'zhipuai',
    name: 'Zhipu AI',
    kind: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    env: 'ZHIPU_API_KEY',
    group: 'domestic',
  },
  {
    id: 'alibaba-cn',
    name: 'Alibaba (China)',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env: 'DASHSCOPE_API_KEY',
    group: 'domestic',
  },
  {
    id: 'siliconflow-cn',
    name: 'SiliconFlow (China)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    env: 'SILICONFLOW_CN_API_KEY',
    group: 'domestic',
  },
  {
    id: 'volcengine',
    name: 'Volcengine Ark',
    kind: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    env: 'ARK_API_KEY',
    group: 'domestic',
  },
  {
    id: 'stepfun',
    name: 'StepFun (China)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.stepfun.com/v1',
    env: 'STEPFUN_API_KEY',
    group: 'domestic',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax (minimax.cn)',
    kind: 'anthropic-compatible',
    baseUrl: 'https://api.minimax.cn/anthropic/v1',
    env: 'MINIMAX_API_KEY',
    group: 'domestic',
  },
  {
    id: 'modelscope',
    name: 'ModelScope',
    kind: 'openai-compatible',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    env: 'MODELSCOPE_API_KEY',
    group: 'domestic',
  },
  // 海外
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    env: 'OPENAI_API_KEY',
    group: 'overseas',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic-compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    env: 'ANTHROPIC_API_KEY',
    group: 'overseas',
  },
  {
    id: 'google',
    name: 'Google',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    env: 'GEMINI_API_KEY',
    group: 'overseas',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    group: 'overseas',
  },
  {
    id: 'fireworks-ai',
    name: 'Fireworks AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    env: 'FIREWORKS_API_KEY',
    group: 'overseas',
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    kind: 'openai-compatible',
    baseUrl: 'https://ollama.com/v1',
    env: 'OLLAMA_API_KEY',
    group: 'overseas',
  },
  {
    id: 'minimax',
    name: 'MiniMax (minimax.io)',
    kind: 'anthropic-compatible',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    env: 'MINIMAX_API_KEY',
    group: 'overseas',
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    env: 'GROQ_API_KEY',
    group: 'overseas',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    env: 'MISTRAL_API_KEY',
    group: 'overseas',
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    env: 'XAI_API_KEY',
    group: 'overseas',
  },
  {
    id: 'togetherai',
    name: 'Together AI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    env: 'TOGETHER_API_KEY',
    group: 'overseas',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    kind: 'openai-compatible',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    env: 'COHERE_API_KEY',
    group: 'overseas',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    env: 'CEREBRAS_API_KEY',
    group: 'overseas',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    kind: 'openai-compatible',
    baseUrl: 'https://api.perplexity.ai',
    env: 'PERPLEXITY_API_KEY',
    group: 'overseas',
  },
  // 本地
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    env: null,
    group: 'local',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    env: null,
    group: 'local',
  },
];

export const FALLBACK_PRESETS: ReadonlyArray<CatalogProvider> = FALLBACK_SEEDS.map((seed) => ({
  ...seed,
  models: [],
}));

function cloneProviders(providers: ReadonlyArray<CatalogProvider>): CatalogProvider[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  }));
}

function kindForNpm(npm: string | undefined): ProviderKind | undefined {
  if (npm === undefined) return undefined;
  return Object.hasOwn(NPM_KINDS, npm) ? NPM_KINDS[npm] : undefined;
}

function modelsOf(entry: Record<string, unknown>): CatalogModel[] {
  const record = asRecord(entry.models);
  if (record === undefined) return [];

  return Object.entries(record).flatMap(([key, value]) => {
    const model = asRecord(value);
    const id = asString(model?.id) ?? key;
    if (id.trim() === '') return [];
    return [{ id, name: asString(model?.name)?.trim() || id }];
  });
}

/**
 * Turn the models.dev document into the subset our adapters can call. Entries
 * whose `npm` maps to no supported protocol, or that have neither a published
 * endpoint nor a known default, are skipped rather than shown with a broken URL.
 * `fetchOk: false` is the explicit "the network failed" path and yields the
 * built-in presets.
 */
export function mapCatalog(raw: unknown, options: { fetchOk?: boolean } = {}): CatalogProvider[] {
  if (options.fetchOk === false) return cloneProviders(FALLBACK_PRESETS);

  const record = asRecord(raw);
  if (record === undefined) return cloneProviders(FALLBACK_PRESETS);

  const providers: CatalogProvider[] = [];

  for (const [key, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (entry === undefined) continue;

    const id = asString(entry.id)?.trim() || key;
    const kind = kindForNpm(asString(entry.npm));
    if (kind === undefined) continue;

    const baseUrl = asString(entry.api)?.trim() || DEFAULT_ENDPOINTS[id];
    if (baseUrl === undefined || baseUrl === '') continue;

    const envList = asArray(entry.env);
    providers.push({
      id,
      name: asString(entry.name)?.trim() || id,
      kind,
      baseUrl,
      env: asString(envList[0]) ?? null,
      models: modelsOf(entry),
      group: groupFor(id),
    });
  }

  return providers.sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) ||
      left.id.localeCompare(right.id),
  );
}

export type CatalogSource = 'network' | 'cache' | 'fallback';

export type CatalogSnapshot = {
  providers: CatalogProvider[];
  source: CatalogSource;
  fetchedAt: number;
};

export type CatalogCache = { providers: CatalogProvider[]; fetchedAt: number };

/** Mutable so tests can inject their own store instead of the module one. */
export type CatalogCacheStore = { current: CatalogCache | null };

const moduleCache: CatalogCacheStore = { current: null };

/** Test seam: drop the process cache between cases. */
export function resetCatalogCache(): void {
  moduleCache.current = null;
}

async function requestCatalog(fetchImpl: typeof fetch): Promise<unknown | undefined> {
  try {
    const response = await fetchImpl(CATALOG_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Load the directory, reusing a successful fetch for `ttlMs`. A failed request
 * falls back to the built-in presets and says so (`source: 'fallback'`) — the
 * page renders an explicit banner instead of an error.
 */
export async function loadCatalog(
  options: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    ttlMs?: number;
    cache?: CatalogCacheStore;
  } = {},
): Promise<CatalogSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
  const store = options.cache ?? moduleCache;

  const at = now();
  const cached = store.current;
  if (cached !== null && at - cached.fetchedAt < ttlMs) {
    return {
      providers: cloneProviders(cached.providers),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    };
  }

  const raw = await requestCatalog(fetchImpl);
  if (raw === undefined) {
    return {
      providers: mapCatalog(undefined, { fetchOk: false }),
      source: 'fallback',
      fetchedAt: at,
    };
  }

  const providers = mapCatalog(raw, { fetchOk: true });
  if (providers.length === 0) {
    return {
      providers: mapCatalog(undefined, { fetchOk: false }),
      source: 'fallback',
      fetchedAt: at,
    };
  }

  store.current = { providers, fetchedAt: at };
  return { providers: cloneProviders(providers), source: 'network', fetchedAt: at };
}

/**
 * Case-insensitive substring search across identity, endpoint and key hint.
 * `group: 'all'` keeps every group; the result is capped so a 200-vendor
 * directory never turns into one long page.
 */
export function searchCatalog(
  providers: ReadonlyArray<CatalogProvider>,
  q: string,
  group: CatalogGroupFilter = 'all',
): CatalogProvider[] {
  const needle = q.trim().toLowerCase();

  return providers
    .filter((provider) => group === 'all' || provider.group === group)
    .filter((provider) => {
      if (needle === '') return true;
      return [provider.id, provider.name, provider.baseUrl, provider.env ?? ''].some((field) =>
        field.toLowerCase().includes(needle),
      );
    })
    .slice(0, CATALOG_SEARCH_LIMIT);
}
