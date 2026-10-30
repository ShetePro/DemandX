import { detectChallenge } from './challenge';
import { isTimeoutError } from './error';
import { extractReadable } from './extract';
import type { CrawlPort, CrawlResult } from './port';

/** A hung result page must not stall the pipeline. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 5 MB covers long forum threads; anything bigger is a download, not a page. */
const DEFAULT_MAX_BYTES = 5_000_000;

const HTML_MIME: Readonly<Record<string, true>> = {
  'text/html': true,
  'application/xhtml+xml': true,
};

export interface StaticCrawlerOptions {
  /** Injected in tests; production uses the global fetch (Node 22). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Read at most `maxBytes` and return `null` when the body exceeds it, so an
 * endless stream cannot exhaust memory. Byte counting happens on the wire
 * chunks, not on the decoded string.
 */
async function readBody(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) return null;

  const body = response.body;
  if (body === null || typeof body.getReader !== 'function') {
    // A `fetch` double in tests may expose only `text()`.
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/**
 * Tier 1: one plain GET, no browser. Content is kept only when readability
 * finds quotable prose, and a challenge page short-circuits to `needs_human`
 * before extraction — a login wall often returns 200 with a readable shell.
 */
export function createStaticCrawler(options: StaticCrawlerOptions = {}): CrawlPort {
  const send = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async crawl(url: string): Promise<CrawlResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let response: Response;
        try {
          response = await send(url, { redirect: 'follow', signal: controller.signal });
        } catch (error) {
          const timedOut = controller.signal.aborted || isTimeoutError(error);
          return { status: 'error', code: timedOut ? 'TIMEOUT' : 'HTTP_ERROR', url };
        }

        if (!response.ok) return { status: 'error', code: 'HTTP_ERROR', url };

        const mime =
          (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (HTML_MIME[mime] !== true) return { status: 'error', code: 'NOT_HTML', url };

        const html = await readBody(response, maxBytes);
        if (html === null) return { status: 'error', code: 'TOO_LARGE', url };

        const finalUrl = response.url === '' ? url : response.url;
        const challenge = detectChallenge(html, finalUrl);
        if (challenge !== null) return { status: 'needs_human', reason: challenge, url: finalUrl };

        const article = extractReadable(html, finalUrl);
        if (article === null) return { status: 'error', code: 'NOT_HTML', url: finalUrl };

        return {
          status: 'ok',
          snapshot: { url: finalUrl, html, text: article.text, title: article.title },
        };
      } catch {
        // Stream errors and malformed responses land here; the URL is retryable.
        return { status: 'error', code: 'HTTP_ERROR', url };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
