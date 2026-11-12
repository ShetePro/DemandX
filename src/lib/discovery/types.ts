import { z } from 'zod';

/** Signals a discovered opportunity can cite; same vocabulary as evidence. */
export const DISCOVERY_SIGNALS = [
  'problem',
  'seeking',
  'paying',
  'switching',
  'recurring',
] as const;

export const MONETIZATIONS = ['subscription', 'usage', 'one-time', 'service'] as const;

export const opportunitySchema = z.object({
  title: z.string().trim().min(1).max(60),
  /** The user's problem in their own words, not a feature list. */
  problem: z.string().trim().min(1).max(240),
  audience: z.string().trim().min(1).max(80),
  /** Which planned angle this idea answers; keeps a scan from collapsing into one theme. */
  angle: z.string().trim().min(1).max(40),
  signal: z.enum(DISCOVERY_SIGNALS),
  /** What people do today instead — proves the problem already costs something. */
  currentAlternative: z.string().trim().min(1).max(160),
  /** Named tools/services the snippets mention; empty when none are named. */
  competitors: z.array(z.string().trim().min(1).max(40)).max(3),
  monetization: z.enum(MONETIZATIONS),
  /** What a solo developer ships first; a platform play is not a valid answer. */
  mvp: z.string().trim().min(1).max(200),
  evidence: z
    .array(
      z.object({
        url: z.string().url(),
        quote: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(3),
});

export const discoverySchema = z.object({
  opportunities: z.array(opportunitySchema).min(1).max(8),
});

export type Opportunity = z.infer<typeof opportunitySchema>;

export interface DiscoverySource {
  url: string;
  title: string;
  snippet: string;
  platform: string;
}

/**
 * One query the scan will run, tagged with the angle that motivated it. The
 * planner returns these as structured output; the query is what reaches a
 * search port, the angle is what the UI and the memory use.
 */
export const plannedQuerySchema = z.object({
  query: z.string().trim().min(2).max(80),
  angle: z.string().trim().min(2).max(40),
  language: z.enum(['zh', 'en']),
});

export const discoveryPlanSchema = z.object({
  // A directed scan may legitimately use one angle; `normalizePlan` enforces
  // the 3–6 rule only when the model is free to choose.
  angles: z.array(z.string().trim().min(2).max(40)).min(1).max(6),
  queries: z.array(plannedQuerySchema).min(4).max(8),
  /** One sentence the UI shows: why these angles, this round. */
  rationale: z.string().trim().min(1).max(160),
});

export type PlannedQuery = z.infer<typeof plannedQuerySchema>;
export type DiscoveryPlan = z.infer<typeof discoveryPlanSchema> & {
  /**
   * `planned` = the model chose the angles, `directed` = the operator did,
   * `fallback` = neither happened and the static pool ran.
   */
  strategy: 'planned' | 'directed' | 'fallback';
  /** One sentence the UI shows: why these angles, this round. */
  rationale: string;
  /** Model that wrote the plan, absent when the static pool was used. */
  model?: string;
};

/** A recent public headline that the planner is allowed to react to. */
export interface TrendItem {
  title: string;
  url: string;
  snippet: string;
  points: number | null;
  platform: string;
  publishedAt?: string;
}

/** Historical scan state the planner and the novelty gate read before a scan. */
export interface ScanMemory {
  /** Newest first; the planner sees angle names, titles and queries. */
  scans: {
    angles: string[];
    queries: string[];
    opportunities: { title: string; problem: string; angle: string; fingerprint: string }[];
    createdAt: string;
  }[];
  /** Directions the operator actually started researching. */
  adopted: { title: string; angle: string | null }[];
  /** Source URLs from recent scans; the next scan must not reuse them. */
  excludedUrls: string[];
}

export interface DiscoveryResult {
  /** Row id of the persisted scan; `null` when the memory write failed. */
  scanId: number | null;
  /** Snippets actually shown to the model; the UI lists them as provenance. */
  sources: DiscoverySource[];
  opportunities: Opportunity[];
  /** Angles the scan was planned around. */
  angles: string[];
  /**
   * True when no idea could cite a paid/hiring signal; the ideas still ship,
   * flagged, because a grounded complaint is a lead the operator can judge.
   */
  commercialGap: boolean;
  /** Why this round looked different, from the planner. */
  rationale: string;
  /** `planned` (model), `directed` (operator), or `fallback` (static pool). */
  strategy: 'planned' | 'directed' | 'fallback';
  /** New-vs-excluded source URLs, so the UI can show how much is genuinely new. */
  novelty: { newUrls: number; total: number; ratio: number };
  /** How many historical URLs this scan filtered out before searching. */
  avoided: number;
  /** Queries actually executed, so a thin scan can be audited from the UI. */
  queries: string[];
  /** The shortened keyword each social platform actually searched. */
  socialQueries: { platform: string; query: string }[];
  /** Providers that answered at least one query, for the UI's status line. */
  providers: string[];
  /** Wall-clock time of the whole scan, search included. */
  elapsedMs: number;
  /** Model that wrote the analysis, so a slow scan can be explained later. */
  model: string;
}
