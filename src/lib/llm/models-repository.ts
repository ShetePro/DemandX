import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/client';
import { providerModels, providers } from '@/lib/db/schema';

import { asArray, asRecord, asString, trimBase } from './adapters/http';
import { isOpencodeFreeModel } from './provider-headers';
import { resolveApiKey } from './repository';
import type { AppErrorCode, ProviderKind, ProviderModelRow, Result } from './types';

const providerIdSchema = z
  .number()
  .int('provider id 必须是整数')
  .positive('provider id 必须为正数');

/** A discovery probe must answer while the operator waits. */
const DISCOVERY_TIMEOUT_MS = 10_000;

export const addModelInputSchema = z.object({
  modelId: z.string().trim().min(1, 'modelId 不能为空').max(200, 'modelId 过长'),
  displayName: z.string().trim().min(1, '显示名不能为空').optional(),
  availableExternally: z.boolean().default(true),
});

export type AddModelInput = z.input<typeof addModelInputSchema>;

type RemoteModel = { modelId: string; displayName: string | null; availableExternally: boolean };

function fail<T>(code: AppErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return { ok: false, code: 'STORAGE_FAILED', message: `${action}失败${detail}` };
}

async function getJson(url: string, headers: Record<string, string>): Promise<Result<unknown>> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return fail('LLM_UNAVAILABLE', `拉取模型失败：HTTP ${response.status}`);
    }
    return { ok: true, value: (await response.json()) as unknown };
  } catch {
    return fail('LLM_UNAVAILABLE', '拉取模型失败：网络错误或超时');
  }
}

/**
 * Ollama's native tags endpoint lives at the daemon root, so the `/v1` suffix
 * of the OpenAI-compatible spelling has to go first (same rule as the adapter).
 */
function ollamaTagsUrl(baseUrl: string): string {
  const trimmed = trimBase(baseUrl);
  const base = trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed;
  return `${trimBase(base)}/api/tags`;
}

/** `{ models: [{ name, model }] }` — `model` is the canonical tag when present. */
function parseOllamaModels(body: unknown): RemoteModel[] {
  return asArray(asRecord(body)?.models).flatMap((entry) => {
    const record = asRecord(entry);
    const modelId = asString(record?.model) ?? asString(record?.name);
    if (modelId === undefined || modelId.trim() === '') return [];
    return [{ modelId, displayName: asString(record?.name) ?? null, availableExternally: true }];
  });
}

/**
 * `{ data: [{ id }] }` — the OpenAI `/v1/models` envelope. `isExternallyCallable`
 * lets a vendor's own-client-only models (OpenCode's `*-free`) be cached as such
 * instead of looking callable until the first 403.
 */
function parseOpenAiModels(
  body: unknown,
  isExternallyCallable: (modelId: string) => boolean = () => true,
): RemoteModel[] {
  return asArray(asRecord(body)?.data).flatMap((entry) => {
    const modelId = asString(asRecord(entry)?.id);
    if (modelId === undefined || modelId.trim() === '') return [];
    return [{ modelId, displayName: null, availableExternally: isExternallyCallable(modelId) }];
  });
}

/**
 * Where a provider answers "what do you serve?". Ollama keeps its native tags
 * endpoint at the daemon root. OpenCode publishes one catalogue for both its
 * subscription and metered endpoints at the inference root, not under the
 * per-client `/go/openai/v1` path its chat endpoint uses, so the suffix of the
 * configured base URL must not be taken as the endpoint. Everything else speaks
 * the OpenAI `/models` convention below its base URL.
 */
export function modelsEndpointFor(kind: ProviderKind, baseUrl: string): string {
  if (kind === 'ollama') return ollamaTagsUrl(baseUrl);

  const trimmed = trimBase(baseUrl);
  try {
    const url = new URL(trimmed);
    if (
      url.hostname === 'opencode.ai' &&
      (url.pathname === '/inference' || url.pathname.startsWith('/inference/'))
    ) {
      return `${url.origin}/inference/v1/models`;
    }
  } catch {
    // Not an absolute URL: keep the generic suffix and let the request report
    // the failure instead of inventing a host.
  }

  return `${trimmed}/models`;
}

/**
 * Only providers with a real "list models" endpoint are discoverable. Anthropic
 * and Google deliberately have none: their model families are curated in the
 * vendor console, so the operator adds the ones they can call by hand.
 */
async function fetchRemoteModels(
  kind: ProviderKind,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Result<RemoteModel[]>> {
  if (kind === 'anthropic-compatible' || kind === 'google') {
    return fail('VALIDATION_FAILED', '该 provider 不支持自动拉取模型，请使用“手动添加”填写模型 ID');
  }

  const response = await getJson(modelsEndpointFor(kind, baseUrl), headers);
  if (!response.ok) return response;
  return {
    ok: true,
    value:
      kind === 'ollama'
        ? parseOllamaModels(response.value)
        : parseOpenAiModels(response.value, (modelId) => !isOpencodeFreeModel(baseUrl, modelId)),
  };
}

function toModelRow(row: typeof providerModels.$inferSelect): ProviderModelRow {
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    availableExternally: row.availableExternally === true,
    source: row.source,
  };
}

/** Every cached model, ordered so the settings page renders deterministically. */
export async function listAllModels(): Promise<Result<ProviderModelRow[]>> {
  try {
    const rows = await db
      .select()
      .from(providerModels)
      .orderBy(asc(providerModels.providerId), asc(providerModels.modelId));
    return { ok: true, value: rows.map(toModelRow) };
  } catch (error) {
    return storageFailure('读取模型列表', error);
  }
}

/**
 * Ask the provider what it serves and cache the answer. Upserts never touch
 * `available_externally`: the operator's manual judgement — a model that is
 * visible to `/models` but only callable from the vendor's own client — must
 * survive every refresh.
 */
export async function refreshModels(providerId: number): Promise<Result<ProviderModelRow[]>> {
  const parsedId = providerIdSchema.safeParse(providerId);
  if (!parsedId.success) {
    return fail('VALIDATION_FAILED', formatIssues(parsedId.error));
  }

  let provider:
    { kind: ProviderKind; baseUrl: string; headers: Record<string, string> } | undefined;
  try {
    const [row] = await db
      .select({
        kind: providers.kind,
        baseUrl: providers.baseUrl,
        headers: providers.headers,
      })
      .from(providers)
      .where(eq(providers.id, parsedId.data))
      .limit(1);
    if (!row) return fail('PROVIDER_NOT_FOUND', `provider ${parsedId.data} 不存在`);
    provider = {
      kind: row.kind as ProviderKind,
      baseUrl: row.baseUrl,
      headers: (row.headers ?? {}) as Record<string, string>,
    };
  } catch (error) {
    return storageFailure('读取 provider ', error);
  }

  const headers: Record<string, string> = { ...provider.headers };
  const apiKey = await resolveApiKey(parsedId.data);
  if (!apiKey.ok) return apiKey;
  if (apiKey.value !== null && apiKey.value !== '' && headers.authorization === undefined) {
    headers.authorization = `Bearer ${apiKey.value}`;
  }

  const discovered = await fetchRemoteModels(provider.kind, provider.baseUrl, headers);
  if (!discovered.ok) return discovered;

  const rows = discovered.value.map((model) => ({
    providerId: parsedId.data,
    modelId: model.modelId,
    displayName: model.displayName,
    availableExternally: model.availableExternally,
    source: provider.kind,
  }));

  try {
    if (rows.length > 0) {
      // The listing is authoritative: discovered models it no longer returns
      // are dead, and leaving them in the cache lets the chain editor and the
      // connection probe pick model ids the provider rejects. Manual entries
      // (`source = 'manual'`) are intentional and survive.
      await db
        .delete(providerModels)
        .where(
          and(
            eq(providerModels.providerId, parsedId.data),
            eq(providerModels.source, provider.kind),
            notInArray(
              providerModels.modelId,
              rows.map((row) => row.modelId),
            ),
          ),
        );
      await db
        .insert(providerModels)
        .values(rows)
        .onConflictDoUpdate({
          target: [providerModels.providerId, providerModels.modelId],
          set: {
            displayName: sql`coalesce(excluded.display_name, ${providerModels.displayName})`,
            // A refresh may take availability away (`*-free` became visible in
            // `/models` but not callable from here) but never grants it back to
            // a model the operator marked console-only by hand.
            availableExternally: sql`${providerModels.availableExternally} AND excluded.available_externally`,
            source: sql`excluded.source`,
          },
        });
    }

    const stored = await db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, parsedId.data))
      .orderBy(asc(providerModels.modelId));
    return { ok: true, value: stored.map(toModelRow) };
  } catch (error) {
    return storageFailure('保存模型列表', error);
  }
}

/**
 * Manual entry for providers without a discovery endpoint (and for models the
 * listing omits). An existing row is updated, so ticking the external-use box
 * by hand is how a misclassified model is corrected.
 */
export async function addModel(
  providerId: number,
  input: unknown,
): Promise<Result<ProviderModelRow>> {
  const parsedId = providerIdSchema.safeParse(providerId);
  if (!parsedId.success) return fail('VALIDATION_FAILED', formatIssues(parsedId.error));

  const parsed = addModelInputSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_FAILED', formatIssues(parsed.error));

  const { modelId, displayName, availableExternally } = parsed.data;

  try {
    const [provider] = await db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.id, parsedId.data))
      .limit(1);
    if (!provider) return fail('PROVIDER_NOT_FOUND', `provider ${parsedId.data} 不存在`);

    const [row] = await db
      .insert(providerModels)
      .values({
        providerId: parsedId.data,
        modelId,
        displayName: displayName ?? null,
        source: 'manual',
        availableExternally,
      })
      .onConflictDoUpdate({
        target: [providerModels.providerId, providerModels.modelId],
        set: {
          displayName: sql`coalesce(excluded.display_name, ${providerModels.displayName})`,
          availableExternally,
          source: 'manual',
        },
      })
      .returning();

    if (!row) return fail('STORAGE_FAILED', '保存模型失败：数据库未返回记录');
    return { ok: true, value: toModelRow(row) };
  } catch (error) {
    return storageFailure('保存模型', error);
  }
}
