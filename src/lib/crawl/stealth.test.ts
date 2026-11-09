import { describe, expect, it, vi } from 'vitest';

import { applyStealth, domDigest, humanizeSocialPage, STEALTH_INIT_SCRIPT } from './stealth';

describe('stealth', () => {
  it('hides the navigator.webdriver flag before page scripts run', () => {
    expect(STEALTH_INIT_SCRIPT).toContain("navigator, 'webdriver'");
    expect(STEALTH_INIT_SCRIPT).toContain('zh-CN');
  });

  it('installs the init script on the context, tolerating an unsupported context', async () => {
    const addInitScript = vi.fn(async () => ({ dispose: () => undefined }));
    await applyStealth({ addInitScript });
    expect(addInitScript).toHaveBeenCalledWith(STEALTH_INIT_SCRIPT);

    await expect(applyStealth({})).resolves.toBeUndefined();
    await expect(
      applyStealth({
        addInitScript: async () => {
          throw new Error('locked down');
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('reads post-like DOM nodes into a digest', async () => {
    const page = {
      evaluate: async <T,>() => '第一条帖子正文\n\n第二条帖子正文' as T,
    };
    expect(await domDigest(page)).toContain('第一条帖子正文');
  });

  it('does nothing when the fake page has no evaluate', async () => {
    await expect(humanizeSocialPage({})).resolves.toBeUndefined();
    expect(await domDigest({})).toBe('');
  });
});
