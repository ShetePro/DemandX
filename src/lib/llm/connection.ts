import { asc, eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { providerModels, providers } from '@/lib/db/schema';

import type { AdapterFailureReason } from './adapters/types';
import { adapterFor } from './chain';
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
  /** Dollars the provider says remain in the window; adapters do not report one yet. */
  providerReportedAllowance?: number;
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
 * The provider's first model, by `model_id` ascending. `provider_models` is a
 * cache, so an empty one means "no model discovered yet" — the probe cannot pick
 * one on the operator's behalf.
 */
async function loadProbeTarget(
  id: number,
): Promise<Result<{ kind: ProviderKind; baseUrl: string; modelId: string }>> {
  try {
    // A LEFT JOIN keeps "provider without models" distinguishable from "no such
    // provider"; NULLS LAST ordering puts the smallest real model_id first.
    const [row] = await db
      .select({
        kind: providers.kind,
        baseUrl: providers.baseUrl,
        modelId: providerModels.modelId,
      })
      .from(providers)
      .leftJoin(providerModels, eq(providerModels.providerId, providers.id))
      .where(eq(providers.id, id))
      .orderBy(asc(providerModels.modelId))
      .limit(1);

    if (!row) return { ok: false, code: 'PROVIDER_NOT_FOUND', message: `provider ${id} 不存在` };
    if (row.modelId === null) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'no_models' };
    }
    return {
      ok: true,
      value: { kind: row.kind as ProviderKind, baseUrl: row.baseUrl, modelId: row.modelId },
    };
  } catch (error) {
    return storageFailure('读取 provider ', error);
  }
}

/**
 * Send one minimal request through the provider's own adapter. Timeout and 401
 * /403 come back as data (`status` plus a short `reason`), never as a throw.
 */
export async function testProviderConnection(id: number): Promise<ConnectionTestResult> {
  const target = await loadProbeTarget(id);
  if (!target.ok) return failure(target.code, target.message);

  const apiKey = await resolveApiKey(id);
  if (!apiKey.ok) return failure(apiKey.code, apiKey.message);

  const { kind, baseUrl, modelId } = target.value;
  const startedAt = performance.now();

  let outcome;
  try {
    outcome = await adapterFor(kind)({
      baseUrl,
      apiKey: apiKey.value,
      modelId,
      prompt: { system: '', user: PROBE_PROMPT },
      structured: false,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    // An adapter bug is reported as a failed probe, not as a 500 to the page.
    return failure('LLM_UNAVAILABLE', '连接失败：适配器异常', 0);
  }

  const latencyMs = Math.round(performance.now() - startedAt);

  if (!outcome.ok) {
    return failure(
      codeFor(outcome.reason),
      describe(outcome.reason, outcome.status),
      outcome.status,
      outcome.reason,
    );
  }

  // `postJson` only returns a body for a 2xx response, and every adapter speaks
  // a 200-style endpoint, so a success is reported as 200.
  return { ok: true, value: { latencyMs, model: modelId, status: 200 } };
}
