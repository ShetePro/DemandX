import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { loadSecretBox, SecretError, type SecretBox } from '@/lib/crypto/secret';
import { db } from '@/lib/db/client';
import { llmChains, providerModels, providers } from '@/lib/db/schema';

import { isOpencodeFreeModel } from './provider-headers';
import {
  createProviderInputSchema,
  updateProviderInputSchema,
  type AppErrorCode,
  type ProviderKind,
  type ProviderRow,
  type Result,
} from './types';

type ProviderRecord = typeof providers.$inferSelect;

const providerIdSchema = z
  .number()
  .int('provider id 必须是整数')
  .positive('provider id 必须为正数');

// The key file is only read when a key is actually encrypted or decrypted, so
// listing providers never touches the secret store.
let cachedBox: SecretBox | null = null;

function secretBox(): SecretBox {
  cachedBox ??= loadSecretBox();
  return cachedBox;
}

function fail<T>(code: AppErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): Result<z.output<S>> {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail('VALIDATION_FAILED', formatIssues(parsed.error));
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23503';
}

function encryptApiKey(plain: string): Result<{ apiKeyCt: string; apiKeyHint: string }> {
  try {
    const box = secretBox();
    return ok({ apiKeyCt: box.encrypt(plain), apiKeyHint: box.mask(plain) });
  } catch (error) {
    return fail('SECRET_FAILED', error instanceof SecretError ? error.message : 'API Key 加密失败');
  }
}

/** Shared by single and transactional creation so both encrypt identically. */
function providerInsertValues(
  data: z.output<typeof createProviderInputSchema>,
): Result<typeof providers.$inferInsert> {
  let key: { apiKeyCt: string; apiKeyHint: string } | null = null;
  if (data.apiKey !== undefined) {
    const encrypted = encryptApiKey(data.apiKey);
    if (!encrypted.ok) return encrypted;
    key = encrypted.value;
  }

  return ok({
    name: data.name,
    kind: data.kind,
    baseUrl: data.baseUrl,
    apiKeyCt: key?.apiKeyCt ?? null,
    apiKeyHint: key?.apiKeyHint ?? null,
    headers: data.headers ?? {},
    enabled: data.enabled,
    monthlyAllowanceUsd:
      data.monthlyAllowanceUsd === undefined ? null : data.monthlyAllowanceUsd.toFixed(2),
  });
}

function toProviderRow(row: ProviderRecord): ProviderRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    baseUrl: row.baseUrl,
    keyMask: row.apiKeyHint ?? null,
    headers: (row.headers ?? {}) as Record<string, string>,
    enabled: row.enabled ?? true,
    monthlyAllowanceUsd: row.monthlyAllowanceUsd === null ? null : Number(row.monthlyAllowanceUsd),
  };
}

type ChainReference = { profile: string; position: number };

function formatReferences(references: ChainReference[]): string {
  return references.map((ref) => `${ref.profile}#${ref.position}`).join('、');
}

function referencedFailure<T>(references: ChainReference[]): Result<T> {
  return fail(
    'PROVIDER_REFERENCED',
    `该 provider 仍被 LLM 链路引用：${formatReferences(references)}。请先从链路中移除后再删除。`,
  );
}

async function findChainReferences(providerId: number): Promise<ChainReference[]> {
  return db
    .select({ profile: llmChains.profile, position: llmChains.position })
    .from(llmChains)
    .where(eq(llmChains.providerId, providerId))
    .orderBy(asc(llmChains.profile), asc(llmChains.position));
}

/**
 * All providers, ordered by name. Never includes ciphertext or plaintext keys.
 * A storage failure is returned as `STORAGE_FAILED` so callers can tell an
 * outage apart from "no providers configured yet".
 */
export async function listProviders(): Promise<Result<ProviderRow[]>> {
  try {
    const rows = await db.select().from(providers).orderBy(asc(providers.name));
    return { ok: true, value: rows.map(toProviderRow) };
  } catch (error) {
    return storageFailure('读取 provider 列表', error);
  }
}

/**
 * Insert a provider, encrypting `apiKey` at rest. Without a key the provider is
 * usable but anonymous — `keyMask` stays null.
 */
export async function createProvider(input: unknown): Promise<Result<ProviderRow>> {
  const parsed = parse(createProviderInputSchema, input);
  if (!parsed.ok) return parsed;

  const values = providerInsertValues(parsed.value);
  if (!values.ok) return values;

  try {
    const [row] = await db.insert(providers).values(values.value).returning();

    if (!row) return fail('STORAGE_FAILED', '创建 provider 失败：数据库未返回记录');
    return ok(toProviderRow(row));
  } catch (error) {
    return storageFailure('创建 provider ', error);
  }
}

const seedModelsSchema = z.array(
  z.object({
    modelId: z.string().trim().min(1, 'modelId 不能为空').max(200, 'modelId 过长'),
    displayName: z.string().trim().min(1).max(200, '显示名过长').nullable().optional(),
  }),
);

export type SeedModel = z.input<typeof seedModelsSchema>[number];

/**
 * Create a provider together with its model list in one transaction. The
 * settings directory fills both from one selection, and a half-written provider
 * (rows without models, or a provider that fails its own constraints) would be
 * worse than none. Catalog models are callable through the configured endpoint
 * by definition, except OpenCode's `*-free` models, which only its own client
 * may call.
 */
export async function createProviderWithModels(
  input: unknown,
  models: unknown,
  options: { source?: string } = {},
): Promise<Result<{ provider: ProviderRow; modelCount: number }>> {
  const parsed = parse(createProviderInputSchema, input);
  if (!parsed.ok) return parsed;

  const parsedModels = seedModelsSchema.safeParse(models ?? []);
  if (!parsedModels.success) {
    return fail('VALIDATION_FAILED', formatIssues(parsedModels.error));
  }

  const seen = new Set<string>();
  const seed = parsedModels.data.filter((model) => {
    if (seen.has(model.modelId)) return false;
    seen.add(model.modelId);
    return true;
  });

  const values = providerInsertValues(parsed.value);
  if (!values.ok) return values;

  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(providers).values(values.value).returning();
      if (!row) throw new Error('provider insert returned no row');

      if (seed.length > 0) {
        await tx.insert(providerModels).values(
          seed.map((model) => ({
            providerId: row.id,
            modelId: model.modelId,
            displayName: model.displayName ?? null,
            source: options.source ?? 'catalog',
            availableExternally: !isOpencodeFreeModel(parsed.value.baseUrl, model.modelId),
          })),
        );
      }

      return { provider: toProviderRow(row), modelCount: seed.length };
    });

    return ok(created);
  } catch (error) {
    return storageFailure('创建 provider 与模型 ', error);
  }
}

/**
 * Apply a partial update. An omitted `apiKey` — or `apiKey: ''` — keeps the
 * stored ciphertext untouched; a non-empty one is encrypted fresh.
 */
export async function updateProvider(id: number, patch: unknown): Promise<Result<ProviderRow>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;
  const parsed = parse(updateProviderInputSchema, patch);
  if (!parsed.ok) return parsed;

  const data = parsed.value;
  const values: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };

  if (data.name !== undefined) values.name = data.name;
  if (data.kind !== undefined) values.kind = data.kind;
  if (data.baseUrl !== undefined) values.baseUrl = data.baseUrl;
  if (data.headers !== undefined) values.headers = data.headers;
  if (data.enabled !== undefined) values.enabled = data.enabled;
  if (data.monthlyAllowanceUsd !== undefined) {
    values.monthlyAllowanceUsd = data.monthlyAllowanceUsd.toFixed(2);
  }

  if (data.apiKey !== undefined && data.apiKey !== '') {
    const encrypted = encryptApiKey(data.apiKey);
    if (!encrypted.ok) return encrypted;
    values.apiKeyCt = encrypted.value.apiKeyCt;
    values.apiKeyHint = encrypted.value.apiKeyHint;
  }

  try {
    const [row] = await db
      .update(providers)
      .set(values)
      .where(eq(providers.id, parsedId.value))
      .returning();

    if (!row) return fail('PROVIDER_NOT_FOUND', `provider ${id} 不存在`);
    return ok(toProviderRow(row));
  } catch (error) {
    return storageFailure('更新 provider ', error);
  }
}

/**
 * Delete a provider, refusing when `llm_chains` still points at it. The FK is
 * `ON DELETE RESTRICT`, so the guard is also enforced by the database.
 */
export async function deleteProvider(id: number): Promise<Result<void>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;
  const providerId = parsedId.value;

  try {
    const references = await findChainReferences(providerId);
    if (references.length > 0) return referencedFailure(references);

    const removed = await db
      .delete(providers)
      .where(eq(providers.id, providerId))
      .returning({ id: providers.id });

    if (removed.length === 0) return fail('PROVIDER_NOT_FOUND', `provider ${id} 不存在`);
    return ok(undefined);
  } catch (error) {
    // A chain row may land between the check above and this delete; the FK
    // RESTRICT turns that race into SQLSTATE 23503, which we report the same way.
    if (isForeignKeyViolation(error)) {
      const references = await findChainReferences(providerId).catch(() => []);
      return references.length > 0
        ? referencedFailure(references)
        : fail('PROVIDER_REFERENCED', '该 provider 仍被 LLM 链路引用，无法删除。');
    }
    return storageFailure('删除 provider ', error);
  }
}

/**
 * The only function that unlocks a stored key. `null` means "no key needed":
 * Ollama runs locally, and keyless providers are allowed.
 */
export async function resolveApiKey(id: number): Promise<Result<string | null>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;

  try {
    const [row] = await db
      .select({ kind: providers.kind, apiKeyCt: providers.apiKeyCt })
      .from(providers)
      .where(eq(providers.id, parsedId.value));

    if (!row) return fail('PROVIDER_NOT_FOUND', `provider ${id} 不存在`);
    if (row.kind === 'ollama' || !row.apiKeyCt) return ok(null);
    return ok(secretBox().decrypt(row.apiKeyCt));
  } catch (error) {
    if (error instanceof SecretError) return fail('SECRET_FAILED', error.message);
    return storageFailure('读取 provider 密钥 ', error);
  }
}
