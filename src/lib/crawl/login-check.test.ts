import { describe, expect, it } from 'vitest';

import { detectLogin, type LoginContextLike } from './login-check';

function context(cookies: string[]): LoginContextLike & { closed: boolean } {
  const state = {
    closed: false,
    async cookies() {
      return cookies.map((name) => ({ name, value: 'secret' }));
    },
    async close() {
      state.closed = true;
    },
  };
  return state;
}

describe('detectLogin', () => {
  it('reports a logged-in session from an auth cookie name', async () => {
    const ctx = context(['web_session', 'a1']);
    const result = await detectLogin('/tmp/profile', 'xiaohongshu', async () => ctx);

    expect(result).toMatchObject({
      platform: 'xiaohongshu',
      state: 'logged-in',
      found: ['web_session'],
    });
    expect(result.found.join()).not.toContain('secret');
    expect(ctx.closed).toBe(true);
  });

  it('reports logged-out when the auth cookie is absent', async () => {
    const result = await detectLogin('/tmp/profile', 'zhihu', async () => context(['a1']));
    expect(result).toMatchObject({ state: 'logged-out', found: [] });
  });

  it('treats an unopenable profile as unknown, not logged out', async () => {
    const result = await detectLogin('/tmp/profile', 'twitter', async () => {
      throw new Error('profile is in use');
    });
    expect(result.state).toBe('unknown');
    expect(result.message).toContain('profile is in use');
  });

  it('refuses a platform without a cookie rule', async () => {
    const result = await detectLogin('/tmp/profile', 'example', async () => context([]));
    expect(result.state).toBe('unknown');
  });
});
