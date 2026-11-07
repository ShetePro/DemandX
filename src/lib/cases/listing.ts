import { collapse, decodeEntities } from './parse';

/**
 * Reader for Starter Story's public idea database (`/data`). One listing page
 * renders the same 25 businesses twice: a compact "rows" view (title, one-line
 * summary, domain, revenue) and a rich "cards" view (plus solo score, model,
 * growth, customers, tools). Both are merged here, because every field except
 * the rich ones is also available for rows the cards view does not render.
 *
 * The page's counter says "Showing 100 of 3,745 ideas", but the server sends
 * 25 rows; the rest arrive through infinite scroll, which anonymous visitors do
 * not get. That is why the ingestion walks filter partitions instead of pages.
 */

export type RevenueSource = 'reported' | 'estimated';

export interface ListingIdea {
  slug: string;
  title: string;
  summary: string | null;
  domain: string | null;
  revenueMonth: number | null;
  revenueSource: RevenueSource | null;
  soloScore: number | null;
  models: string[];
  growth: string[];
  customers: string[];
  tools: string[];
  facts: string[];
}

export interface ListingPage {
  /** The "of N ideas" figure; null when the page is the paywall landing. */
  total: number | null;
  ideas: ListingIdea[];
  /** Business-model filters discovered on this page (`/data?business_model=…`). */
  models: { id: string; name: string }[];
}

const SECTION_LABELS = ['Revenue', 'Solo score', 'Model', 'Growth', 'Customers', 'Tools'] as const;

const MULTIPLIER: Readonly<Record<string, number>> = {
  '': 1,
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

/** `$30K` / `$1.2M` / `$650` → USD. */
export function parseMoney(text: string): number | null {
  const match = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB])?/i.exec(text);
  if (match?.[1] === undefined) return null;

  const value = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * (MULTIPLIER[(match[2] ?? '').toUpperCase()] ?? 1) * 100) / 100;
}

function tagLabels(block: string): string[] {
  const labels: string[] = [];
  for (const match of block.matchAll(/db-tag-label">([^<]+)</g)) {
    const label = collapse(decodeEntities(match[1] ?? ''));
    if (label !== '' && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** One labelled block (`Model`, `Growth`, …) up to the next section label. */
function section(block: string, label: (typeof SECTION_LABELS)[number]): string {
  const start = block.indexOf(`>${label}</div>`);
  if (start < 0) return '';

  let end = block.length;
  for (const other of SECTION_LABELS) {
    if (other === label) continue;
    const index = block.indexOf(`>${other}</div>`, start + label.length + 8);
    if (index >= 0 && index < end) end = index;
  }
  return block.slice(start, end);
}

function revenueOf(block: string): {
  month: number | null;
  source: RevenueSource | null;
} {
  const match = /db-rev is-(estimated|reported)[\s\S]{0,400}?db-rev-fig">\s*([^<]+?)\s*<small/.exec(
    block,
  );
  if (match === null) return { month: null, source: null };

  const source = match[1] === 'reported' ? 'reported' : 'estimated';
  return { month: parseMoney(match[2] ?? ''), source };
}

interface Fields {
  summary: string | null;
  domain: string | null;
  title: string;
}

function identity(block: string): Fields {
  const title =
    /font-semibold text-slate-900 truncate">([^<]+)</.exec(block)?.[1] ??
    /font-bold[^"]*">([^<]+)</.exec(block)?.[1];
  const summary =
    /text-slate-500 truncate leading-snug">([^<]+)</.exec(block)?.[1] ??
    /<p class="text-sm text-slate-500[^"]*">([^<]*)</.exec(block)?.[1];
  const domain = /class="font-mono[^"]*"[^>]*>([^<]+)</.exec(block)?.[1];

  return {
    title: collapse(decodeEntities(title ?? '')),
    summary: summary === undefined ? null : collapse(decodeEntities(summary)),
    domain: domain === undefined ? null : collapse(decodeEntities(domain)),
  };
}

/**
 * Both views are parsed and merged by slug: rows carry every business on the
 * page, cards carry the fields rows omit for the first 25.
 */
export function parseListingPage(html: string): ListingPage {
  const ideas = new Map<string, ListingIdea>();

  for (const match of html.matchAll(
    /<a class="nostylelink flex items-center[^"]*"[^>]*href="\/businesses\/([a-z0-9-]+)"[\s\S]*?<\/a>/g,
  )) {
    const slug = match[1] ?? '';
    const block = match[0];
    const fields = identity(block);
    if (slug === '' || fields.title === '') continue;

    const revenue = revenueOf(block);
    ideas.set(slug, {
      slug,
      title: fields.title,
      summary: fields.summary,
      domain: fields.domain,
      revenueMonth: revenue.month,
      revenueSource: revenue.source,
      soloScore: null,
      models: [],
      growth: [],
      customers: [],
      tools: [],
      facts: [],
    });
  }

  for (const block of html
    .split('<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">')
    .slice(1)) {
    const slug = /href="\/businesses\/([a-z0-9-]+)"/.exec(block)?.[1] ?? '';
    const fields = identity(block);
    if (slug === '' || fields.title === '') continue;

    const revenue = revenueOf(block);
    const score = />Solo score<\/div>[\s\S]{0,200}?<span class="tabular-nums">(\d+)<\/span>/.exec(
      block,
    )?.[1];
    const tools = [...block.matchAll(/class="db-tool" title="([^"]*)"/g)].map((entry) =>
      collapse(decodeEntities(entry[1] ?? '')),
    );

    const known = ideas.get(slug);
    ideas.set(slug, {
      slug,
      title: fields.title || known?.title || '',
      summary: fields.summary ?? known?.summary ?? null,
      domain: fields.domain ?? known?.domain ?? null,
      revenueMonth: revenue.month ?? known?.revenueMonth ?? null,
      revenueSource: revenue.source ?? known?.revenueSource ?? null,
      soloScore: score === undefined ? (known?.soloScore ?? null) : Number.parseInt(score, 10),
      models: tagLabels(section(block, 'Model')),
      growth: tagLabels(section(block, 'Growth')),
      customers: tagLabels(section(block, 'Customers')),
      tools: tools.filter((tool) => tool !== ''),
      facts: [...block.matchAll(/db-facts whitespace-normal">([\s\S]*?)<\/div>/g)]
        .flatMap((entry) => [...(entry[1] ?? '').matchAll(/<span>([^<]+)<\/span>/g)])
        .map((span) => collapse(decodeEntities(span[1] ?? '')))
        .filter((fact) => fact !== ''),
    });
  }

  const totalMatch = /Showing [\d,]+ of ([\d,]+) ideas/.exec(html);
  const models: { id: string; name: string }[] = [];
  for (const match of html.matchAll(
    /href="\/data\?business_model=(\d+)"[\s\S]{0,300}?db-tag-label">([^<]+)</g,
  )) {
    const id = match[1] ?? '';
    const name = collapse(decodeEntities(match[2] ?? ''));
    if (id !== '' && name !== '' && !models.some((entry) => entry.id === id)) {
      models.push({ id, name });
    }
  }

  return {
    total:
      totalMatch?.[1] === undefined ? null : Number.parseInt(totalMatch[1].replace(/,/g, ''), 10),
    ideas: [...ideas.values()],
    models,
  };
}
