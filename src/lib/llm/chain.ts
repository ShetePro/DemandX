import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { complete as anthropic } from './adapters/anthropic';
import { complete as google } from './adapters/google';
import { complete as ollama } from './adapters/ollama';
import { complete as openaiCompatible } from './adapters/openai-compatible';
import type { Adapter, AdapterFailure, AdapterResult } from './adapters/types';
import type { ChainItem, LlmPort, Profile, Prompt, Usage } from './port';
import { withProviderHeaders } from './provider-headers';
import type { AppErrorCode, ProviderKind, Result } from './types';

const ADAPTERS: Record<ProviderKind, Adapter> = {
  'openai-compatible': openaiCompatible,
  'anthropic-compatible': anthropic,
  google,
  ollama,
};

/** The one adapter that speaks a provider kind's protocol. */
export function adapterFor(kind: ProviderKind): Adapter {
  return ADAPTERS[kind];
}

/** Long enough to ride out a quota window, short enough to notice recovery. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

/** One item that could not answer, rendered as `provider#model: code`. */
type Failure = { item: ChainItem; code: string };

/** What a single adapter call resolved to once the key is known. */
type Attempt = { ok: true; text: string; usage: Usage } | { ok: false; code: string };

export type LlmPortDeps = {
  loadChain: (profile: Profile) => Promise<Result<ChainItem[]>>;
  resolveApiKey: (providerId: number) => Promise<Result<string | null>>;
  /** Called after every successful call; ledger writes must never throw here. */
  recordUsage?: ((item: ChainItem, usage: Usage) => void) | undefined;
  now?: (() => number) | undefined;
  cooldownMs?: number | undefined;
  /** Pause before retrying a transport failure; tests may set 0. */
  retryDelayMs?: number | undefined;
};

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(code: AppErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}

function label(item: ChainItem): string {
  return `${item.providerName}#${item.modelId}`;
}

/** Messages carry names, models and short codes — never a key or a response body. */
function summarize(failures: Failure[]): string {
  return failures.map((failure) => `${label(failure.item)}: ${failure.code}`).join('、');
}

/**
 * Auth, quota, timeouts, transport failures and 5xx mean this provider is
 * unusable for a while. `empty`/`malformed` answers and 400/404/422 say nothing
 * about the provider's health: degrade to the next item, but keep it in rotation.
 */
function needsCooldown(failure: AdapterFailure): boolean {
  if (failure.reason === 'timeout' || failure.reason === 'network') return true;
  if (failure.reason !== 'http') return false;
  return failure.status >= 500 || [401, 403, 408, 429].includes(failure.status);
}

/** JSON.parse + zod, with messages that never quote the payload. */
function decode<T>(text: string, schema: z.ZodType<T>): Result<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return fail('VALIDATION_FAILED', '响应不是合法 JSON');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return fail('VALIDATION_FAILED', `响应与 schema 不符（${parsed.error.issues.length} 处）`);
  }
  return ok(parsed.data);
}

/**
 * JSON Schema for providers that accept one. `undefined` means the schema has no
 * JSON Schema form; `structured` refuses to run rather than silently degrade to
 * an unvalidated text call.
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    // Strict providers want the shape, not the draft's `$schema` pointer.
    delete json.$schema;
    return json;
  } catch {
    return undefined;
  }
}

function exhausted<T>(profile: Profile, failures: Failure[]): Result<T> {
  if (failures.length === 0) {
    return fail('LLM_UNAVAILABLE', `${profile} 链为空：请先在设置中配置 provider`);
  }
  return fail('LLM_UNAVAILABLE', `所有 provider 均失败（${profile}）：${summarize(failures)}`);
}

/**
 * Ordered fallback built from `llm_chains`. Upper layers only ever see the
 * `LlmPort` interface: which provider answered, and every failure along the
 * way, stays inside this module except for the `used` field on success.
 */
export function createLlmPort(deps: LlmPortDeps): LlmPort {
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const retryDelayMs = deps.retryDelayMs ?? 300;

  // In-memory on purpose: a restart re-probes providers, which is what we want
  // after the operator edits settings. Keyed by provider, shared across profiles.
  const coolingUntil = new Map<number, number>();

  function cooling(item: ChainItem): boolean {
    const until = coolingUntil.get(item.providerId);
    if (until === undefined) return false;
    if (until > now()) return true;
    coolingUntil.delete(item.providerId);
    return false;
  }

  async function attempt(
    item: ChainItem,
    prompt: Prompt,
    structured: boolean,
    jsonSchema: Record<string, unknown> | undefined,
  ): Promise<Attempt> {
    const apiKey = await deps.resolveApiKey(item.providerId);
    // A broken secret store is local: retrying it on a timer buys nothing.
    if (!apiKey.ok) return { ok: false, code: 'key' };
    const key = apiKey.value;

    async function call(): Promise<AdapterResult> {
      try {
        return await adapterFor(item.kind)({
          baseUrl: item.baseUrl,
          apiKey: key,
          modelId: item.modelId,
          prompt,
          headers: withProviderHeaders(item.baseUrl, item.headers, item.providerName),
          structured,
          jsonSchema,
        });
      } catch {
        // An adapter bug must not take the rest of the chain down with it.
        return { ok: false, status: 0, reason: 'network', code: 'adapter' };
      }
    }

    let result = await call();

    // A DNS/TLS blip or a dropped socket is usually gone by the second try. A
    // retry here matters because the provider goes into cooldown after this,
    // and every model behind the same provider would be skipped until then.
    if (!result.ok && (result.reason === 'network' || result.reason === 'timeout')) {
      await sleep(retryDelayMs);
      result = await call();
    }

    if (!result.ok) {
      if (needsCooldown(result)) coolingUntil.set(item.providerId, now() + cooldownMs);
      return { ok: false, code: result.code };
    }

    return { ok: true, text: result.text, usage: result.usage };
  }

  return {
    async text(prompt: Prompt, options: { profile: Profile }) {
      const chain = await deps.loadChain(options.profile);
      if (!chain.ok) return chain;

      const failures: Failure[] = [];
      for (const item of chain.value) {
        if (cooling(item)) {
          failures.push({ item, code: 'cooldown' });
          continue;
        }

        const result = await attempt(item, prompt, false, undefined);
        if (result.ok) {
          deps.recordUsage?.(item, result.usage);
          return ok({ text: result.text, used: item, usage: result.usage });
        }
        failures.push({ item, code: result.code });
      }

      return exhausted(options.profile, failures);
    },

    async structured<T>(schema: z.ZodType<T>, prompt: Prompt, options: { profile: Profile }) {
      const jsonSchema = jsonSchemaOf(schema);
      // No JSON Schema form means we cannot ask any provider for this shape.
      // Sending it anyway would turn a caller bug into "all models are bad".
      if (!jsonSchema) {
        return fail(
          'LLM_BAD_OUTPUT',
          `schema_unsupported：该 schema 无法转换为 JSON Schema（${options.profile}）`,
        );
      }

      const chain = await deps.loadChain(options.profile);
      if (!chain.ok) return chain;

      const failures: Failure[] = [];
      let sawBadOutput = false;
      let sawOtherFailure = false;

      for (const item of chain.value) {
        if (cooling(item)) {
          failures.push({ item, code: 'cooldown' });
          // Unknown cause, so a pure "bad output" verdict would be a guess.
          sawOtherFailure = true;
          continue;
        }

        // A malformed answer is usually a formatting slip, so the same item gets
        // exactly one retry before the chain moves on.
        for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
          const result = await attempt(item, prompt, true, jsonSchema);
          if (!result.ok) {
            failures.push({ item, code: result.code });
            sawOtherFailure = true;
            break;
          }

          const decoded = decode(result.text, schema);
          if (decoded.ok) {
            deps.recordUsage?.(item, result.usage);
            return ok({ data: decoded.value, used: item, usage: result.usage });
          }

          if (attemptNo === 2) {
            failures.push({ item, code: 'bad_output' });
            sawBadOutput = true;
          }
        }
      }

      if (failures.length === 0) return exhausted(options.profile, failures);

      const message = summarize(failures);
      return sawBadOutput && !sawOtherFailure
        ? fail('LLM_BAD_OUTPUT', `所有 provider 均返回无效 JSON（${options.profile}）：${message}`)
        : fail('LLM_UNAVAILABLE', `所有 provider 均失败（${options.profile}）：${message}`);
    },
  };
}
