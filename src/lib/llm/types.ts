import { z } from 'zod';

/** Provider kinds accepted by `providers.kind` CHECK in the database. */
export const providerKindSchema = z.enum([
  'openai-compatible',
  'anthropic-compatible',
  'google',
  'ollama',
]);

export type ProviderKind = z.infer<typeof providerKindSchema>;

/**
 * What every caller sees of a provider. Deliberately has no ciphertext and no
 * plaintext key: `keyMask` is the only key-shaped field that may leave this
 * layer, and `resolveApiKey` is the single place that unlocks the real secret.
 */
export type ProviderRow = {
  id: number;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  keyMask: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  monthlyAllowanceUsd: number | null;
};

/**
 * One cached `provider_models` row. `availableExternally: false` means the model
 * only works through the vendor's own client (e.g. a subscription-only model),
 * so the chain must never be able to pick it.
 */
export type ProviderModelRow = {
  providerId: number;
  modelId: string;
  displayName: string | null;
  availableExternally: boolean;
  source: string | null;
};

/**
 * Latest counter per quota window for one provider. Windows without a row read
 * as 0; `monthlySpendUsd` is what the provider reported for its current month.
 */
export type ProviderUsageSummary = {
  providerId: number;
  fiveHourRequests: number;
  weeklyRequests: number;
  monthlyRequests: number;
  monthlySpendUsd: number;
};

export type AppErrorCode =
  | 'VALIDATION_FAILED'
  | 'PAYG_NOT_ACKNOWLEDGED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_REFERENCED'
  | 'SECRET_FAILED'
  | 'STORAGE_FAILED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_BAD_OUTPUT'
  | 'CHAT_PROVIDER_UNSUPPORTED';

/** A failure that crosses a layer boundary without throwing. */
export type AppError = {
  code: AppErrorCode;
  message: string;
};

export type Result<T> = { ok: true; value: T } | ({ ok: false } & AppError);

export const providerNameSchema = z
  .string()
  .trim()
  .min(1, '名称不能为空')
  .max(40, '名称最多 40 个字符');

export const providerBaseUrlSchema = z.url('必须是合法的 URL');

export const providerHeadersSchema = z.record(z.string(), z.string());

export const providerAllowanceSchema = z
  .number()
  .finite('额度必须是有限数字')
  .min(0, '额度不能为负');

/** Input accepted by `createProvider`. `enabled` defaults to true. */
export const createProviderInputSchema = z.object({
  name: providerNameSchema,
  kind: providerKindSchema,
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().trim().min(8, 'API Key 至少 8 个字符').optional(),
  headers: providerHeadersSchema.optional(),
  monthlyAllowanceUsd: providerAllowanceSchema.optional(),
  enabled: z.boolean().default(true),
});

/**
 * Input accepted by `updateProvider`. Every field is optional; `apiKey: ''`
 * means "leave the stored key alone", while a non-empty value replaces it.
 */
export const updateProviderInputSchema = z.object({
  name: providerNameSchema.optional(),
  kind: providerKindSchema.optional(),
  baseUrl: providerBaseUrlSchema.optional(),
  apiKey: z.union([z.literal(''), z.string().trim().min(8, 'API Key 至少 8 个字符')]).optional(),
  headers: providerHeadersSchema.optional(),
  monthlyAllowanceUsd: providerAllowanceSchema.optional(),
  enabled: z.boolean().optional(),
});

export type CreateProviderInput = z.input<typeof createProviderInputSchema>;

export type UpdateProviderInput = z.input<typeof updateProviderInputSchema>;
