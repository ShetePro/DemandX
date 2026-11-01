import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import { getChain } from '@/lib/llm/chain-repository';
import { withProviderHeaders } from '@/lib/llm/provider-headers';
import { resolveApiKey } from '@/lib/llm/repository';
import type { ChainItem } from '@/lib/llm/port';
import type { Result } from '@/lib/llm/types';

/**
 * Kinds the chat route can speak to. `anthropic-compatible` and `google` are
 * used only through the fetch adapters in `LlmPort`; pointing the quality chain
 * at them leaves chat without a model rather than silently downgrading.
 */
const CHAT_KINDS: Record<ChainItem['kind'], boolean> = {
  'openai-compatible': true,
  ollama: true,
  'anthropic-compatible': false,
  google: false,
};

/**
 * Ollama serves its OpenAI-compatible API under `/v1`, but the provider row
 * usually stores the daemon root (`http://127.0.0.1:11434`). Appending `/v1`
 * only when it is missing keeps both forms working.
 */
function compatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * The model chat runs on. Chat prefers the **bulk** chain: it only needs to
 * talk, and the fast model answers in ~1s while the quality model routinely
 * spends 60s+ and reads as "no output". If bulk has no compatible entry, the
 * quality chain is used instead.
 */
export async function getChatModel(): Promise<Result<{ model: LanguageModel; used: ChainItem }>> {
  for (const profile of ['bulk', 'quality'] as const) {
    const chain = await getChain(profile);
    if (!chain.ok) return chain;

    const item = chain.value.find((entry) => CHAT_KINDS[entry.kind] === true);
    if (item === undefined) continue;

    const key = await resolveApiKey(item.providerId);
    if (!key.ok) return key;

    const provider = createOpenAICompatible({
      name: item.providerName,
      baseURL: compatibleBaseUrl(item.baseUrl),
      // Ollama ignores the bearer token; the SDK still requires a non-empty one.
      apiKey: key.value ?? 'ollama',
      headers: withProviderHeaders(item.baseUrl, item.headers, item.providerName),
    });

    return { ok: true, value: { model: provider(item.modelId), used: item } };
  }

  return {
    ok: false,
    code: 'CHAT_PROVIDER_UNSUPPORTED',
    message: 'bulk / quality 链中都没有可对话的 provider（仅支持 openai-compatible 与 ollama）',
  };
}
