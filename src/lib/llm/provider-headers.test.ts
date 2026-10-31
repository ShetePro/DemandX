import { describe, expect, it } from 'vitest';

import { isOpencodeBaseUrl, isOpencodeFreeModel, withProviderHeaders } from './provider-headers';

describe('withProviderHeaders', () => {
  it('adds a stable session header for OpenCode endpoints', () => {
    const first = withProviderHeaders('https://opencode.ai/inference/go', {}, 'OpenCode Go');
    const second = withProviderHeaders('https://opencode.ai/inference/go', {}, 'OpenCode Go');

    expect(first['x-opencode-session']).toMatch(/^demandx-[0-9a-f]{12}$/);
    expect(second['x-opencode-session']).toBe(first['x-opencode-session']);
  });

  it('never overwrites an explicitly configured session, in any casing', () => {
    expect(
      withProviderHeaders('https://opencode.ai/inference/go', {
        'x-opencode-session': 'mine',
      })['x-opencode-session'],
    ).toBe('mine');

    expect(
      withProviderHeaders('https://opencode.ai/inference/go', {
        'X-OpenCode-Session': 'mine',
      }),
    ).toEqual({ 'X-OpenCode-Session': 'mine' });
  });

  it('does not mutate the stored header object', () => {
    const headers = { 'x-org': 'acme' };
    withProviderHeaders('https://opencode.ai/inference/go', headers);

    expect(headers).toEqual({ 'x-org': 'acme' });
  });

  it('leaves other hosts untouched', () => {
    expect(withProviderHeaders('https://api.example.com/v1', {})).toEqual({});
    expect(withProviderHeaders('http://127.0.0.1:11434', {})).toEqual({});
    expect(withProviderHeaders('not a url', {})).toEqual({});
  });
});

describe('isOpencodeFreeModel', () => {
  it('only applies the suffix rule on OpenCode hosts', () => {
    expect(isOpencodeFreeModel('https://opencode.ai/inference/go', 'glm-5.3-flash-free')).toBe(
      true,
    );
    expect(isOpencodeFreeModel('https://opencode.ai/inference/go', 'glm-5.3-flash')).toBe(false);
    expect(isOpencodeFreeModel('https://api.example.com/v1', 'some-model-free')).toBe(false);
    expect(isOpencodeBaseUrl('https://opencode.ai/inference/go')).toBe(true);
    expect(isOpencodeBaseUrl('https://api.example.com/v1')).toBe(false);
  });
});
