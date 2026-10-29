import { describe, expect, it } from 'vitest';

import {
  PAYG_ISSUE_CODE,
  chainsInputSchema,
  isPaygBaseUrl,
  providerFormSchema,
  providerUpdateFormSchema,
} from './schema';

const PROVIDER = {
  name: 'OpenCode Go',
  kind: 'openai-compatible' as const,
  baseUrl: 'https://opencode.ai/inference/go',
  apiKey: 'sk-test-1234567890',
};

const CHAIN_ITEM = { providerId: 1, modelId: 'gpt-4o-mini' };

describe('isPaygBaseUrl', () => {
  it('treats the bare inference host as pay-as-you-go', () => {
    expect(isPaygBaseUrl('https://opencode.ai/inference')).toBe(true);
    expect(isPaygBaseUrl('https://opencode.ai/inference/')).toBe(true);
  });

  it('leaves the /go subscription endpoint alone', () => {
    expect(isPaygBaseUrl('https://opencode.ai/inference/go')).toBe(false);
  });

  it('ignores unrelated endpoints and malformed URLs', () => {
    expect(isPaygBaseUrl('https://api.example.com')).toBe(false);
    expect(isPaygBaseUrl('not a url')).toBe(false);
  });
});

describe('providerFormSchema pay-as-you-go guard', () => {
  it('rejects a metered base URL without an explicit acknowledgement', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://opencode.ai/inference',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues.some((issue) => issue.message.includes('按量计费'))).toBe(true);
    expect(
      result.error.issues.some(
        (issue) => 'params' in issue && issue.params?.code === PAYG_ISSUE_CODE,
      ),
    ).toBe(true);
  });

  it('accepts the same endpoint once the operator ticks the box', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://opencode.ai/inference',
      acknowledgePayg: true,
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.baseUrl).toBe('https://opencode.ai/inference');
  });

  it('does not ask for confirmation on an ordinary endpoint', () => {
    const result = providerFormSchema.safeParse({
      ...PROVIDER,
      baseUrl: 'https://api.example.com/v1',
    });

    expect(result.success).toBe(true);
    // The form-only flag defaults to false and never blocks a normal save.
    if (result.success) expect(result.data.acknowledgePayg).toBe(false);
  });

  it('still validates the rest of the provider form', () => {
    const result = providerFormSchema.safeParse({ ...PROVIDER, name: '' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('name'))).toBe(true);
    }
  });
});

describe('providerUpdateFormSchema pay-as-you-go guard', () => {
  it('rejects switching an existing provider to the metered endpoint', () => {
    const result = providerUpdateFormSchema.safeParse({
      baseUrl: 'https://opencode.ai/inference',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('按量计费'))).toBe(true);
    }
  });

  it('does not ask for confirmation when the update omits the base URL', () => {
    expect(providerUpdateFormSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});

describe('chainsInputSchema', () => {
  it('accepts two non-empty chains', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [CHAIN_ITEM],
      quality: [CHAIN_ITEM, { providerId: 2, modelId: 'claude-sonnet' }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty chain', () => {
    const result = chainsInputSchema.safeParse({ bulk: [], quality: [CHAIN_ITEM] });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) => candidate.path[0] === 'bulk');
      expect(issue?.message).toContain('bulk 链不能为空');
    }
  });

  it('rejects a duplicated entry inside one chain', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [CHAIN_ITEM, { ...CHAIN_ITEM }],
      quality: [CHAIN_ITEM],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('重复'))).toBe(true);
    }
  });

  it('rejects an unknown profile instead of silently dropping it', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [CHAIN_ITEM],
      quality: [CHAIN_ITEM],
      draft: [CHAIN_ITEM],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed entry', () => {
    const result = chainsInputSchema.safeParse({
      bulk: [{ providerId: 0, modelId: '  ' }],
      quality: [CHAIN_ITEM],
    });

    expect(result.success).toBe(false);
  });
});
