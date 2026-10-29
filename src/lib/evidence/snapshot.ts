import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const DEFAULT_DIR = './data/snapshots';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CACHE_LIMIT = 50;
const MS_PER_DAY = 86_400_000;

export type SnapshotErrorCode = 'SNAPSHOT_MISSING';

/** Failure from the snapshot store. `code` is stable, the message is not. */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

export interface SnapshotInput {
  /** Cleaned page text — the snapshot's identity and the quote-search corpus. */
  text: string;
  /** Raw HTML, stored alongside when available. */
  html?: string;
  /** Source URL, recorded by callers; the hash is content-addressed by text. */
  url: string;
  /** Overrides `SNAPSHOT_DIR`, which itself defaults to `./data/snapshots`. */
  dir?: string;
}

export interface SnapshotWriteResult {
  /** SHA-256 of `text`, hex. */
  hash: string;
  /** Absolute path to the gzipped text. */
  textPath: string;
  /** Absolute path to the gzipped HTML, or `null` when no HTML was given. */
  htmlPath: string | null;
  /** Compressed size of the text snapshot in bytes. */
  bytes: number;
}

/**
 * Decoded text keyed by absolute path. Bounded and insertion-ordered: reads
 * re-insert to keep recently used entries at the tail, writes evict the head.
 */
const textCache = new Map<string, string>();

function resolveDir(dir?: string): string {
  const configured = dir?.trim() || process.env.SNAPSHOT_DIR?.trim() || DEFAULT_DIR;
  return path.resolve(configured);
}

function remember(pathname: string, text: string): void {
  textCache.delete(pathname);
  textCache.set(pathname, text);
  while (textCache.size > CACHE_LIMIT) {
    const oldest = textCache.keys().next();
    if (oldest.done) break;
    textCache.delete(oldest.value);
  }
}

/**
 * Write a gzip file, skipping the write when the content-addressed target
 * already exists. Returns the stored size either way, so a retry is cheap and
 * idempotent.
 */
async function writeGzip(target: string, contents: string): Promise<number> {
  await mkdir(path.dirname(target), { recursive: true });
  const compressed = gzipSync(Buffer.from(contents, 'utf8'));
  try {
    await writeFile(target, compressed, { flag: 'wx' });
    return compressed.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // A previously interrupted write can leave a truncated file in a
    // content-addressed slot; verify it before trusting the stored bytes.
    const existing = await readFile(target);
    try {
      if (gunzipSync(existing).equals(Buffer.from(contents, 'utf8'))) return existing.length;
    } catch {
      // Fall through: the slot is corrupt and gets rewritten below.
    }
    await writeFile(target, compressed, { flag: 'w' });
    return compressed.length;
  }
}

/**
 * Persist a page snapshot under `<dir>/<hash[0:2]>/<hash>.txt.gz` (plus
 * `.html.gz`). Content-addressed, so re-fetching unchanged content is a no-op
 * and returns the same paths.
 */
export async function writeSnapshot(input: SnapshotInput): Promise<SnapshotWriteResult> {
  const { html, text } = input;
  const dir = resolveDir(input.dir);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const shard = path.join(dir, hash.slice(0, 2));
  const textPath = path.join(shard, `${hash}.txt.gz`);
  const bytes = await writeGzip(textPath, text);

  if (html === undefined) return { hash, textPath, htmlPath: null, bytes };

  const htmlPath = path.join(shard, `${hash}.html.gz`);
  await writeGzip(htmlPath, html);
  return { hash, textPath, htmlPath, bytes };
}

/** Read the gzipped text back. Missing (or malformed) hashes throw `SNAPSHOT_MISSING`. */
export async function readSnapshotText(hash: string, dir?: string): Promise<string> {
  if (!HASH_PATTERN.test(hash)) {
    throw new SnapshotError('SNAPSHOT_MISSING', `快照不存在: ${hash}`);
  }

  const textPath = path.join(resolveDir(dir), hash.slice(0, 2), `${hash}.txt.gz`);
  const cached = textCache.get(textPath);
  if (cached !== undefined) {
    remember(textPath, cached);
    return cached;
  }

  let compressed: Buffer;
  try {
    compressed = await readFile(textPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SnapshotError('SNAPSHOT_MISSING', `快照不存在: ${hash}`);
    }
    throw error;
  }

  const text = gunzipSync(compressed).toString('utf8');
  remember(textPath, text);
  return text;
}

/**
 * Delete `.gz` snapshots whose mtime is older than `olderThanDays`. Empty
 * shard directories are left in place — removing them races with concurrent
 * writes and buys nothing.
 *
 * @returns how many files were deleted.
 */
export async function pruneSnapshots(olderThanDays = 90, dir?: string): Promise<number> {
  const root = resolveDir(dir);
  const cutoff = Date.now() - olderThanDays * MS_PER_DAY;
  let removed = 0;

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.gz')) continue;

      let info;
      try {
        info = await stat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      if (info.mtimeMs >= cutoff) continue;
      try {
        await unlink(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      textCache.delete(target);
      removed += 1;
    }
  }

  await walk(root);
  return removed;
}
