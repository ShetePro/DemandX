'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getChain, saveChains } from '@/lib/llm/chain-repository';
import { loadCatalog, searchCatalog, type CatalogSnapshot } from '@/lib/llm/catalog';
import { testProviderConnection, type ConnectionTestResult } from '@/lib/llm/connection';
import {
  addModel,
  addModelInputSchema,
  listAllModels,
  refreshModels,
} from '@/lib/llm/models-repository';
import type { ChainItem, Profile } from '@/lib/llm/port';
import {
  createProvider,
  createProviderWithModels,
  deleteProvider,
  listProviders,
  updateProvider,
} from '@/lib/llm/repository';
import {
  providerBaseUrlSchema,
  providerNameSchema,
  type ProviderModelRow,
  type ProviderRow,
  type ProviderUsageSummary,
  type Result,
} from '@/lib/llm/types';
import { getProviderUsage } from '@/lib/llm/usage-repository';

import {
  PAYG_ISSUE_CODE,
  chainsInputSchema,
  isPaygBaseUrl,
  providerFormSchema,
  providerUpdateFormSchema,
} from './schema';

const SETTINGS_PATH = '/settings/llm';

const providerIdSchema = z
  .number()
  .int('provider id 必须是整数')
  .positive('provider id 必须为正数');

const catalogQuerySchema = z.object({
  q: z.string().trim().max(120, '搜索词过长').default(''),
  group: z.enum(['all', 'domestic', 'overseas', 'local']).default('all'),
});

const catalogSelectionSchema = z.object({
  catalogId: z.string().trim().min(1, 'catalogId 不能为空').max(120, 'catalogId 过长'),
  /** Optional: local daemons need no key, and keys can be added later. */
  apiKey: z.string().trim().max(500, 'API Key 过长').optional(),
  name: providerNameSchema.optional(),
  baseUrl: providerBaseUrlSchema.optional(),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Every action parses before it executes, and every failure leaves as data. The
 * pay-as-you-go refusal is its own code so the page can point at the checkbox
 * instead of rendering a wall of zod paths.
 */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): Result<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return failureFromIssues(parsed.error);
}

function failureFromIssues(error: z.ZodError): Result<never> {
  const payg = error.issues.find(isPaygIssue);
  if (payg) return { ok: false, code: 'PAYG_NOT_ACKNOWLEDGED', message: payg.message };
  return { ok: false, code: 'VALIDATION_FAILED', message: formatIssues(error) };
}

/** Real runtime narrowing: only custom issues carry `params`. */
function isPaygIssue(issue: z.ZodError['issues'][number]): boolean {
  return 'params' in issue && issue.params?.code === PAYG_ISSUE_CODE;
}

/** Strip the form-only field; the repository re-parses what is left. */
function withoutPaygAcknowledgement(value: Record<string, unknown>): Record<string, unknown> {
  const input = { ...value };
  delete input.acknowledgePayg;
  return input;
}

export async function listProvidersAction(): Promise<Result<ProviderRow[]>> {
  return listProviders();
}

/**
 * Search the directory (models.dev) for the "add provider" dialog. A failed
 * fetch is not an execution failure: `loadCatalog` answers with the built-in
 * presets and `source: 'fallback'`, which the dialog shows explicitly.
 */
export async function getCatalogAction(
  q?: unknown,
  group?: unknown,
): Promise<Result<CatalogSnapshot>> {
  const parsed = parse(catalogQuerySchema, { q, group });
  if (!parsed.ok) return parsed;

  try {
    const snapshot = await loadCatalog();
    return {
      ok: true,
      value: {
        ...snapshot,
        providers: searchCatalog(snapshot.providers, parsed.value.q, parsed.value.group),
      },
    };
  } catch {
    return { ok: false, code: 'LLM_UNAVAILABLE', message: '读取 models.dev 目录失败' };
  }
}

export type CatalogCreation = { provider: ProviderRow; modelCount: number };

/**
 * One directory selection becomes one provider plus its model list, written in
 * a single transaction. The key is optional; a local daemon or a keyless
 * endpoint stays usable and can be given a key later.
 */
export async function createFromCatalogAction(input: unknown): Promise<Result<CatalogCreation>> {
  const parsed = parse(catalogSelectionSchema, input);
  if (!parsed.ok) return parsed;

  const snapshot = await loadCatalog();
  const entry = snapshot.providers.find((provider) => provider.id === parsed.value.catalogId);
  if (entry === undefined) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `目录中没有 provider ${parsed.value.catalogId}，请刷新目录后重试`,
    };
  }

  const baseUrl = parsed.value.baseUrl ?? entry.baseUrl;
  // Catalog entries are curated, but a metered endpoint still needs the explicit
  // acknowledgement the manual form collects; never insert it silently.
  if (isPaygBaseUrl(baseUrl)) {
    return {
      ok: false,
      code: 'PAYG_NOT_ACKNOWLEDGED',
      message: '该端点是按量计费入口，请切换到“手动”并勾选确认后再保存。',
    };
  }

  const providerInput: Record<string, unknown> = {
    name: parsed.value.name ?? entry.name,
    kind: entry.kind,
    baseUrl,
    enabled: true,
  };
  if (parsed.value.apiKey !== undefined && parsed.value.apiKey !== '') {
    providerInput.apiKey = parsed.value.apiKey;
  }

  const result = await createProviderWithModels(
    providerInput,
    entry.models.map((model) => ({ modelId: model.id, displayName: model.name })),
  );
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}

export async function createProviderAction(raw: unknown): Promise<Result<ProviderRow>> {
  const parsed = parse(providerFormSchema, raw);
  if (!parsed.ok) return parsed;

  const result = await createProvider(withoutPaygAcknowledgement(parsed.value));
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}

export async function updateProviderAction(
  id: unknown,
  raw: unknown,
): Promise<Result<ProviderRow>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;

  const parsed = parse(providerUpdateFormSchema, raw);
  if (!parsed.ok) return parsed;

  const result = await updateProvider(parsedId.value, withoutPaygAcknowledgement(parsed.value));
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}

export async function deleteProviderAction(id: unknown): Promise<Result<void>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;

  const result = await deleteProvider(parsedId.value);
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}

/** Read-only probe: it must not revalidate, since nothing was written. */
export async function testProviderAction(id: unknown): Promise<ConnectionTestResult> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return { ...parsedId, status: 0 };

  return testProviderConnection(parsedId.value);
}

export async function saveChainsAction(raw: unknown): Promise<Result<void>> {
  const parsed = parse(chainsInputSchema, raw);
  if (!parsed.ok) return parsed;

  const result = await saveChains(parsed.value);
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}

export type ChainsForPage = Record<Profile, ChainItem[]>;

/** Both profiles in one round trip; a failure in either one fails the page data. */
export async function getChainsForPage(): Promise<Result<ChainsForPage>> {
  const [bulk, quality] = await Promise.all([getChain('bulk'), getChain('quality')]);
  if (!bulk.ok) return bulk;
  if (!quality.ok) return quality;
  return { ok: true, value: { bulk: bulk.value, quality: quality.value } };
}

export async function getModelsForPage(): Promise<Result<ProviderModelRow[]>> {
  return listAllModels();
}

export async function getUsageAction(): Promise<Result<ProviderUsageSummary[]>> {
  return getProviderUsage();
}

export async function refreshModelsAction(id: unknown): Promise<Result<ProviderModelRow[]>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;

  const result = await refreshModels(parsedId.value);
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}

export async function addModelAction(id: unknown, raw: unknown): Promise<Result<ProviderModelRow>> {
  const parsedId = parse(providerIdSchema, id);
  if (!parsedId.ok) return parsedId;

  const parsed = parse(addModelInputSchema, raw);
  if (!parsed.ok) return parsed;

  const result = await addModel(parsedId.value, parsed.value);
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}
