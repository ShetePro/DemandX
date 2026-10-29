import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const PAYLOAD_VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_FILE_MODE = 0o600;
const KEY_DIR_MODE = 0o700;
const DEFAULT_SECRET_FILE = '~/.demandx/secret.key';
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export type SecretErrorCode =
  'SECRET_KEY_INVALID' | 'SECRET_PAYLOAD_INVALID' | 'SECRET_DECRYPT_FAILED';

/**
 * Failure from the local key box. Messages are deliberately generic: they
 * never contain a plaintext key, a ciphertext, or key material.
 */
export class SecretError extends Error {
  readonly code: SecretErrorCode;

  constructor(code: SecretErrorCode, message: string) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

/** Encrypts API keys for at-rest storage and renders their display mask. */
export interface SecretBox {
  /** Returns `v1:<iv>:<tag>:<ciphertext>` with base64url segments. */
  encrypt(plain: string): string;
  /** @throws {SecretError} `SECRET_PAYLOAD_INVALID` or `SECRET_DECRYPT_FAILED`. */
  decrypt(payload: string): string;
  /** `••••` for short values, otherwise `abc…wxyz`. */
  mask(plain: string): string;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Resolve the key file location. Order: explicit argument, then
 * `DEMANDX_SECRET_FILE`, then `~/.demandx/secret.key`. A leading `~` is
 * expanded with `os.homedir()` — Node never expands it on its own — and the
 * result is always absolute.
 */
export function resolveSecretPath(raw?: string): string {
  const configured = raw?.trim() || process.env.DEMANDX_SECRET_FILE?.trim() || DEFAULT_SECRET_FILE;
  return path.resolve(expandHome(configured));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function invalidPayload(): SecretError {
  return new SecretError('SECRET_PAYLOAD_INVALID', '密文格式无效');
}

function decodeSegment(segment: string): Buffer {
  if (!BASE64URL.test(segment)) throw invalidPayload();
  return Buffer.from(segment, 'base64url');
}

function maskSecret(plain: string): string {
  if (plain.length <= 8) return '••••';
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
}

/**
 * Read an existing key file, tightening permissions to 0600 if needed.
 *
 * @throws {SecretError} `SECRET_KEY_INVALID` when the file is not exactly 32 bytes.
 */
function readKeyFile(filePath: string): Buffer {
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o777) !== KEY_FILE_MODE) fs.chmodSync(filePath, KEY_FILE_MODE);

  const key = fs.readFileSync(filePath);
  if (key.length !== KEY_BYTES) {
    throw new SecretError('SECRET_KEY_INVALID', '密钥文件无效：必须恰好包含 32 字节密钥');
  }
  return key;
}

/**
 * Load the 32-byte key at `filePath`, creating it on first use.
 *
 * Creation uses `flag: 'wx'` so two processes starting at once cannot
 * overwrite each other: the loser re-reads the winner's file. The file is
 * forced to 0600 (the `mode` option is filtered through the process umask)
 * inside a 0700 directory.
 */
function loadOrCreateKey(filePath: string): Buffer {
  try {
    return readKeyFile(filePath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: KEY_DIR_MODE });

  const key = randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(filePath, key, { flag: 'wx', mode: KEY_FILE_MODE });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
    return readKeyFile(filePath);
  }

  fs.chmodSync(filePath, KEY_FILE_MODE);
  return key;
}

function encryptWithKey(key: Buffer, plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PAYLOAD_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function decryptWithKey(key: Buffer, payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) throw invalidPayload();

  const ivSegment = parts[1] ?? '';
  const tagSegment = parts[2] ?? '';
  const ciphertextSegment = parts[3] ?? '';
  if (!ivSegment || !tagSegment) throw invalidPayload();

  const iv = decodeSegment(ivSegment);
  const tag = decodeSegment(tagSegment);
  const ciphertext = decodeSegment(ciphertextSegment);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretError('SECRET_DECRYPT_FAILED', '密文解密失败：内容被篡改或密钥不匹配');
  }
}

/** Load (or create) the local AES-256-GCM key and bind it into a box. */
export function loadSecretBox(filePath?: string): SecretBox {
  const key = loadOrCreateKey(resolveSecretPath(filePath));

  return {
    encrypt: (plain) => encryptWithKey(key, plain),
    decrypt: (payload) => decryptWithKey(key, payload),
    mask: maskSecret,
  };
}
