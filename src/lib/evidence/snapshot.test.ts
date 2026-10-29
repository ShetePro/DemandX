import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pruneSnapshots, readSnapshotText, SnapshotError, writeSnapshot } from './snapshot';

const URL = 'https://example.com/posts/1';
const DAY_MS = 86_400_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'demandx-snapshot-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('writeSnapshot / readSnapshotText', () => {
  it('writes a gzipped text snapshot and reads it back', async () => {
    const text = '第一段用户原话：太贵了。\n第二段：想要更便宜的替代品。';

    const result = await writeSnapshot({ text, url: URL, dir });

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.textPath).toBe(path.join(dir, result.hash.slice(0, 2), `${result.hash}.txt.gz`));
    expect(path.isAbsolute(result.textPath)).toBe(true);
    expect(result.htmlPath).toBeNull();
    expect(existsSync(result.textPath)).toBe(true);
    expect(result.bytes).toBe(statSync(result.textPath).size);
    await expect(readSnapshotText(result.hash, dir)).resolves.toBe(text);
  });

  it('is idempotent: same content yields one file and the same paths', async () => {
    const text = '同样的内容不应产生第二份快照。';

    const first = await writeSnapshot({ text, url: URL, dir });
    const second = await writeSnapshot({ text, url: URL, dir });

    expect(second).toEqual(first);
    expect(readdirSync(path.dirname(first.textPath))).toEqual([`${first.hash}.txt.gz`]);
  });

  it('stores optional html next to the text and decompresses to the original', async () => {
    const html = '<html><body><p>hello</p></body></html>';
    const text = 'hello';

    const result = await writeSnapshot({ text, html, url: URL, dir });
    const htmlPath = result.htmlPath;
    if (htmlPath === null) throw new Error('expected htmlPath');

    expect(htmlPath).toBe(path.join(dir, result.hash.slice(0, 2), `${result.hash}.html.gz`));
    expect(existsSync(htmlPath)).toBe(true);
    expect(gunzipSync(readFileSync(htmlPath)).toString('utf8')).toBe(html);
    expect(gunzipSync(readFileSync(result.textPath)).toString('utf8')).toBe(text);
  });

  it('actually compresses the text', async () => {
    const text = '重复的用户抱怨内容。'.repeat(500);

    const result = await writeSnapshot({ text, url: URL, dir });
    const raw = readFileSync(result.textPath);

    expect(gunzipSync(raw).toString('utf8')).toBe(text);
    expect(raw.length).toBeLessThan(Buffer.byteLength(text, 'utf8'));
    expect(result.bytes).toBe(raw.length);
  });

  it('falls back to SNAPSHOT_DIR when no dir is passed', async () => {
    vi.stubEnv('SNAPSHOT_DIR', dir);

    const result = await writeSnapshot({ text: 'env dir', url: URL });

    expect(result.textPath.startsWith(`${dir}${path.sep}`)).toBe(true);
    await expect(readSnapshotText(result.hash)).resolves.toBe('env dir');
  });

  it('serves repeated reads from the LRU instead of re-reading the file', async () => {
    const result = await writeSnapshot({ text: '原始内容', url: URL, dir });
    await expect(readSnapshotText(result.hash, dir)).resolves.toBe('原始内容');

    writeFileSync(result.textPath, gzipSync(Buffer.from('外部改写', 'utf8')));

    await expect(readSnapshotText(result.hash, dir)).resolves.toBe('原始内容');
  });

  it('throws SNAPSHOT_MISSING for absent and malformed hashes', async () => {
    const missing = 'a'.repeat(64);

    await expect(readSnapshotText(missing, dir)).rejects.toBeInstanceOf(SnapshotError);
    await expect(readSnapshotText(missing, dir)).rejects.toMatchObject({
      name: 'SnapshotError',
      code: 'SNAPSHOT_MISSING',
    });
    await expect(readSnapshotText('not-a-hash', dir)).rejects.toMatchObject({
      code: 'SNAPSHOT_MISSING',
    });
  });
});

describe('pruneSnapshots', () => {
  it('deletes only snapshots older than the threshold and keeps their directories', async () => {
    const oldRoot = path.join(dir, 'old');
    const old = await writeSnapshot({ text: 'old snapshot', url: URL, dir: oldRoot });
    const fresh = await writeSnapshot({ text: 'fresh snapshot', url: URL, dir });
    const ancient = new Date(Date.now() - 120 * DAY_MS);
    utimesSync(old.textPath, ancient, ancient);

    await expect(pruneSnapshots(90, dir)).resolves.toBe(1);

    expect(existsSync(old.textPath)).toBe(false);
    expect(existsSync(path.dirname(old.textPath))).toBe(true);
    expect(existsSync(fresh.textPath)).toBe(true);
  });

  it('returns zero for a missing directory', async () => {
    await expect(pruneSnapshots(90, path.join(dir, 'absent'))).resolves.toBe(0);
  });
});
