import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

/** Below this many characters the "article" is boilerplate, not evidence. */
export const MIN_ARTICLE_LENGTH = 80;

export interface ReadableArticle {
  title: string;
  /** Paragraph-separated body text; quotes are taken from here verbatim. */
  text: string;
}

/**
 * Removed before readability runs: they carry no quotable prose and their
 * contents would otherwise leak into `textContent` scoring.
 */
const NOISE_SELECTOR = 'script, style, noscript, template, iframe, canvas, svg';

/** Block-level tags end a paragraph, so readability output keeps paragraphs. */
const BLOCK_TAGS: Readonly<Record<string, true>> = {
  ADDRESS: true,
  ARTICLE: true,
  ASIDE: true,
  BLOCKQUOTE: true,
  DD: true,
  DIV: true,
  DL: true,
  DT: true,
  FIELDSET: true,
  FIGCAPTION: true,
  FIGURE: true,
  FOOTER: true,
  FORM: true,
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
  HEADER: true,
  HR: true,
  LI: true,
  MAIN: true,
  NAV: true,
  OL: true,
  P: true,
  PRE: true,
  SECTION: true,
  TABLE: true,
  TBODY: true,
  TD: true,
  TFOOT: true,
  TH: true,
  THEAD: true,
  TR: true,
  UL: true,
};

/** Tags whose text never belongs in an article body. */
const SKIP_TAGS: Readonly<Record<string, true>> = {
  CANVAS: true,
  IFRAME: true,
  NOSCRIPT: true,
  SCRIPT: true,
  STYLE: true,
  SVG: true,
  TEMPLATE: true,
};

/**
 * Parse with the page URL so relative links and `baseURI` resolve; malformed
 * URLs fall back to a bare document instead of failing the whole crawl.
 */
function parseDocument(html: string, url: string): Document | null {
  try {
    const dom = new JSDOM(html, { url });
    return dom.window.document as Document;
  } catch {
    try {
      return new JSDOM(html).window.document as Document;
    } catch {
      return null;
    }
  }
}

/**
 * Walk the article body and emit one normalised line per block element.
 * Whitespace inside a line collapses to single spaces; empty lines drop out.
 */
function toParagraphText(root: Element): string {
  const lines: string[] = [];
  let buffer = '';

  const flush = (): void => {
    const line = buffer.replace(/\s+/g, ' ').trim();
    if (line !== '') lines.push(line);
    buffer = '';
  };

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      buffer += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as Element;
    if (SKIP_TAGS[element.tagName] === true) return;
    if (element.tagName === 'BR') {
      flush();
      return;
    }

    const block = BLOCK_TAGS[element.tagName] === true;
    if (block) flush();
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block) flush();
  };

  walk(root);
  flush();
  return lines.join('\n');
}

/**
 * Readability + jsdom: keeps the article body, drops navigation, ads and
 * scripts. Returns `null` when nothing quotable survives — a JS shell, a
 * consent wall, or a page whose "article" is a single caption.
 */
export function extractReadable(html: string, url: string): ReadableArticle | null {
  if (html.trim() === '') return null;

  const document = parseDocument(html, url);
  if (document === null) return null;

  for (const node of Array.from(document.querySelectorAll(NOISE_SELECTOR))) node.remove();

  const article = new Readability(document).parse();
  if (article === null) return null;

  // `article.content` is the cleaned body; re-mount it to keep paragraphs.
  const container = document.createElement('div');
  container.innerHTML = article.content ?? '';
  const text = toParagraphText(container);
  if (text.length < MIN_ARTICLE_LENGTH) return null;

  const title = (article.title ?? document.title).replace(/\s+/g, ' ').trim();
  return { title, text };
}
