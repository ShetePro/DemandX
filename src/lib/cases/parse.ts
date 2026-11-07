/**
 * Deterministic reader for a Starter Story case page. Only fields that the
 * page states literally are parsed here; anything that needs judgement
 * (category, model, wedge, transferable lesson) belongs to the later LLM
 * extraction step and stays `null` for now.
 *
 * The revenue label is the site's own metadata block (`$316K revenue/mo`), so
 * the parser prefers it over a title match: a title can say `$3.8M/Year` while
 * the metadata says `$316K revenue/mo`, and the monthly figure is what a
 * benchmark can compare.
 */

export interface ParsedCase {
  slug: string;
  title: string;
  /** Normalized USD per month, or `null` when the page states no revenue. */
  revenueMonth: number | null;
  /** The page's own wording, e.g. `$316K revenue/mo`. */
  revenueNote: string | null;
  foundedYear: number | null;
  summary: string | null;
  founders: number | null;
  employees: number | null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The site renders revenue and founding year in a metadata block that
 * readability deliberately drops (it is not article prose), so the structural
 * fields are read from a flattened copy of the raw HTML instead. Scripts and
 * styles are removed first: their inline JSON contains unrelated dollar
 * figures that would otherwise win the "first match" rule.
 */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return collapse(decodeEntities(stripped));
}

/** `<meta name="description">` is the founder's intro, not a summary we author. */
function metaDescription(html: string | undefined): string | null {
  if (html === undefined) return null;

  const match = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html);
  if (match?.[1] === undefined) return null;

  const text = collapse(decodeEntities(match[1]));
  return text === '' ? null : text;
}

const MONTHS = '(?:mo|month|months)';
const YEARS = '(?:yr|year|years|annum)';

/**
 * `<amount> revenue/mo` beats every other dollar figure on the page: it is the
 * site's own label, and it sits in the metadata block rather than in body
 * prose that may quote a price or a tool's cost.
 */
const LABELED_REVENUE = new RegExp(
  `\\$\\s?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*([KMB])?\\s+revenue\\s*\\/\\s*(${MONTHS}|${YEARS})\\b`,
  'i',
);

/** Title form: `$400K/Month`, `$3.8M/Year`. */
const PERIOD_REVENUE = new RegExp(
  `\\$\\s?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*([KMB])?\\s*\\/\\s*(${MONTHS}|${YEARS})\\b`,
  'i',
);

const MULTIPLIER: Readonly<Record<string, number>> = {
  '': 1,
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

/** Reads a dollar amount plus its unit into USD per month. */
function toMonthly(amount: string, suffix: string | undefined, period: string): number | null {
  const value = Number.parseFloat(amount.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;

  const scaled = value * (MULTIPLIER[suffix?.toUpperCase() ?? ''] ?? 1);
  const monthly = period.toLowerCase().startsWith('mo') ? scaled : scaled / 12;
  return Math.round(monthly * 100) / 100;
}

export function parseRevenue(text: string): { month: number; note: string } | null {
  // The label may sit anywhere in the metadata block; the title fallback is
  // limited to the headline so a body sentence about a `$19/mo` tool cannot be
  // read as this business's revenue.
  for (const [source, pattern] of [
    [text, LABELED_REVENUE],
    [text.slice(0, 200), PERIOD_REVENUE],
  ] as const) {
    const match = pattern.exec(source);
    if (match === null) continue;
    const month = toMonthly(match[1] ?? '', match[2], match[3] ?? 'mo');
    if (month === null) continue;
    return { month, note: collapse(match[0]) };
  }
  return null;
}

export function parseFoundedYear(text: string): number | null {
  const match = /\bstarted\s+[A-Z][a-z]+\s+(\d{4})\b/.exec(text);
  if (match?.[1] === undefined) return null;
  const year = Number.parseInt(match[1], 10);
  return year >= 1950 && year <= 2100 ? year : null;
}

export function parseCasePage(input: {
  url: string;
  title: string;
  text: string;
  html?: string;
}): ParsedCase {
  // Metadata block first (it carries the site's own revenue label), then the
  // article text as a fallback for pages that render it inside the body.
  const structural =
    input.html === undefined ? input.text : `${htmlToText(input.html)}\n${input.text}`;
  const revenue = parseRevenue(structural) ?? parseRevenue(input.title);
  const founderCount = /\b(\d{1,6})\s+Founders?\b/i.exec(structural);
  const employeeCount = /\b(\d{1,6})\s+Employees?\b/i.exec(structural);

  const pathname = (() => {
    try {
      return new URL(input.url).pathname;
    } catch {
      return input.url;
    }
  })();
  const segments = pathname.split('/').filter(Boolean);

  const title = collapse(decodeEntities(input.title))
    .replace(/\s*[-–|·]\s*Starter Story.*$/i, '')
    .trim();

  return {
    slug: segments[segments.length - 1] ?? '',
    title: title || input.text.split('\n')[0]?.trim() || input.url,
    revenueMonth: revenue?.month ?? null,
    revenueNote: revenue?.note ?? null,
    foundedYear: parseFoundedYear(structural),
    summary: metaDescription(input.html),
    founders: founderCount?.[1] === undefined ? null : Number.parseInt(founderCount[1], 10),
    employees: employeeCount?.[1] === undefined ? null : Number.parseInt(employeeCount[1], 10),
  };
}
