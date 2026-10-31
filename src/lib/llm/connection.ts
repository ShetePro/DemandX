import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { providerModels, providers } from '@/lib/db/schema';

import type { AdapterFailure, AdapterFailureReason } from './adapters/types';
import { adapterFor } from './chain';
import { isOpencodeBaseUrl, withProviderHeaders } from './provider-headers';
import { resolveApiKey } from './repository';
import type { AppErrorCode, ProviderKind, Result } from './types';

/**
 * A settings probe must answer while the operator waits; the pipeline's 2-minute
 * budget is for long structured answers, not for "只回复 ok".
 */
const PROBE_TIMEOUT_MS = 15_000;

/** Deliberately tiny: this call can hit a metered endpoint. */
const PROBE_PROMPT = '只回复 ok';

export type ConnectionTest = {
  latencyMs: number;
  model: string;
  status: number;
};

/**
 * Same success/failure split as `Result`, plus the HTTP status the settings page
 * shows verbatim. Failures never carry the response body: it commonly echoes the
 * prompt, and a provider error may quote the URL (which carries some keys).
 */
export type ConnectionTestResult =
  | { ok: true; value: ConnectionTest }
  | {
      ok: false;
      code: AppErrorCode;
      message: string;
      /** Provider HTTP status; 0 when no response arrived. */
      status: number;
      /** Where it failed, when the HTTP call itself was the problem. */
      reason?: AdapterFailureReason;
    };

function failure(
  code: AppErrorCode,
  message: string,
  status = 0,
  reason?: AdapterFailureReason,
): ConnectionTestResult {
  return reason === undefined
    ? { ok: false, code, message, status }
    : { ok: false, code, message, status, reason };
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return { ok: false, code: 'STORAGE_FAILED', message: `${action}失败${detail}` };
}

/** A broken/missing answer says nothing about the provider's health. */
function codeFor(reason: AdapterFailureReason): AppErrorCode {
  return reason === 'malformed' || reason === 'empty' ? 'LLM_BAD_OUTPUT' : 'LLM_UNAVAILABLE';
}

function describe(reason: AdapterFailureReason, status: number): string {
  switch (reason) {
    case 'http':
      return `连接失败：HTTP ${status}`;
    case 'timeout':
      return `连接失败：超过 ${PROBE_TIMEOUT_MS / 1000} 秒未响应`;
    case 'network':
      return '连接失败：网络错误';
    case 'malformed':
      return '连接失败：响应不是合法 JSON';
    case 'empty':
      return '连接失败：响应内容为空';
  }
}

/**
 * Up to five models outside clients may call, in `model_id` order. OpenCode's
 * `*-free` models are skipped: the listing exposes them, but a non-OpenCode
 * client always gets 403, so probing one proves nothing about the key.
 * `provider_models` is a cache, so an empty result means "no usable model
 * discovered yet" — the probe cannot pick one on the operator's behalf.
 */
async function loadProbeTarget(id: number): Promise<
  Result<{
    kind: ProviderKind;
    baseUrl: string;
    name: string;
    headers: Record<string, string>;
    modelIds: string[];
  }>
> {
  try {
    // A LEFT JOIN keeps "provider without usable models" distinguishable from
    // "no such provider"; NULLS LAST ordering puts real model ids first.
    const rows = await db
      .select({
        name: providers.name,
        kind: providers.kind,
        baseUrl: providers.baseUrl,
        headers: providers.headers,
        modelId: providerModels.modelId,
      })
      .from(providers)
      .leftJoin(
        providerModels,
        and(
          eq(providerModels.providerId, providers.id),
          eq(providerModels.availableExternally, true),
        ),
      )
      .where(eq(providers.id, id))
      .orderBy(asc(providerModels.modelId));

    if (rows.length === 0) {
      return { ok: false, code: 'PROVIDER_NOT_FOUND', message: `provider ${id} 不存在` };
    }

    const provider = rows[0];
    if (provider === undefined) {
      return { ok: false, code: 'PROVIDER_NOT_FOUND', message: `provider ${id} 不存在` };
    }

    const modelIds = rows
      .map((row) => row.modelId)
      .filter((modelId): modelId is string => modelId !== null)
      .filter((modelId) => !modelId.trim().toLowerCase().endsWith('-free'))
      .slice(0, 5);

    if (modelIds.length === 0) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: '该 provider 没有可外部调用的模型',
      };
    }

    return {
      ok: true,
      value: {
        kind: provider.kind as ProviderKind,
        baseUrl: provider.baseUrl,
        name: provider.name,
        headers: (provider.headers ?? {}) as Record<string, string>,
        modelIds,
      },
    };
  } catch (error) {
    return storageFailure('读取 provider ', error);
  }
}

/**
 * Send one minimal request through the provider's own adapter, moving down the
 * provider's callable models until one answers. A model can be listed yet
 * unavailable to this client (OpenCode's paid set varies by region/privacy), so
 * the alphabetically first model is not a fair test of the key. Timeout and 401
 * /403 come back as data (`status` plus a short `reason`), never as a throw.
 */
export async function testProviderConnection(id: number): Promise<ConnectionTestResult> {
  const target = await loadProbeTarget(id);
  if (!target.ok) return failure(target.code, target.message);

  const apiKey = await resolveApiKey(id);
  if (!apiKey.ok) return failure(apiKey.code, apiKey.message);

  const { kind, baseUrl, name, headers, modelIds } = target.value;
  const requestHeaders = withProviderHeaders(baseUrl, headers, name);

  let lastOutcome: AdapterFailure | undefined;

  for (const modelId of modelIds) {
    const startedAt = performance.now();
    let outcome;
    try {
      outcome = await adapterFor(kind)({
        baseUrl,
        apiKey: apiKey.value,
        modelId,
        prompt: { system: '', user: PROBE_PROMPT },
        headers: requestHeaders,
        structured: false,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch {
      // An adapter bug is reported as a failed probe, not as a 500 to the page.
      return failure('LLM_UNAVAILABLE', '连接失败：适配器异常', 0);
    }

    if (outcome.ok) {
      const latencyMs = Math.round(performance.now() - startedAt);
      return { ok: true, value: { latencyMs, model: modelId, status: 200 } };
    }

    lastOutcome = outcome;
    // A timeout or a dead transport will not improve on the next model; stop
    // holding the settings page open and report it.
    if (outcome.reason === 'timeout' || outcome.reason === 'network') break;
  }

  if (lastOutcome === undefined) {
    return failure('VALIDATION_FAILED', '该 provider 没有可外部调用的模型');
  }

  const status = lastOutcome.status;
  const message =
    lastOutcome.reason === 'http' && status === 403 && isOpencodeBaseUrl(baseUrl)
      ? 'OpenCode 返回 403：免费模型仅限官方客户端，或该模型在当前区域/隐私设置下不可用'
      : describe(lastOutcome.reason, status);

  return failure(codeFor(lastOutcome.reason), message, status, lastOutcome.reason);
}
