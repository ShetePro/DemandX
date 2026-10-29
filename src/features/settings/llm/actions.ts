'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { saveChains } from '@/lib/llm/chain-repository';
import { testProviderConnection, type ConnectionTestResult } from '@/lib/llm/connection';
import {
  createProvider,
  deleteProvider,
  listProviders,
  updateProvider,
} from '@/lib/llm/repository';
import type { ProviderRow, Result } from '@/lib/llm/types';

import {
  PAYG_ISSUE_CODE,
  chainsInputSchema,
  providerFormSchema,
  providerUpdateFormSchema,
} from './schema';

const SETTINGS_PATH = '/settings/llm';

const providerIdSchema = z
  .number()
  .int('provider id 必须是整数')
  .positive('provider id 必须为正数');

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
