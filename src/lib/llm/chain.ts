import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import { complete as anthropic } from './adapters/anthropic';
import { complete as google } from './adapters/google';
import { complete as ollama } from './adapters/ollama';
import { complete as openaiCompatible } from './adapters/openai-compatible';
import type { Adapter, AdapterFailure, AdapterResult } from './adapters/types';
import type { CallOptions, ChainItem, LlmPort, Profile, Prompt, Usage } from './port';
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
type Failure = { item: ChainItem; code: string; detail?: string };

/** What a single adapter call resolved to once the key is known. */
type Attempt =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; code: string; detail?: string };

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
  return failures
    .map((failure) =>
      failure.detail === undefined
        ? `${label(failure.item)}: ${failure.code}`
        : `${label(failure.item)}: ${failure.code}（${failure.detail}）`,
    )
    .join('、');
}

/**
 * Auth, quota and 5xx mean this provider is unusable for a while. Timeouts and
 * transport blips are deliberately NOT cooled down: a slow structured answer
 * would otherwise lock every model out for five minutes even though the next
 * request (or a smaller one) succeeds. `empty`/`malformed` answers and
 * 400/404/422 say nothing about the provider's health either.
 */
function needsCooldown(failure: AdapterFailure): boolean {
  if (failure.reason !== 'http') return false;
  return failure.status >= 500 || [401, 403, 408, 429].includes(failure.status);
}

/** Last failure per provider#model, for the cooldown message and llm.log. */
type Cooldown = { until: number; reason: string };

function describeFailure(failure: AdapterFailure): string {
  const base = failure.reason === 'http' ? `http ${failure.status}` : failure.reason;
  return failure.detail === undefined ? base : `${base} ${failure.detail}`;
}

/** Provider failures are invisible in a local app; keep a short audit trail. */
function logFailure(item: ChainItem, failure: AdapterFailure): void {
  // Unit tests inject fake adapters; their failures are not provider health.
  if (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test') return;
  try {
    const dir = path.join(homedir(), '.demandx', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, 'llm.log'),
      `[${new Date().toISOString()}] ${item.providerName}#${item.modelId} ${describeFailure(failure)}\n`,
    );
  } catch {
    // Diagnostics must never take the chain down.
  }
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

function exhausted<T>(profile: string, failures: Failure[]): Result<T> {
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
  // after the operator edits settings. Keyed by provider+model: one slow model
  // must not take the provider's other models (and the fallback chain) down.
  const coolingUntil = new Map<string, Cooldown>();

  function cooldownKey(item: ChainItem): string {
    return `${item.providerId}#${item.modelId}`;
  }

  function cooling(item: ChainItem): boolean {
    const state = coolingUntil.get(cooldownKey(item));
    if (state === undefined) return false;
    if (state.until > now()) return true;
    coolingUntil.delete(cooldownKey(item));
    return false;
  }

  function cooldownFailure(item: ChainItem): Failure {
    const state = coolingUntil.get(cooldownKey(item));
    return state === undefined
      ? { item, code: 'cooldown' }
      : { item, code: 'cooldown', detail: `上次失败：${state.reason}` };
  }

  async function attempt(
    item: ChainItem,
    prompt: Prompt,
    structured: boolean,
    jsonSchema: Record<string, unknown> | undefined,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
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
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        // An adapter bug must not take the rest of the chain down with it.
        return { ok: false, status: 0, reason: 'network', code: 'adapter' };
      }
    }

    let result = await call();

    // A DNS/TLS blip or a dropped socket is usually gone by the second try. A
    // timeout is different: the model is slow, and waiting another full budget
    // only doubles the latency before the fallback chain gets its turn.
    if (!result.ok && result.reason === 'network') {
      await sleep(retryDelayMs);
      result = await call();
    }

    if (!result.ok) {
      logFailure(item, result);
      if (needsCooldown(result)) {
        coolingUntil.set(cooldownKey(item), {
          until: now() + cooldownMs,
          reason: describeFailure(result),
        });
      }
      return {
        ok: false,
        code: result.code,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    }

    return { ok: true, text: result.text, usage: result.usage };
  }

  function profilesOf(options: CallOptions): Profile[] {
    const profiles: Profile[] = [options.profile];
    if (options.fallbackProfile !== undefined && options.fallbackProfile !== options.profile) {
      profiles.push(options.fallbackProfile);
    }
    return profiles;
  }

  return {
    async text(prompt: Prompt, options: CallOptions) {
      const failures: Failure[] = [];
      const profiles = profilesOf(options);

      for (const profile of profiles) {
        const chain = await deps.loadChain(profile);
        if (!chain.ok) return chain;

        for (const item of chain.value) {
          if (options.signal?.aborted) break;
          if (cooling(item)) {
            failures.push(cooldownFailure(item));
            continue;
          }

          const result = await attempt(item, prompt, false, undefined, options.timeoutMs, options.signal);
          if (result.ok) {
            deps.recordUsage?.(item, result.usage);
            return ok({ text: result.text, used: item, usage: result.usage });
          }
          failures.push({
            item,
            code: result.code,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
        }
      }

      return exhausted(profiles.join('→'), failures);
    },

    async structured<T>(schema: z.ZodType<T>, prompt: Prompt, options: CallOptions) {
      const jsonSchema = jsonSchemaOf(schema);
      // No JSON Schema form means we cannot ask any provider for this shape.
      // Sending it anyway would turn a caller bug into "all models are bad".
      if (!jsonSchema) {
        return fail(
          'LLM_BAD_OUTPUT',
          `schema_unsupported：该 schema 无法转换为 JSON Schema（${options.profile}）`,
        );
      }

      const profiles = profilesOf(options);
      const failures: Failure[] = [];
      let sawBadOutput = false;
      let sawOtherFailure = false;

      for (const profile of profiles) {
        const chain = await deps.loadChain(profile);
        if (!chain.ok) return chain;

        for (const item of chain.value) {
          if (options.signal?.aborted) break;
          if (cooling(item)) {
            failures.push(cooldownFailure(item));
            // Unknown cause, so a pure "bad output" verdict would be a guess.
            sawOtherFailure = true;
            continue;
          }

          // A malformed answer is usually a formatting slip, so the same item gets
          // exactly one retry before the chain moves on.
          for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
            const result = await attempt(item, prompt, true, jsonSchema, options.timeoutMs, options.signal);
            if (!result.ok) {
              failures.push({
            item,
            code: result.code,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
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
      }

      const label = profiles.join('→');
      if (failures.length === 0) return exhausted(label, failures);

      const message = summarize(failures);
      return sawBadOutput && !sawOtherFailure
        ? fail('LLM_BAD_OUTPUT', `所有 provider 均返回无效 JSON（${label}）：${message}`)
        : fail('LLM_UNAVAILABLE', `所有 provider 均失败（${label}）：${message}`);
    },
  };
}
