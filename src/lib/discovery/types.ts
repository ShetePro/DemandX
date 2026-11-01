import { z } from 'zod';

/** Signals a discovered opportunity can cite; same vocabulary as evidence. */
export const DISCOVERY_SIGNALS = [
  'problem',
  'seeking',
  'paying',
  'switching',
  'recurring',
] as const;

export const opportunitySchema = z.object({
  title: z.string().trim().min(1).max(60),
  /** The user's problem in their own words, not a feature list. */
  problem: z.string().trim().min(1).max(240),
  audience: z.string().trim().min(1).max(80),
  signal: z.enum(DISCOVERY_SIGNALS),
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
  opportunities: z.array(opportunitySchema).min(1).max(5),
});

export type Opportunity = z.infer<typeof opportunitySchema>;

export interface DiscoverySource {
  url: string;
  title: string;
  snippet: string;
  platform: string;
}

export interface DiscoveryResult {
  /** Snippets actually shown to the model; the UI lists them as provenance. */
  sources: DiscoverySource[];
  opportunities: Opportunity[];
  /** Providers that answered at least one query, for the UI's status line. */
  providers: string[];
  /** Wall-clock time of the whole scan, search included. */
  elapsedMs: number;
  /** Model that wrote the analysis, so a slow scan can be explained later. */
  model: string;
}
