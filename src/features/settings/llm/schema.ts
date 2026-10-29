import { z } from 'zod';

import { createProviderInputSchema, updateProviderInputSchema } from '@/lib/llm/types';

/**
 * Metered endpoints: every call spends real balance. `opencode.ai/inference`
 * (without `/go`) is the pay-as-you-go entry; the `/go` prefix is the flat
 * subscription and must not be caught by this guard.
 */
export const PAYG_HOSTS: readonly string[] = ['opencode.ai/inference'];

/** Carried on the zod issue so the action can return this code instead of a generic parse error. */
export const PAYG_ISSUE_CODE = 'PAYG_NOT_ACKNOWLEDGED';

export const PAYG_CONFIRMATION_MESSAGE =
  '该端点是按量计费入口，每次调用都会真实扣费。请先勾选“我知道这是按量计费”，再保存该 provider。';

/** Host + path, so `…/inference` matches while `…/inference/go` does not. */
export function isPaygBaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `host` is already lower-cased and port-less for the default schemes.
  const target = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  return PAYG_HOSTS.includes(target);
}

function paygIssue(baseUrl: string, acknowledged: boolean, ctx: z.RefinementCtx): void {
  if (!isPaygBaseUrl(baseUrl) || acknowledged) return;
  ctx.addIssue({
    code: 'custom',
    path: ['acknowledgePayg'],
    message: PAYG_CONFIRMATION_MESSAGE,
    params: { code: PAYG_ISSUE_CODE },
  });
}

/**
 * The provider form is the only way into `createProvider`, so the pay-as-you-go
 * confirmation is enforced here rather than in the page.
 */
export const providerFormSchema = createProviderInputSchema
  .extend({ acknowledgePayg: z.boolean().default(false) })
  .superRefine((value, ctx) => paygIssue(value.baseUrl, value.acknowledgePayg, ctx));

/**
 * Updates may keep the stored base URL, so they are only checked when the
 * caller actually provides one.
 */
export const providerUpdateFormSchema = updateProviderInputSchema
  .extend({ acknowledgePayg: z.boolean().default(false) })
  .superRefine((value, ctx) => {
    if (value.baseUrl === undefined) return;
    paygIssue(value.baseUrl, value.acknowledgePayg, ctx);
  });

export const chainEntrySchema = z.object({
  providerId: z.number().int('providerId 必须是整数').positive('providerId 必须为正数'),
  modelId: z.string().trim().min(1, 'modelId 不能为空'),
});

function profileChain(profile: string) {
  return z.array(chainEntrySchema).min(1, `${profile} 链不能为空，请至少选择一个模型`);
}

/**
 * Both chains are replaced as a whole, so an empty profile is a mistake, not a
 * request to clear one. Unknown keys are rejected: a typo like `quality2` would
 * otherwise be silently dropped and the save would look successful.
 */
export const chainsInputSchema = z
  .strictObject({
    bulk: profileChain('bulk'),
    quality: profileChain('quality'),
  })
  .superRefine((value, ctx) => {
    for (const profile of ['bulk', 'quality'] as const) {
      const seen = new Set<string>();
      value[profile].forEach((entry, index) => {
        const key = `${entry.providerId}:${entry.modelId}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [profile, index],
            message: `${profile} 链第 ${index + 1} 项重复：provider ${entry.providerId} 的模型 ${entry.modelId} 已在前方出现`,
          });
        }
        seen.add(key);
      });
    }
  });
