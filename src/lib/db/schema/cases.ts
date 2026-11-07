import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * One public startup case study, shared by every run. The table is a library
 * of precedent, not evidence for any single investigation: a run that cites a
 * case still has to materialize its own `sources`/`evidence` rows.
 *
 * `snapshot_hash` points at the content-addressed page text (see
 * `src/lib/evidence/snapshot.ts`), so a quote can be checked against what the
 * page actually said on `fetched_at`.
 *
 * `source_kind`: `story` is a founder interview, `business` is Starter Story's
 * own AI-compiled profile and therefore a lower evidence grade.
 */
export const caseStudies = pgTable(
  'case_studies',
  {
    id: serial('id').primaryKey(),
    url: text('url').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    sourceKind: text('source_kind').notNull().default('story'),
    /** Human category once S2 builds it; the deterministic import leaves it null. */
    category: text('category'),
    businessModel: text('business_model'),
    /** Normalized to USD per month; `revenue_note` keeps the page's wording. */
    revenueMonth: numeric('revenue_month', { precision: 14, scale: 2 }),
    revenueNote: text('revenue_note'),
    foundedYear: integer('founded_year'),
    summary: text('summary'),
    snapshotHash: text('snapshot_hash').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    /** Structured extraction (wedge, pricing, channel, limits); null until S2. */
    extraction: jsonb('extraction'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('case_studies_url_key').on(t.url),
    index('case_studies_slug_idx').on(t.slug),
    index('case_studies_revenue_idx').on(t.revenueMonth),
  ],
);

/**
 * One row of the public "idea database" listing (`/data`). The listing is the
 * broadest index of real businesses with a sourced monthly revenue, and it is
 * deliberately separate from `case_studies`: a listing row is a summary that
 * may have no story behind it yet, so it has no page snapshot and must not be
 * cited as a quote.
 *
 * Columns that only the business profile page knows (as-of date, country,
 * pricing, team, funding) stay in `enrichment` until a later pass fills typed
 * columns once their query patterns exist.
 */
export const caseIdeas = pgTable(
  'case_ideas',
  {
    id: serial('id').primaryKey(),
    /** `/businesses/<slug>` on Starter Story; unique across the listing. */
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    domain: text('domain'),
    /** USD per month, as displayed; `revenue_source` says who measured it. */
    revenueMonth: numeric('revenue_month', { precision: 14, scale: 2 }),
    /** `reported` = founder-reported, `estimated` = the site's research agent. */
    revenueSource: text('revenue_source'),
    /** Starter Story's own 0–100 score, kept as theirs, not as our rubric. */
    soloScore: integer('solo_score'),
    models: text('models').array().notNull().default([]),
    growth: text('growth').array().notNull().default([]),
    customers: text('customers').array().notNull().default([]),
    tools: text('tools').array().notNull().default([]),
    facts: text('facts').array().notNull().default([]),
    sourceUrl: text('source_url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    /** Business-profile fields (as_of, country, pricing, team, story URL…). */
    enrichment: jsonb('enrichment'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('case_ideas_slug_key').on(t.slug),
    index('case_ideas_revenue_idx').on(t.revenueMonth),
  ],
);
