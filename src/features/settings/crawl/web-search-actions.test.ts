import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/settings/store', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock('@/lib/crypto/secret', () => ({
  loadSecretBox: () => ({
    encrypt: (plain: string) => `enc:${plain}`,
    decrypt: (payload: string) => payload.replace(/^enc:/, ''),
    mask: (plain: string) => `${plain.slice(0, 3)}…${plain.slice(-2)}`,
  }),
}));

import {
  clearWebSearchKeyAction,
  getWebSearchSettingsAction,
  saveWebSearchSettingsAction,
} from './web-search-actions';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  mocks.getSetting.mockReset();
  mocks.setSetting.mockReset();
  mocks.getSetting.mockResolvedValue({ ok: true, value: null });
  mocks.setSetting.mockResolvedValue({ ok: true, value: { updatedAt: new Date() } });
  delete process.env.WEB_SEARCH_API_KEY;
  delete process.env.WEB_SEARCH_PROVIDER;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('saveWebSearchSettingsAction', () => {
  it('rejects enabling without a stored or env key', async () => {
    const result = await saveWebSearchSettingsAction({
      enabled: true,
      provider: 'tavily',
      maxResults: 5,
    });

    expect(result.ok).toBe(false);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('encrypts a new key and never stores it in plain text', async () => {
    const result = await saveWebSearchSettingsAction({
      enabled: true,
      provider: 'brave',
      maxResults: 4,
      apiKey: 'sk-secret-1234',
    });

    expect(result).toEqual({
      ok: true,
      value: { settings: { enabled: true, provider: 'brave', maxResults: 4 }, keyHint: 'sk-…34' },
    });

    const [key, stored] = mocks.setSetting.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toBe('web-search');
    expect(stored).toMatchObject({
      enabled: true,
      provider: 'brave',
      maxResults: 4,
      apiKeyCt: 'enc:sk-secret-1234',
      apiKeyHint: 'sk-…34',
    });
    expect(stored).not.toHaveProperty('apiKey');
  });

  it('keeps the existing key when the field is left empty', async () => {
    mocks.getSetting.mockResolvedValue({
      ok: true,
      value: {
        enabled: false,
        provider: 'tavily',
        maxResults: 5,
        apiKeyCt: 'enc:old-key',
        apiKeyHint: 'old…ey',
      },
    });

    const result = await saveWebSearchSettingsAction({
      enabled: true,
      provider: 'tavily',
      maxResults: 5,
    });

    expect(result.ok).toBe(true);
    const stored = mocks.setSetting.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(stored['apiKeyCt']).toBe('enc:old-key');
  });

  it('reports invalid maxResults', async () => {
    const result = await saveWebSearchSettingsAction({
      enabled: false,
      provider: 'tavily',
      maxResults: 50,
    });
    expect(result.ok).toBe(false);
  });
});

describe('getWebSearchSettingsAction', () => {
  it('reports a stored key as configured', async () => {
    mocks.getSetting.mockResolvedValue({
      ok: true,
      value: {
        enabled: true,
        provider: 'tavily',
        maxResults: 5,
        apiKeyCt: 'enc:k',
        apiKeyHint: 'k…k',
      },
    });

    const result = await getWebSearchSettingsAction();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.keyHint).toBe('k…k');
      expect(result.value.configured).toBe(true);
    }
  });

  it('reports env configuration without a settings row', async () => {
    process.env.WEB_SEARCH_API_KEY = 'env-key';
    process.env.WEB_SEARCH_PROVIDER = 'serper';

    const result = await getWebSearchSettingsAction();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.configured).toBe(true);
  });
});

describe('clearWebSearchKeyAction', () => {
  it('disables the fallback and drops the encrypted key', async () => {
    mocks.getSetting.mockResolvedValue({
      ok: true,
      value: {
        enabled: true,
        provider: 'tavily',
        maxResults: 5,
        apiKeyCt: 'enc:k',
        apiKeyHint: 'k…k',
      },
    });

    const result = await clearWebSearchKeyAction();

    expect(result.ok).toBe(true);
    const stored = mocks.setSetting.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(stored['enabled']).toBe(false);
    expect(stored).not.toHaveProperty('apiKeyCt');
    expect(stored).not.toHaveProperty('apiKeyHint');
  });
});
