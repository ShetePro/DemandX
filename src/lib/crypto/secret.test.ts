import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSecretBox, resolveSecretPath, SecretError } from './secret';

const PLAIN = 'sk-live-1234567890';

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'demandx-secret-'));
  keyPath = path.join(dir, 'secret.key');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Run `fn` and return the `SecretError.code` it throws, or `undefined`. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof SecretError) return error.code;
    throw error;
  }
}

/** Replace the first character of a base64url segment without changing its length. */
function tamperSegment(segment: string): string {
  return (segment.startsWith('A') ? 'B' : 'A') + segment.slice(1);
}

function tamper(payload: string, index: 1 | 2 | 3): string {
  const parts = payload.split(':');
  const segment = parts[index] ?? '';
  parts[index] = tamperSegment(segment);
  return parts.join(':');
}

describe('loadSecretBox', () => {
  it('round-trips a key and never embeds the plaintext', () => {
    const box = loadSecretBox(keyPath);
    const ciphertext = box.encrypt(PLAIN);

    expect(ciphertext).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(ciphertext.split(':')).toHaveLength(4);
    expect(ciphertext).not.toContain(PLAIN);
    expect(ciphertext).not.toContain('sk-live');
    expect(box.decrypt(ciphertext)).toBe(PLAIN);
    expect(box.decrypt(box.encrypt(''))).toBe('');
  });

  it('uses a fresh IV for every encryption', () => {
    const box = loadSecretBox(keyPath);
    const first = box.encrypt(PLAIN);
    const second = box.encrypt(PLAIN);

    expect(first).not.toBe(second);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
    expect(box.decrypt(first)).toBe(PLAIN);
    expect(box.decrypt(second)).toBe(PLAIN);
  });

  it('masks keys without leaking more than the prefix and suffix', () => {
    const box = loadSecretBox(keyPath);

    expect(box.mask(PLAIN)).toBe('sk-…7890');
    expect(box.mask('abc')).toBe('••••');
    expect(box.mask('')).toBe('••••');
    expect(box.mask('12345678')).toBe('••••');
    expect(box.mask('123456789')).toBe('123…6789');
  });

  it('creates the key file with 0600 in a 0700 directory', () => {
    const nestedDir = path.join(dir, 'nested');
    const nestedKey = path.join(nestedDir, 'secret.key');
    const box = loadSecretBox(nestedKey);

    expect(statSync(nestedKey).mode & 0o777).toBe(0o600);
    expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(nestedKey)).toHaveLength(32);
    expect(box.decrypt(box.encrypt(PLAIN))).toBe(PLAIN);
  });

  it('tightens an existing key file that is world-readable', () => {
    writeFileSync(keyPath, Buffer.alloc(32, 7));
    chmodSync(keyPath, 0o644);
    expect(statSync(keyPath).mode & 0o777).toBe(0o644);

    const box = loadSecretBox(keyPath);

    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(box.decrypt(box.encrypt(PLAIN))).toBe(PLAIN);
  });

  it('leaves a stricter owner-only mode untouched', () => {
    writeFileSync(keyPath, Buffer.alloc(32, 7));
    chmodSync(keyPath, 0o400);

    const box = loadSecretBox(keyPath);

    expect(statSync(keyPath).mode & 0o777).toBe(0o400);
    expect(box.decrypt(box.encrypt(PLAIN))).toBe(PLAIN);
  });

  it('reuses the persisted key across loads', () => {
    const writer = loadSecretBox(keyPath);
    const ciphertext = writer.encrypt(PLAIN);
    const reader = loadSecretBox(keyPath);

    expect(reader.decrypt(ciphertext)).toBe(PLAIN);
  });

  it('re-reads the winner when another process creates the key first', () => {
    const winner = loadSecretBox(keyPath);
    const payload = winner.encrypt('race-winner');

    // The existence check misses the file, and our `wx` write loses to the
    // process that created it in the meantime.
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw errno('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw errno('EEXIST');
    });

    const loser = loadSecretBox(keyPath);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(loser.decrypt(payload)).toBe('race-winner');
  });

  it('rejects a key file that is not exactly 32 bytes', () => {
    for (const size of [0, 16, 31, 33]) {
      writeFileSync(keyPath, Buffer.alloc(size, 7));

      expect(codeOf(() => loadSecretBox(keyPath))).toBe('SECRET_KEY_INVALID');
    }
  });

  it('fails authentication when any segment is tampered with', () => {
    const box = loadSecretBox(keyPath);
    const payload = box.encrypt(PLAIN);

    for (const index of [1, 2, 3] as const) {
      const broken = tamper(payload, index);

      expect(codeOf(() => box.decrypt(broken))).toBe('SECRET_DECRYPT_FAILED');
    }
  });

  it('fails authentication when decrypted with a different key', () => {
    const first = loadSecretBox(path.join(dir, 'one.key'));
    const second = loadSecretBox(path.join(dir, 'two.key'));

    expect(codeOf(() => second.decrypt(first.encrypt(PLAIN)))).toBe('SECRET_DECRYPT_FAILED');
  });

  it('does not leak plaintext through error messages', () => {
    const box = loadSecretBox(keyPath);
    const payload = tamper(box.encrypt(PLAIN), 3);

    try {
      box.decrypt(payload);
      expect.unreachable('decrypt should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretError);
      expect((error as Error).message).not.toContain(PLAIN);
      expect((error as Error).message).not.toContain(payload);
    }
  });

  it('rejects malformed envelopes with SECRET_PAYLOAD_INVALID', () => {
    const box = loadSecretBox(keyPath);
    const payload = box.encrypt(PLAIN);
    const [, iv, tag, ciphertext] = payload.split(':');

    const malformed = [
      `v2:${iv}:${tag}:${ciphertext}`,
      'v1:only-two-parts',
      `v1:${iv}:${tag}:${ciphertext}:extra`,
      `v1:${iv}:${tag}:not base64!`,
      `v1::${tag}:${ciphertext}`,
    ];

    for (const broken of malformed) {
      expect(codeOf(() => box.decrypt(broken))).toBe('SECRET_PAYLOAD_INVALID');
    }
  });
});

describe('resolveSecretPath', () => {
  it('expands a leading ~ to the home directory', () => {
    const resolved = resolveSecretPath('~/x.key');

    expect(resolved).toBe(path.join(os.homedir(), 'x.key'));
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('defaults to ~/.demandx/secret.key', () => {
    vi.stubEnv('DEMANDX_SECRET_FILE', '');

    expect(resolveSecretPath()).toBe(path.join(os.homedir(), '.demandx', 'secret.key'));
  });

  it('honours DEMANDX_SECRET_FILE and expands its ~', () => {
    vi.stubEnv('DEMANDX_SECRET_FILE', '~/alt/secret.key');

    expect(resolveSecretPath()).toBe(path.join(os.homedir(), 'alt', 'secret.key'));
  });

  it('loads the key from DEMANDX_SECRET_FILE when no path is passed', () => {
    vi.stubEnv('DEMANDX_SECRET_FILE', keyPath);

    const box = loadSecretBox();

    expect(existsSync(keyPath)).toBe(true);
    expect(box.decrypt(box.encrypt(PLAIN))).toBe(PLAIN);
  });

  it('resolves relative paths against the working directory', () => {
    expect(resolveSecretPath('relative.key')).toBe(path.resolve('relative.key'));
  });
});
