import type { ZodType } from 'zod';

import type { ProviderKind, Result } from './types';

/** Which fallback chain a call runs on. Mirrors `llm_chains.profile`. */
export type Profile = 'bulk' | 'quality';

export type Prompt = { system: string; user: string };

/** How one call walks the chains. */
export type CallOptions = {
  profile: Profile;
  /**
   * Tried only after every item in `profile` failed. Pipeline stages set this
   * so a slow quality model degrades to the fast chain instead of failing the
   * whole run.
   */
  fallbackProfile?: Profile;
  /** Per-attempt timeout; defaults to the adapter's 120s. */
  timeoutMs?: number;
  /** Aborting cancels the in-flight provider request and stops the chain. */
  signal?: AbortSignal;
  /** Stop after this many chain items (per-angle calls use one model only). */
  maxItems?: number;
};

/** Token counts as reported by the provider; 0 when it reports nothing. */
export type Usage = { in: number; out: number };

/** One resolved `llm_chains` row, joined with its provider. Never carries a key. */
export type ChainItem = {
  providerId: number;
  providerName: string;
  kind: ProviderKind;
  baseUrl: string;
  modelId: string;
  /** Operator-configured extra request headers; adapters send them first. */
  headers: Record<string, string>;
};

/**
 * The only LLM surface upper layers see. Pipeline and chat code never imports a
 * provider adapter or knows which provider answered — `used` is for logging and
 * the settings UI, not for branching.
 */
export interface LlmPort {
  structured<T>(
    schema: ZodType<T>,
    prompt: Prompt,
    o: CallOptions,
  ): Promise<Result<{ data: T; used: ChainItem; usage: Usage }>>;

  text(
    prompt: Prompt,
    o: CallOptions,
  ): Promise<Result<{ text: string; used: ChainItem; usage: Usage }>>;
}
